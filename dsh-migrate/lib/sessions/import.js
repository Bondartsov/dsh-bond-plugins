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
import { recordImport, findImport } from './ledger.js';
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
 * Report one import stage to the caller.
 *
 * The Host run registry is the only listener, and it must never be able to fail
 * an import: a broken progress callback is observability loss, not data loss.
 *
 * @param options - the import options carrying `onProgress`.
 * @param stage - one of runs.js `STAGE_LABELS`.
 * @param data - stage payload (counts, title).
 */
function emit(options, stage, data = {}) {
  const listener = options?.onProgress;
  if (typeof listener !== 'function') return;
  try {
    listener(stage, data);
  } catch {
    /* progress is observability, never a gate */
  }
}

/** Events appended per `append` call, so the panel can show «N из M». */
const EVENT_APPEND_CHUNK = 250;

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

/**
 * Attach the imported session to the DSH workspace of its project directory.
 *
 * Exported because the repair path (`attach.js`, the attach route) must use the
 * very same mechanism the import uses — one implementation, two callers.
 */
export async function attachToWorkspace(ctx, header, title) {
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
    return {
      attached: true,
      workspacePath: typeof workspace.path === 'string' ? workspace.path : header.cwd,
      workspaceTitle: typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : projectTitle,
    };
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

  // A non-destructive re-import writes a COPY under a fresh id; every normal
  // import keeps the deterministic id that makes a second import a no-op.
  const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : sessionIdFor(source, foreignId);
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
  emit(options, 'creating', {
    title: built.title,
    cwd,
    messages: Array.isArray(transcript?.messages) ? transcript.messages.length : 0,
    events: built.events.length,
  });

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
    // Append in slices: the panel shows «запись событий (N из M)» while a large
    // session is being written, and a failure still leaves a readable prefix.
    const total = built.events.length;
    emit(options, 'writing', { written: 0, total });
    for (let offset = 0; offset < total; offset += EVENT_APPEND_CHUNK) {
      const slice = built.events.slice(offset, offset + EVENT_APPEND_CHUNK);
      await handle.append(slice);
      emit(options, 'writing', { written: offset + slice.length, total });
    }
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
  emit(options, 'verifying', { events: built.events.length });
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

  emit(options, 'done', {
    title: built.title,
    sessionId,
    messages: sourceSignature.count,
    turns: turnCount,
    warnings,
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
  emit(options, 'reading', {});
  const transcript = await adapter.readSession(ref);
  emit(options, 'building', { messages: Array.isArray(transcript?.messages) ? transcript.messages.length : 0 });
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

/**
 * Whether the stored log currently has an open turn or step.
 *
 * A finished session is not required to END with `turn/end`: DSH appends service
 * events (a title, a model selection, approval or sandbox policy, a command
 * receipt) after the closing event, so the tail is scanned for lifecycle markers
 * instead of trusting the last row.
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

/** Whether the stored copy still holds exactly the number of turns this importer wrote. */
function copyUntouched(events, entry) {
  const expected = Number.isSafeInteger(entry?.turnCount) ? entry.turnCount : 0;
  const actual = Array.isArray(events) ? events.filter((event) => event?.type === 'turn/start').length : 0;
  return expected > 0 && actual === expected;
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
  let known = Number.isSafeInteger(entry.foreignMessageCount) ? entry.foreignMessageCount : 0;
  let storedPrefix = typeof entry.foreignPrefixHash === 'string' ? entry.foreignPrefixHash : '';

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

  /** The title this copy carries in its own log — the last `session/title` row. */
  let copyTitle = '';
  for (const event of events) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') copyTitle = event.data.title;
  }

  /**
   * Keep the copy's name in step with its origin: a session renamed in the source (a suffix such as
   * «(закрыто)») kept the old name in DSH, so "обновлено" looked half-done.
   *
   * A title that differs from the one this importer recorded was chosen here by the owner, so it is
   * never overwritten — only an untouched name follows the source.
   *
   * @param record - ledger fields to persist together with the rename (defaults to the stored row).
   * @returns the new title, or null when nothing was renamed.
   */
  const syncTitle = async (record = {}) => {
    const sourceTitle = typeof fresh?.title === 'string' ? fresh.title.trim() : '';
    if (sourceTitle === '' || sourceTitle === copyTitle) return null;
    const ledgerTitle = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (copyTitle.trim() !== ledgerTitle) return null;
    const controller = typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined;
    if (controller === undefined || typeof controller.rename !== 'function') return null;
    try {
      await controller.rename({ sessionId, title: sourceTitle });
      await recordImport({
        source,
        foreignId,
        sessionId,
        title: sourceTitle,
        cwd: String(entry.cwd ?? ''),
        originalCwd: String(entry.originalCwd ?? ''),
        importedAt: Number.isSafeInteger(entry.importedAt) ? entry.importedAt : Date.now(),
        eventCount: Number.isSafeInteger(entry.eventCount) ? entry.eventCount : events.length,
        turnCount: Number.isSafeInteger(entry.turnCount) ? entry.turnCount : 0,
        droppedCalls: Number.isSafeInteger(entry.droppedCalls) ? entry.droppedCalls : 0,
        droppedResults: Number.isSafeInteger(entry.droppedResults) ? entry.droppedResults : 0,
        verified: entry.verified === true,
        warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
        foreignMessageCount: Number.isSafeInteger(entry.foreignMessageCount) ? entry.foreignMessageCount : 0,
        foreignPrefixHash: typeof entry.foreignPrefixHash === 'string' ? entry.foreignPrefixHash : '',
        ...record,
      });
      return sourceTitle;
    } catch {
      /* a name is decoration: a failed rename must not fail the update */
      return null;
    }
  };

  /**
   * A row written before watermarks existed can still be proven against the copy: the watermark
   * is stamped and the ordinary append path continues. Rebuilding for that case would create a
   * NEW session id on every press — the owner saw exactly that as duplicated sessions in the
   * sidebar. So proof always comes first; a rebuild is the answer only when proof is impossible.
   */
  if (known === 0) {
    try {
      const { repairLedgerWatermark } = await import('./watermark.js');
      const repair = await repairLedgerWatermark(ctx, entry, { foreignPath: ref?.path });
      if (
        repair?.status === 'repaired' &&
        Number.isSafeInteger(repair.foreignMessageCount) &&
        repair.foreignMessageCount > 0
      ) {
        known = repair.foreignMessageCount;
        // The repair wrote the prefix hash itself; leaving `storedPrefix` empty skips the
        // rewrite comparison for this call and the next update compares properly.
      }
    } catch {
      /* no proof available: the branches below refuse or rebuild, never silently duplicate */
    }
  }

  /**
   * A copy this importer wrote and nobody has changed can be rebuilt in `copy`
   * mode: a new artifact under a new id, the previous one archived — nothing is
   * deleted. That is what makes a single "Обновить" finish the job instead of
   * sending the owner to a second button.
   */
  const rebuildCopy = async (reason) => {
    const { reimportSession } = await import('./reimport.js');
    const result = await reimportSession(ctx, ref, { mode: 'copy' });
    return {
      status: 'updated',
      sessionId: String(result?.sessionId ?? sessionId),
      previousSessionId: String(result?.previousSessionId ?? sessionId),
      archived: result?.archived === true,
      rebuilt: true,
      verified: true,
      eventCount: Number.isSafeInteger(result?.report?.eventCount) ? result.report.eventCount : 0,
      turnCount: Number.isSafeInteger(result?.turns) ? result.turns : 0,
      warnings: [...(Array.isArray(result?.warnings) ? result.warnings : []), reason],
    };
  };

  if (known === 0) {
    // An entry written before watermarks existed cannot tell "new" from "all";
    // appending everything would duplicate the whole conversation.
    if (copyUntouched(events, entry)) {
      return await rebuildCopy('копия собрана заново под новым id; прежняя копия уходит в архив');
    }
    return {
      status: 'needs-reimport',
      sessionId,
      addedMessages: 0,
      addedTurns: 0,
      verified: false,
      // The action makes the dead end a button in the panel instead of red text.
      action: 'reimport',
      reason: 'no-watermark',
      message:
        'У этой копии нет отметки, сколько сообщений источника она содержит, поэтому дописать только новое нельзя — история бы задвоилась. ' +
        'В копию уже добавляли ходы, поэтому автоматическая пересборка небезопасна: переимпорт создаст новую копию, а прежняя уйдёт в архив.',
      warnings: ['у этой записи нет отметки об импортированном объёме; переимпорт создаст новую копию, а прежняя уйдёт в архив'],
    };
  }
  // The fingerprint covers a fixed leading window, so it can prove a rewrite only
  // when both sides actually have that window; a tiny session is compared by its
  // recorded length alone.
  const canComparePrefix = known >= SIGNATURE_PREFIX && fresh.messages.length >= SIGNATURE_PREFIX && storedPrefix !== '';
  if (canComparePrefix && storedPrefix !== freshSignature.prefixHash) {
    if (copyUntouched(events, entry)) {
      return await rebuildCopy('копия собрана заново под новым id: источник переписал начало истории');
    }
    return {
      status: 'diverged',
      sessionId,
      addedMessages: 0,
      addedTurns: 0,
      verified: false,
      action: 'reimport',
      reason: 'diverged',
      message:
        'Источник переписал начало истории (компакция или правка), поэтому копия в DSH отстала и дописать её нельзя. ' +
        'В копии есть ваши ходы, поэтому переимпорт создаст новую копию, а прежняя уйдёт в архив.',
      warnings: ['источник переписал начало истории, а в копии есть ваши ходы; обновление не выполнено'],
    };
  }
  if (fresh.messages.length <= known) {
    // Nothing to append, but the origin may have been renamed since the import.
    const renamedTitle = await syncTitle();
    return {
      status: 'up-to-date',
      sessionId,
      addedMessages: 0,
      addedTurns: 0,
      verified: true,
      warnings: [],
      ...(renamedTitle === null ? {} : { renamedTitle }),
    };
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
  // The stored log already owns a continuous seq range, so the tail must continue that numbering:
  // the writer rejects a chunk whose first seq is not the next one. The last stored seq is the
  // honest base — a log whose numbering does not start at 0 would get a wrong value from the
  // event count alone.
  const lastSeq = events.reduce(
    (max, event) => (Number.isSafeInteger(event?.seq) && event.seq > max ? event.seq : max),
    -1,
  );
  const baseSeq = lastSeq >= 0 ? lastSeq + 1 : events.length;
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

  // The origin may also have been renamed since the import; the append keeps the watermark, so the
  // rename re-records the row with the values this call just wrote.
  const renamedTitle = await syncTitle({
    eventCount: events.length + built.events.length,
    turnCount: startTurn - 1 + addedTurns,
    foreignMessageCount: freshSignature.count,
    foreignPrefixHash: freshSignature.prefixHash,
    verified,
    warnings,
  });
  return {
    status: 'updated',
    sessionId,
    addedMessages: delta.length,
    addedTurns,
    verified,
    warnings,
    ...(renamedTitle === null ? {} : { renamedTitle }),
  };
}
