/**
 * Repairing the update watermark of an inherited import without deleting anything.
 *
 * An update appends only the tail of the origin, which needs two ledger fields:
 * how many source messages the DSH copy holds and a hash of the source opening.
 * A ledger row written by a predecessor install has neither, so the honest
 * question is: can the copy be PROVEN to be a prefix of the current origin?
 *
 * The proof compares normalized message sequences, never raw event counts:
 * both sides are reduced to `{role, text}` entries — user prompts and assistant
 * text, with tool calls, tool results, reasoning and the importer's own system
 * head dropped, because those have no stable one-to-one counterpart across
 * agents. If every copy entry matches the source in order (or the source ends
 * exactly at the copy), the copy is a prefix and the watermark is written: the
 * ORIGINAL source message index of the last matched entry, plus the opening hash
 * the updater compares. A mismatch at any position means the origin rewrote its
 * history — reported as `diverged`, never repaired silently.
 */
import { signatureOf } from './import.js';
import { findImport, listImports, recordImport } from './ledger.js';

/** Importer fallbacks that have no source counterpart. */
const IMPORTED_FALLBACK = /^\[imported from [^\]]*: the origin recorded (no opening user message for this turn|no messages)\]/u;

/** Await a possibly-synchronous service answer. */
async function settle(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function' ? await value : value;
}

/** Text of one content block that both sides can agree on. */
function blockText(block) {
  if (block === null || typeof block !== 'object') return '';
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : '';
  if (block.type === 'image') return '[image omitted]';
  if (block.type === 'file') {
    const name = typeof block.name === 'string' ? block.name : typeof block.filename === 'string' ? block.filename : '';
    return name === '' ? '[file omitted]' : `[file omitted: ${name}]`;
  }
  // reasoning and tool-call blocks have no comparable text
  return '';
}

/** Join the comparable text blocks of one assistant message. */
function assistantText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    const text = blockText(block);
    if (text !== '') parts.push(text);
  }
  return parts.join('\n\n');
}

/**
 * Normalize source transcript messages.
 *
 * @param messages - the adapter's normalized messages.
 * @returns `{entries, rawEnds}` where entry `i` covers source messages up to
 *   `rawEnds[i]` (exclusive) — the exact index a watermark must use, because the
 *   updater slices the RAW message array.
 */
export function normalizeSourceMessages(messages) {
  const entries = [];
  const rawEnds = [];
  const list = Array.isArray(messages) ? messages : [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    const role = message?.role;
    if (role === 'user') {
      const text = typeof message.text === 'string' && message.text !== '' ? message.text : '(empty prompt)';
      entries.push({ role: 'user', text });
      rawEnds.push(index + 1);
      continue;
    }
    if (role === 'assistant') {
      entries.push({ role: 'assistant', text: assistantText(message.content) });
      rawEnds.push(index + 1);
    }
    // tool messages are folded into tool results on the DSH side: skipped
  }
  return { entries, rawEnds };
}

/**
 * Normalize the stored DSH log to the same comparable sequence.
 *
 * The importer's system head, title, turn/step markers and tool events are
 * dropped; the appendix turns of subagent transcripts are NOT dropped — they
 * simply come after the source prefix, so they can never break the comparison.
 */
export function normalizeSessionEvents(events) {
  const entries = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'user/message') {
      const text = assistantLikeText(event.data?.content);
      if (IMPORTED_FALLBACK.test(text)) continue;
      entries.push({ role: 'user', text });
      continue;
    }
    if (event?.type === 'assistant/message') {
      entries.push({ role: 'assistant', text: assistantText(event.data?.message?.content) });
    }
  }
  return entries;
}

/** Text of a user message's content blocks (user messages carry blocks, not content). */
function assistantLikeText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n\n');
}

/** Length of the longest common prefix of two normalized sequences. */
export function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit) {
    const a = left[index];
    const b = right[index];
    if (a.role !== b.role || a.text !== b.text) break;
    index += 1;
  }
  return index;
}

/** Read the stored event log of one session, through the cheapest available seam. */
export async function readStoredEvents(ctx, sessionId) {
  const query = typeof ctx?.get === 'function' ? ctx.get('sessionQuery') : undefined;
  if (query !== undefined && query !== null && typeof query.readSession === 'function') {
    try {
      const log = await settle(query.readSession(sessionId));
      if (Array.isArray(log?.events)) return log.events;
    } catch {
      /* fall through to persistence */
    }
  }
  const persistence = typeof ctx?.get === 'function' ? ctx.get('sessionPersistence') : undefined;
  if (persistence !== undefined && persistence !== null && typeof persistence.open === 'function') {
    try {
      const handle = await settle(persistence.open(sessionId, 'read'));
      try {
        const result = await settle(handle.read(0));
        if (Array.isArray(result?.events)) return result.events;
      } finally {
        try {
          await settle(handle.close());
        } catch {
          /* nothing to release */
        }
      }
    } catch {
      /* unreadable */
    }
  }
  return [];
}

/** Persist a repaired watermark onto the existing ledger row, keeping provenance. */
async function writeWatermark(entry, { foreignMessageCount, foreignPrefixHash }) {
  return await recordImport({
    source: entry.source,
    foreignId: entry.foreignId,
    sessionId: entry.sessionId,
    title: entry.title,
    cwd: entry.cwd,
    originalCwd: entry.originalCwd,
    importedAt: entry.importedAt,
    eventCount: entry.eventCount,
    turnCount: entry.turnCount,
    droppedCalls: entry.droppedCalls,
    droppedResults: entry.droppedResults,
    verified: entry.verified === true,
    warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
    foreignMessageCount,
    foreignPrefixHash,
  });
}

/**
 * Prove one copy against its origin and write the watermark when the proof holds.
 *
 * @param ctx - the Host context.
 * @param entry - the ledger row to repair.
 * @param options - `{adapter}`: the source adapter (injectable for tests).
 * @returns `{sessionId, status: 'repaired'|'diverged'|'failed', matchedMessages,
 *   copiedMessages, sourceMessages, foreignMessageCount, reason}`.
 */
export async function repairLedgerWatermark(ctx, entry, options = {}) {
  const sessionId = String(entry?.sessionId ?? '');
  const base = { sessionId, matchedMessages: 0, copiedMessages: 0, sourceMessages: 0, foreignMessageCount: 0 };
  if (sessionId === '') return { ...base, status: 'failed', reason: 'в журнале нет идентификатора сессии' };
  const adapter = options.adapter ?? (await import('./sources/index.js')).sourceById(String(entry.source ?? ''));
  if (adapter === undefined || typeof adapter.readSession !== 'function') {
    return { ...base, status: 'failed', reason: `источник «${String(entry.source ?? '')}» не поддерживается` };
  }

  let transcript;
  try {
    transcript = await adapter.readSession({ source: entry.source, id: entry.foreignId, path: options.foreignPath ?? entry.path });
  } catch (error) {
    return { ...base, status: 'failed', reason: `источник не читается: ${String(error?.message ?? error)}` };
  }
  const source = normalizeSourceMessages(transcript?.messages);
  const sourceMessages = Array.isArray(transcript?.messages) ? transcript.messages.length : 0;
  const events = await readStoredEvents(ctx, sessionId);
  if (events.length === 0) return { ...base, status: 'failed', sourceMessages, reason: 'DSH-копия не читается: журнал событий пуст' };
  const copy = normalizeSessionEvents(events);
  const matched = commonPrefixLength(copy, source.entries);
  const withCounts = { ...base, matchedMessages: matched, copiedMessages: copy.length, sourceMessages };

  if (copy.length === 0) return { ...withCounts, status: 'failed', reason: 'в DSH-копии нет сообщений для сверки' };
  if (source.entries.length === 0) return { ...withCounts, status: 'failed', reason: 'источник не содержит сопоставимых сообщений' };
  // The copy is provably a prefix when every copy entry matched, or when the
  // source itself ended before the copy (subagent appendix turns follow it).
  const copyCovered = matched === copy.length;
  const sourceCovered = matched === source.entries.length;
  if (!copyCovered && !sourceCovered) {
    return { ...withCounts, status: 'diverged', reason: 'начало истории источника не совпадает с копией — источник переписан' };
  }
  const rawCount = sourceCovered ? sourceMessages : source.rawEnds[matched - 1] ?? 0;
  if (rawCount <= 0) return { ...withCounts, status: 'failed', reason: 'не удалось определить объём источника по совпавшему префиксу' };

  const signature = signatureOf(transcript?.messages ?? []);
  await writeWatermark(entry, { foreignMessageCount: rawCount, foreignPrefixHash: signature.prefixHash });
  return {
    ...withCounts,
    status: 'repaired',
    foreignMessageCount: rawCount,
    reason: copyCovered && !sourceCovered ? 'копия — префикс источника, отметка восстановлена' : 'источник совпадает с копией, отметка восстановлена',
  };
}

/** Whether a ledger row already carries a usable watermark. */
export function hasWatermark(entry) {
  return Number.isSafeInteger(entry?.foreignMessageCount) && entry.foreignMessageCount > 0 && typeof entry?.foreignPrefixHash === 'string' && entry.foreignPrefixHash !== '';
}

/**
 * Repair one or many ledger rows.
 *
 * @param ctx - the Host context.
 * @param query - `{entryIds, sessionIds, refs}`; both id lists omitted means
 *   "every row without a watermark". An entry id is the ledger key
 *   `source:foreignId`; `refs` is `[{sessionId, path}]` and only helps an adapter
 *   find a store file the ledger never recorded.
 * @param options - `{adapters}`: map of source id to adapter (tests).
 */
export async function repairWatermarks(ctx, query = {}, options = {}) {
  const all = listImports();
  let entries;
  if (Array.isArray(query.sessionIds) && query.sessionIds.length > 0) {
    const wanted = new Set(query.sessionIds.map(String));
    entries = all.filter((entry) => wanted.has(String(entry.sessionId ?? '')));
  } else if (Array.isArray(query.entryIds) && query.entryIds.length > 0) {
    entries = [];
    for (const raw of query.entryIds.map(String)) {
      const at = raw.indexOf(':');
      if (at <= 0) continue;
      const found = findImport(raw.slice(0, at), raw.slice(at + 1));
      if (found !== undefined) entries.push(found);
    }
  } else {
    entries = all.filter((entry) => !hasWatermark(entry));
  }

  const pathById = new Map();
  for (const ref of Array.isArray(query.refs) ? query.refs : []) {
    if (typeof ref?.sessionId === 'string' && typeof ref?.path === 'string' && ref.path !== '') pathById.set(ref.sessionId, ref.path);
  }
  const items = [];
  for (const entry of entries) {
    try {
      const adapter = options.adapters?.[String(entry.source ?? '')];
      items.push(await repairLedgerWatermark(ctx, entry, { adapter, foreignPath: pathById.get(String(entry.sessionId ?? '')) }));
    } catch (error) {
      items.push({ sessionId: String(entry?.sessionId ?? ''), status: 'failed', matchedMessages: 0, copiedMessages: 0, sourceMessages: 0, foreignMessageCount: 0, reason: String(error?.message ?? error) });
    }
  }
  return {
    items,
    summary: {
      requested: entries.length,
      repaired: items.filter((item) => item.status === 'repaired').length,
      diverged: items.filter((item) => item.status === 'diverged').length,
      failed: items.filter((item) => item.status === 'failed').length,
    },
  };
}

