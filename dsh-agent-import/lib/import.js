/**
 * Importing one foreign session into DSH.
 *
 * The importer writes a cold V4 artifact through the Host `sessionPersistence`
 * service — the same seam the agent lifecycle uses — so the backend performs all
 * physical encoding and the resulting session is a native DSH session. That is
 * what makes the session continuable: opening it later resumes it with
 * `agents.resume`, which cold-reads the artifact and seeds the agent with this
 * history, and the next turn appends to the same file.
 *
 * After writing, the artifact is read back through the same persistence service:
 * the cold read runs the full V4 validation, so a session that cannot be opened
 * later is detected now rather than at the first resume.
 */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';

import { assertEventStream, buildEvents, timeOf } from './events.js';
import { recordImport, findImport, forgetImport } from './ledger.js';
import { directoryExists } from './paths.js';
import { sourceById } from './sources/index.js';

/** Resolve one required Host service, with a message that names what is missing. */
export function requireService(ctx, name) {
  const service = typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  if (service === undefined || service === null) {
    throw new Error(`the Host does not publish "${name}"; the import cannot run in this composition`);
  }
  return service;
}

/**
 * Deterministic DSH session id of one foreign session.
 *
 * Determinism is the idempotency mechanism: importing the same foreign session
 * twice targets the same id, and the store refuses the second create instead of
 * duplicating history.
 */
export function sessionIdFor(source, foreignId) {
  const digest = createHash('sha256').update(`${source}\u0000${foreignId}`, 'utf8').digest('hex');
  const hex = digest.slice(0, 32);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return `session-${uuid}`;
}

/** Whether a thrown error means "that session id is already stored". */
function isAlreadyExists(error) {
  const text = `${String(error?.name ?? '')} ${String(error?.message ?? '')}`;
  return /already[ _-]?exists|SessionAlreadyExists/iu.test(text);
}

/** Resolve the local directory an imported session belongs to. */
async function resolveImportCwd(ctx, foreignCwd) {
  const candidate = typeof foreignCwd === 'string' ? foreignCwd.trim() : '';
  if (candidate !== '') {
    try {
      const resolved = await realpath(candidate);
      if (await directoryExists(resolved)) return { cwd: resolved, mapped: false };
    } catch {
      /* the origin project path does not exist on this machine */
    }
  }
  const workingDirectory = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined;
  let fallback;
  for (const probe of ['defaultDirectory', 'get']) {
    try {
      const value = workingDirectory?.[probe]?.();
      const awaited = value !== null && typeof value === 'object' && typeof value.then === 'function' ? await value : value;
      if (typeof awaited === 'string' && awaited !== '') {
        fallback = awaited;
        break;
      }
    } catch {
      /* try the next probe */
    }
  }
  if (fallback === undefined) fallback = process.cwd();
  const resolved = await realpath(fallback).catch(() => fallback);
  return { cwd: resolved, mapped: true };
}

/** Attach the imported session to the DSH workspace of its project directory. */
async function attachToWorkspace(ctx, header, title) {
  const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
  if (registry === undefined || registry === null) return { attached: false, reason: 'workspaceRegistry is unavailable' };
  const settle = async (value) => (value !== null && typeof value === 'object' && typeof value.then === 'function' ? await value : value);
  // A workspace names a project, so a workspace created here carries the project
  // directory name; the imported session keeps its own name inside it.
  const projectTitle = basename(header.cwd) || title;
  let workspace;
  try {
    workspace = await settle(registry.resolveByPath?.(header.cwd));
  } catch {
    workspace = undefined;
  }
  if (workspace === undefined || workspace === null) {
    try {
      workspace = await settle(registry.create?.(header.cwd, projectTitle));
    } catch (error) {
      return { attached: false, reason: `workspace create failed: ${error?.message ?? String(error)}` };
    }
  }
  if (workspace === undefined || workspace === null || typeof workspace.attachSession !== 'function') {
    return { attached: false, reason: 'no workspace entity to attach the session to' };
  }
  try {
    await settle(workspace.attachSession(header.id));
    return { attached: true, workspacePath: typeof workspace.path === 'string' ? workspace.path : header.cwd };
  } catch (error) {
    return { attached: false, reason: `attachSession failed: ${error?.message ?? String(error)}` };
  }
}

/**
 * Write one normalized transcript into the session store as a native DSH session.
 *
 * @param ctx - the Host plugin context.
 * @param transcript - `{source, label, foreignId, title, cwd, createdAt, model, messages}`.
 * @param options - `{force}`; `force` re-imports over an existing ledger entry.
 * @returns a report: `{status, sessionId, title, cwd, ...counters, warnings}`.
 */
export async function importSession(ctx, transcript, options = {}) {
  const source = String(transcript?.source ?? '');
  const foreignId = String(transcript?.foreignId ?? '');
  if (source === '' || foreignId === '') throw new Error('an imported session needs its source and its foreign id');
  const label = String(transcript?.label ?? source);

  const sessionId = sessionIdFor(source, foreignId);
  const recorded = findImport(source, foreignId);
  if (recorded !== undefined && options.force !== true) {
    return {
      status: 'already-imported',
      sessionId: String(recorded.sessionId ?? sessionId),
      title: String(recorded.title ?? ''),
      cwd: String(recorded.cwd ?? ''),
      duplicateOf: String(recorded.sessionId ?? sessionId),
      warnings: [],
    };
  }

  const persistence = requireService(ctx, 'sessionPersistence');
  const { cwd, mapped } = await resolveImportCwd(ctx, transcript?.cwd);
  const createdAt = timeOf(transcript?.createdAt, Date.now());
  const header = {
    version: 4,
    id: sessionId,
    createdAt: Number.isSafeInteger(createdAt) && createdAt >= 0 ? createdAt : Date.now(),
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  };

  const built = buildEvents({ ...transcript, label }, header);
  assertEventStream(built.events);

  const warnings = Array.isArray(transcript?.notes) ? transcript.notes.map(String) : [];
  if (mapped) warnings.push(`origin project "${String(transcript?.cwd ?? '')}" does not exist on this machine; attached to ${cwd}`);
  if (built.droppedCalls > 0) warnings.push(`${built.droppedCalls} tool call(s) had no recorded result and were dropped`);
  if (built.droppedResults > 0) warnings.push(`${built.droppedResults} tool result(s) had no matching call and were dropped`);

  let handle;
  try {
    handle = await persistence.create(header, {});
  } catch (error) {
    if (isAlreadyExists(error)) {
      await recordImport({
        source,
        foreignId,
        sessionId,
        title: built.title,
        cwd,
        originalCwd: String(transcript?.cwd ?? ''),
        eventCount: built.events.length,
        verified: false,
        warnings,
      });
      return { status: 'already-imported', sessionId, title: built.title, cwd, duplicateOf: sessionId, warnings };
    }
    throw error;
  }

  try {
    await handle.append(built.events);
    await handle.flush();
  } finally {
    try {
      await handle.close();
    } catch {
      /* a close failure must not mask an append failure */
    }
  }

  // Read the artifact back through the same service: this is the cold read that
  // DSH itself performs before resuming, including the full V4 validation.
  let verified = false;
  let verifyError;
  try {
    const reader = await persistence.open(sessionId, 'read');
    try {
      await reader.read(0);
      verified = true;
    } finally {
      try {
        await reader.close();
      } catch {
        /* nothing to release */
      }
    }
  } catch (error) {
    verifyError = error?.message ?? String(error);
    warnings.push(`the imported artifact failed its read-back check: ${verifyError}`);
  }

  // Seed the projection cache so the session list shows the imported name and
  // activity time. Cold rows read only this cache, never the log.
  try {
    const cache = typeof ctx?.get === 'function' ? ctx.get('sessionProjectionCache') : undefined;
    if (cache !== undefined && cache !== null && typeof cache.coldSnapshot === 'function') {
      await cache.coldSnapshot(header, 0, built.events);
    } else {
      warnings.push('sessionProjectionCache is unavailable; the imported name may not show until the session is opened');
    }
  } catch (error) {
    warnings.push(`projection seeding failed: ${error?.message ?? String(error)}`);
  }

  const attachment = await attachToWorkspace(ctx, header, built.title);
  if (attachment.attached !== true) warnings.push(`workspace attach skipped: ${attachment.reason}`);

  const turnCount = built.events.filter((event) => event.type === 'turn/start').length;
  const sourceSignature = transcript?.sourceSignature ?? signatureOf(transcript?.messages ?? []);
  await recordImport({
    source,
    foreignId,
    sessionId,
    title: built.title,
    cwd,
    originalCwd: String(transcript?.cwd ?? ''),
    eventCount: built.events.length,
    turnCount,
    droppedCalls: built.droppedCalls,
    droppedResults: built.droppedResults,
    verified,
    warnings,
    foreignMessageCount: sourceSignature.count,
    foreignPrefixHash: sourceSignature.prefixHash,
  });

  return {
    status: verified ? 'imported' : 'imported-unverified',
    sessionId,
    title: built.title,
    cwd,
    workspacePath: attachment.workspacePath,
    eventCount: built.events.length,
    turnCount,
    droppedCalls: built.droppedCalls,
    droppedResults: built.droppedResults,
    verified,
    verifyError,
    warnings,
  };
}

/** How many spawned transcripts one import may fold into its parent. */
const MAX_SUBAGENT_APPENDIX = 50;

/** Messages kept from one spawned transcript, so one huge run cannot dominate. */
const MAX_CONTEXT_MESSAGES_PER_CHILD = 400;

/** Total appendix messages, the ceiling for one imported session. */
const MAX_CONTEXT_MESSAGES_TOTAL = 5000;

/** Marker that delimits an appended subagent transcript inside the parent log. */
function subagentMarker(context, index) {
  const title = String(context?.title ?? '').trim() || '(без имени)';
  const kind = String(context?.childKind ?? '').includes('workflow') ? 'workflow' : 'subagent';
  return (
    `[${kind} transcript ${index + 1}: ${title} · ${String(context?.foreignId ?? '')} — ` +
    'выполнялся внутри этой сессии, ниже его содержимое как контекст]'
  );
}

/** Give one child's tool calls ids of their own, so two children cannot collide. */
function remapCallIds(message, prefix) {
  if (message === null || typeof message !== 'object') return message;
  if (message.role === 'tool') return { ...message, callId: `${prefix}${String(message.callId ?? '')}` };
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((block) =>
      block !== null && typeof block === 'object' && block.type === 'tool-call' ? { ...block, id: `${prefix}${String(block.id ?? '')}` } : block,
    ),
  };
}

/** How many leading messages fingerprint a source transcript. */
const SIGNATURE_PREFIX = 5;

/**
 * Whether the stored log currently has an open turn or step.
 *
 * A finished session is not required to END with `turn/end`: DSH appends service
 * events (a title, a model selection, a command receipt) after the closing event,
 * so the tail is scanned for lifecycle markers instead of trusting the last row.
 *
 * @param events - the whole stored log.
 * @returns true when a turn or a step is still open, i.e. a run is in progress.
 */
export function hasOpenTurn(events) {
  let openTurn = null;
  let openStep = null;
  for (const event of Array.isArray(events) ? events : []) {
    switch (event?.type) {
      case 'turn/start':
        openTurn = event.data?.turn ?? 1;
        openStep = null;
        break;
      case 'turn/end':
        openTurn = null;
        openStep = null;
        break;
      case 'step/start':
        openStep = event.data?.step ?? 1;
        break;
      case 'step/end':
        openStep = null;
        break;
      default:
        break;
    }
  }
  return openTurn !== null || openStep !== null;
}

/**
 * Stable identity of the source transcript, used to detect a rewritten history.
 *
 * The hash is a pure function of the transcript's opening messages, so appending
 * to the origin never changes it while compacting or editing the opening does.
 *
 * @param messages - the source messages of one foreign session.
 * @returns `{count, prefixHash}`.
 */
export function signatureOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return {
    count: list.length,
    prefixHash: createHash('sha256')
      .update(JSON.stringify(list.slice(0, Math.min(SIGNATURE_PREFIX, list.length))), 'utf8')
      .digest('hex')
      .slice(0, 16),
  };
}

/**
 * Fold spawned (subagent) transcripts into a parent transcript as appendix turns.
 *
 * Each child becomes one extra turn whose opening user message is a marker, so
 * the parent's own dialogue stays byte-identical and a reader can tell where the
 * appendix starts. Tool call ids are prefixed per child because two spawned runs
 * may reuse a provider-local id, and a log pairs calls strictly by id.
 *
 * @param transcript - the parent transcript; its `messages` array is extended.
 * @param contexts - ready transcripts: `[{title, foreignId, childKind, messages}]`, oldest first.
 * @returns how many transcripts were folded in.
 */
export function withSubagentContext(transcript, contexts) {
  if (!Array.isArray(transcript?.messages) || !Array.isArray(contexts)) return 0;
  let appended = 0;
  let budget = MAX_CONTEXT_MESSAGES_TOTAL;
  for (const context of contexts.slice(0, MAX_SUBAGENT_APPENDIX)) {
    if (!Array.isArray(context?.messages) || context.messages.length === 0) continue;
    if (budget <= 0) break;
    const take = Math.min(context.messages.length, MAX_CONTEXT_MESSAGES_PER_CHILD, budget);
    const prefix = `sa${appended}-`;
    transcript.messages.push({ role: 'user', text: subagentMarker(context, appended) });
    for (const message of context.messages.slice(0, take)) transcript.messages.push(remapCallIds(message, prefix));
    budget -= take;
    appended += 1;
  }
  if (appended > 0) {
    const truncated = contexts.length > appended;
    transcript.notes = [
      ...(Array.isArray(transcript.notes) ? transcript.notes : []),
      `${appended} субагентных транскрипт(ов) добавлены контекстом в конец сессии${truncated ? ' (остальные не влезли в лимит)' : ''}`,
    ];
  }
  return appended;
}

/**
 * Read one foreign session through its adapter, then import it.
 *
 * With `includeSubagents`, the sessions spawned inside this one are folded into
 * the same log as clearly delimited appendix turns: the user keeps one session
 * per real conversation, and the model still sees what the spawned runs did.
 *
 * @param ctx - the Host plugin context.
 * @param ref - `{source, id, path?, title?, cwd?}`.
 * @param options - `{force, includeSubagents}`.
 */
export async function importForeign(ctx, ref, options = {}) {
  const source = String(ref?.source ?? '');
  const adapter = sourceById(source);
  if (adapter === undefined) throw new Error(`unknown source "${source}"; known sources: claude-code, codex, zcode-cli, zcode-v2, kilo, opencode`);
  const transcript = await adapter.readSession(ref);
  // The signature describes the SOURCE messages, so it is taken before any
  // appendix is folded in; an update compares against exactly this prefix.
  transcript.sourceSignature = signatureOf(transcript.messages);

  if (options.includeSubagents === true && typeof adapter.readContext === 'function') {
    let contexts = [];
    try {
      contexts = await adapter.readContext(ref);
    } catch {
      contexts = [];
    }
    withSubagentContext(transcript, contexts);
  }

  return await importSession(ctx, transcript, options);
}

/** Whether the stored copy still holds exactly the number of turns this importer wrote. */
function copyUntouched(events, entry) {
  const expected = Number.isSafeInteger(entry?.turnCount) ? entry.turnCount : 0;
  const actual = Array.isArray(events) ? events.filter((event) => event?.type === 'turn/start').length : 0;
  return expected > 0 && actual === expected;
}

/**
 * Rebuild an imported copy from its source under a NEW session id.
 *
 * Nothing is deleted: the previous copy stays stored and is archived, and the
 * ledger is repointed to the fresh copy. A rebuild is therefore safe even when it
 * fails — the copy the user already has is never at risk.
 *
 * @param ctx - the Host plugin context.
 * @param ref - `{source, id, path?, includeSubagents?}`.
 * @returns `{status, sessionId, previousSessionId, archived, rebuilt, warnings}`.
 */
export async function reimportImported(ctx, ref) {
  const source = String(ref?.source ?? '');
  const adapter = sourceById(source);
  if (adapter === undefined) throw new Error(`unknown source "${source}"; known sources: claude-code, codex, zcode-cli, zcode-v2, kilo, opencode`);
  const foreignId = String(ref?.id ?? '');
  if (foreignId === '') throw new Error('reimport needs a foreign session id');
  const entry = findImport(source, foreignId);
  const previousSessionId = String(entry?.sessionId ?? sessionIdFor(source, foreignId));

  const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined;
  const live = typeof sessions?.get === 'function' ? sessions.get(previousSessionId) : undefined;
  if (live !== undefined && live !== null) {
    return { status: 'busy', sessionId: previousSessionId, rebuilt: false, warnings: ['сессия открыта в приложении; закройте её и повторите переимпорт'] };
  }

  // Read the source first: an unreadable origin must not cost the existing copy.
  const transcript = await adapter.readSession(ref);
  const sourceSignature = signatureOf(transcript.messages);
  transcript.sourceSignature = sourceSignature;
  // A brand-new identity, so the store has never handed out this id and the
  // existing copy is left exactly as it is.
  transcript.foreignId = `${foreignId}#reimport-${Date.now()}`;
  if (ref?.includeSubagents === true && typeof adapter.readContext === 'function') {
    let contexts = [];
    try {
      contexts = await adapter.readContext(ref);
    } catch {
      contexts = [];
    }
    withSubagentContext(transcript, contexts);
  }

  const report = await importSession(ctx, transcript, {});
  if (report.status !== 'imported' && report.status !== 'imported-unverified') {
    // importSession records even a refused attempt; put the original mapping back.
    if (entry !== undefined) {
      await recordImport({ ...entry, source, foreignId }).catch(() => {});
    }
    return {
      status: 'failed',
      sessionId: previousSessionId,
      rebuilt: false,
      warnings: [...(report.warnings ?? []), `пересборка не выполнена: ${String(report.status)}`],
    };
  }

  // Provenance: the ORIGINAL foreign session now points at the fresh copy.
  await recordImport({
    source,
    foreignId,
    sessionId: report.sessionId,
    title: report.title,
    cwd: report.cwd,
    originalCwd: String(transcript?.cwd ?? ''),
    importedAt: Date.now(),
    eventCount: report.eventCount,
    turnCount: report.turnCount,
    droppedCalls: report.droppedCalls,
    droppedResults: report.droppedResults,
    verified: report.verified === true,
    warnings: report.warnings ?? [],
    foreignMessageCount: sourceSignature.count,
    foreignPrefixHash: sourceSignature.prefixHash,
  });
  await forgetImport(source, transcript.foreignId).catch(() => {});

  // One conversation should look like one session: the old copy is archived, not
  // deleted, so the user can still unarchive it if they want the older snapshot.
  let archived = false;
  try {
    const workspace = requireService(ctx, 'workspaceRegistry');
    if (typeof workspace?.archiveSession === 'function') {
      await workspace.archiveSession(previousSessionId, {});
      archived = true;
    }
  } catch {
    archived = false;
  }

  return {
    status: 'updated',
    sessionId: report.sessionId,
    previousSessionId,
    archived,
    rebuilt: true,
    verified: report.verified === true,
    eventCount: report.eventCount,
    turnCount: report.turnCount,
    warnings: [
      ...(report.warnings ?? []),
      `копия собрана заново под новым id; прежняя копия ${archived ? 'отправлена в архив' : 'оставлена без изменений'}`,
    ],
  };
}

/**
 * Append the new tail of a foreign session to its already imported DSH session.
 *
 * An update is not a re-import: the DSH session keeps its identity, its title and
 * any turn the user added here, and only the messages that appeared in the origin
 * since the import are appended as further turns. A source that rewrote its
 * history in place cannot be updated this way and is reported instead.
 *
 * @param ctx - the Host plugin context.
 * @param ref - `{source, id, path?}` of the foreign session.
 * @returns a report: `{status, sessionId, addedMessages, addedTurns, verified, warnings}`.
 */
export async function updateImported(ctx, ref) {
  const source = String(ref?.source ?? '');
  const adapter = sourceById(source);
  if (adapter === undefined) throw new Error(`unknown source "${source}"; known sources: claude-code, codex, zcode-cli, zcode-v2, kilo, opencode`);
  const foreignId = String(ref?.id ?? '');
  if (foreignId === '') throw new Error('update needs a foreign session id');

  const fresh = await adapter.readSession(ref);
  const freshSignature = signatureOf(fresh.messages);
  const entry = findImport(source, foreignId);

  if (entry === undefined) {
    // Nothing was imported under this identity yet: an update is a first import.
    const report = await importSession(ctx, { ...fresh, sourceSignature: freshSignature }, {});
    return { ...report, updated: false };
  }

  const sessionId = String(entry.sessionId ?? sessionIdFor(source, foreignId));
  const known = Number.isSafeInteger(entry.foreignMessageCount) ? entry.foreignMessageCount : 0;
  const storedPrefix = typeof entry.foreignPrefixHash === 'string' ? entry.foreignPrefixHash : '';
  const query = requireService(ctx, 'sessionQuery');
  const current = await query.readSession(sessionId);
  const events = Array.isArray(current?.events) ? current.events : [];
  if (events.length === 0) throw new Error(`session "${sessionId}" has no stored log to update`);
  if (hasOpenTurn(events)) {
    return {
      status: 'busy',
      sessionId,
      addedMessages: 0,
      addedTurns: 0,
      verified: false,
      warnings: ['в сессии открыт ход (она выполняется или прервана); дождитесь завершения или откройте и завершите её'],
    };
  }

  /**
   * A copy this importer wrote and nobody has changed can simply be rebuilt from
   * the origin. That is the only way to "update" a copy whose watermark is
   * unknown (imported before watermarks existed) or whose origin rewrote itself.
   */
  const rebuild = async (reason) => {
    const report = await reimportImported(ctx, ref);
    return { ...report, warnings: [...(report.warnings ?? []), reason] };
  };

  if (known === 0) {
    // Without a watermark there is no way to tell "new" from "all"; appending
    // everything would duplicate the whole conversation.
    if (copyUntouched(events, entry)) return await rebuild('копия пересобрана: у записи не было отметки об импортированном объёме');
    return {
      status: 'needs-reimport',
      sessionId,
      addedMessages: 0,
      addedTurns: 0,
      verified: false,
      warnings: ['в копию добавляли ходы после импорта, поэтому пересборка небезопасна: импортируйте сессию заново под новым именем'],
    };
  }
  // The fingerprint covers a fixed leading window, so it can prove a rewrite only
  // when both sides actually have that window; a tiny session is compared by its
  // recorded length alone.
  const canComparePrefix = known >= SIGNATURE_PREFIX && fresh.messages.length >= SIGNATURE_PREFIX && storedPrefix !== '';
  if (canComparePrefix && storedPrefix !== freshSignature.prefixHash) {
    if (copyUntouched(events, entry)) return await rebuild('копия пересобрана: источник переписал начало истории');
    return {
      status: 'diverged',
      sessionId,
      addedMessages: 0,
      addedTurns: 0,
      verified: false,
      warnings: ['источник переписал начало истории, а в копии есть ваши ходы; обновление не выполнено'],
    };
  }
  if (fresh.messages.length <= known) {
    return { status: 'up-to-date', sessionId, addedMessages: 0, addedTurns: 0, verified: true, warnings: [] };
  }

  const delta = fresh.messages.slice(known);
  const persistence = requireService(ctx, 'sessionPersistence');

  const startTurn = events.filter((event) => event?.type === 'turn/start').length + 1;
  const header = {
    version: 4,
    id: sessionId,
    createdAt: Number.isSafeInteger(current?.session?.createdAt) ? current.session.createdAt : Date.now(),
    cwd: typeof current?.session?.cwd === 'string' ? current.session.cwd : '',
  };
  const built = buildEvents({ ...fresh, messages: delta }, header, { startTurn, emitSystemHead: false, emitTitle: false });
  assertEventStream(built.events, { startTurn, requireHead: false });
  // The tail must continue the stored numbering, and the writer rejects a chunk
  // whose first seq is not the next one. A log is not guaranteed to start at zero
  // or to end on its highest seq, so the anchor is the maximum saved seq.
  let maxSeq = -1;
  for (const event of events) {
    if (Number.isSafeInteger(event?.seq) && event.seq > maxSeq) maxSeq = event.seq;
  }
  const baseSeq = maxSeq >= 0 ? maxSeq + 1 : events.length;
  const tail = built.events.map((event, index) => ({ ...event, seq: baseSeq + index }));

  let handle;
  try {
    handle = await persistence.open(sessionId, 'write');
  } catch (error) {
    return {
      status: 'busy',
      sessionId,
      addedMessages: 0,
      addedTurns: 0,
      verified: false,
      warnings: [`сессию нельзя открыть на запись: ${error?.message ?? String(error)}`],
    };
  }
  try {
    await handle.read(0);
    await handle.append(tail);
    await handle.flush();
  } finally {
    try {
      await handle.close();
    } catch {
      /* a close failure must not mask an append failure */
    }
  }

  let verified = false;
  let verifyError;
  try {
    const reader = await persistence.open(sessionId, 'read');
    try {
      await reader.read(0);
      verified = true;
    } finally {
      try {
        await reader.close();
      } catch {
        /* nothing to release */
      }
    }
  } catch (error) {
    verifyError = error?.message ?? String(error);
  }

  const warnings = [];
  if (!verified) warnings.push(`приложение хвоста не прошло проверку чтением: ${String(verifyError ?? 'причина неизвестна')}`);
  if (built.droppedCalls > 0) warnings.push(`${built.droppedCalls} вызов(ов) без результата отброшены`);
  const addedTurns = built.events.filter((event) => event.type === 'turn/start').length;

  await recordImport({
    source,
    foreignId,
    sessionId,
    title: String(entry.title ?? ''),
    cwd: String(entry.cwd ?? ''),
    originalCwd: String(entry.originalCwd ?? ''),
    importedAt: Number.isSafeInteger(entry.importedAt) ? entry.importedAt : Date.now(),
    eventCount: events.length + built.events.length,
    turnCount: startTurn - 1 + addedTurns,
    droppedCalls: built.droppedCalls,
    droppedResults: built.droppedResults,
    verified,
    warnings,
    foreignMessageCount: freshSignature.count,
    foreignPrefixHash: freshSignature.prefixHash,
  });

  return { status: 'updated', sessionId, addedMessages: delta.length, addedTurns, verified, warnings };
}

