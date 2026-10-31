/**
 * Codex source adapter.
 *
 * Layout: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one file per session.
 * Titles live in `~/.codex/state_5.sqlite` (`threads`) with
 * `~/.codex/session_index.jsonl` as a fallback; the rollout stream itself holds
 * `session_meta`, `response_item` (message / reasoning / function_call /
 * function_call_output / custom_tool_call), and bookkeeping records.
 *
 * Read-only: nothing under `~/.codex` is written.
 */
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { argumentsOf, timeOf } from '../events.js';
import { forEachJsonLine, parseJsonLines, readHead, readJsonOrUndefined, userHome } from '../paths.js';
import { querySqlite, tableColumns, tableExists } from '../sqlite.js';

export const id = 'codex';
export const label = 'Codex';

/** Root of the Codex rollout store. */
export function root() {
  return join(userHome(), '.codex', 'sessions');
}

/** SQLite thread index that carries the human-given session names. */
export function stateDatabase() {
  return join(userHome(), '.codex', 'state_5.sqlite');
}

/** Legacy name index that some builds keep instead of the SQLite column. */
export function nameIndex() {
  return join(userHome(), '.codex', 'session_index.jsonl');
}

const WINDOW = 32 * 1024;

/** Coerce a value to text. */
const textOf = (value) => (typeof value === 'string' ? value : '');

/** Availability: the rollout store must exist. */
export async function status() {
  try {
    const entries = await readdir(root(), { withFileTypes: true });
    return { available: true, detail: `${entries.filter((entry) => entry.isDirectory()).length} day director(ies)` };
  } catch {
    return { available: false, reason: `not found at ${root()}`, hint: 'Codex keeps rollouts under ~/.codex/sessions' };
  }
}

/** Walk the dated rollout tree, newest first. */
async function collectFiles() {
  const files = [];
  const walk = async (directory, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.startsWith('rollout-')) continue;
      const info = await stat(path).catch(() => undefined);
      files.push({ path, name: entry.name, sizeBytes: info?.size ?? 0, updatedAt: info?.mtimeMs ?? 0 });
    }
  };
  try {
    await walk(root(), 0);
  } catch {
    return files;
  }
  files.sort((left, right) => right.updatedAt - left.updatedAt);
  return files;
}

/** Read the thread rows from the SQLite index, tolerating any schema drift. */
async function readThreadRows() {
  const database = stateDatabase();
  if (!existsSync(database)) return undefined;
  try {
    if (!(await tableExists(database, 'threads'))) return undefined;
    const columns = await tableColumns(database, 'threads');
    const select = ['id AS id'];
    for (const [alias, candidates] of [
      ['title', ['title']],
      ['cwd', ['cwd']],
      ['rollout_path', ['rollout_path', 'rolloutPath']],
      ['updated_at', ['updated_at', 'updatedAt', 'created_at']],
    ]) {
      const column = candidates.find((candidate) => columns.includes(candidate));
      if (column !== undefined) select.push(`${column} AS ${alias}`);
    }
    return await querySqlite(database, `SELECT ${select.join(', ')} FROM threads`);
  } catch {
    return undefined;
  }
}

/** Rollout id from a rollout file name (`rollout-2026-01-02T03-04-05-<uuid>.jsonl`). */
function idOfName(name) {
  const match = /rollout-.*-([0-9a-f-]{36})\.jsonl$/iu.exec(name);
  return match === null ? name.replace(/\.jsonl$/u, '') : match[1];
}

/** First-line metadata of one rollout, used when no index row exists. */
async function describeFile(file) {
  const records = parseJsonLines(await readHead(file.path, WINDOW));
  let cwd = '';
  let sessionId = '';
  let title = '';
  for (const record of records) {
    const payload = record?.payload;
    if (record?.type === 'session_meta' && payload !== null && typeof payload === 'object') {
      if (cwd === '' && typeof payload.cwd === 'string') cwd = payload.cwd;
      if (sessionId === '' && typeof payload.id === 'string') sessionId = payload.id;
    }
    if (title === '' && typeof record?.title === 'string') title = record.title;
  }
  return {
    source: id,
    id: sessionId || idOfName(file.name),
    title,
    cwd,
    updatedAt: file.updatedAt,
    sizeBytes: file.sizeBytes,
    path: file.path,
  };
}

/**
 * One listing page, newest first.
 * @param options - `{limit, offset, query}`.
 */
export async function listSessions(options = {}) {
  const limit = Number.isSafeInteger(options.limit) ? options.limit : 50;
  const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
  const query = textOf(options.query).trim().toLowerCase();

  const threads = await readThreadRows();
  if (threads !== undefined && threads.length > 0) {
    const names = new Map();
    const index = await readJsonOrUndefined(nameIndex());
    if (Array.isArray(index)) {
      for (const entry of index) {
        if (typeof entry?.id === 'string' && typeof entry?.thread_name === 'string') names.set(entry.id, entry.thread_name);
      }
    }
    const rows = threads
      .map((row) => ({
        source: id,
        id: textOf(row.id),
        title: textOf(row.title) || names.get(textOf(row.id)) || '',
        cwd: textOf(row.cwd),
        updatedAt: timeOf(row.updated_at, 0) || undefined,
        path: textOf(row.rollout_path),
        sizeBytes: 0,
      }))
      .filter((row) => row.id !== '');
    const matching =
      query === ''
        ? rows
        : rows.filter((row) => row.title.toLowerCase().includes(query) || row.cwd.toLowerCase().includes(query) || row.id.toLowerCase().includes(query));
    const page = matching.slice(offset, offset + limit);
    return { sessions: page, total: matching.length, truncated: matching.length > offset + page.length };
  }

  const files = await collectFiles();
  const matching =
    query === '' ? files : files.filter((file) => file.name.toLowerCase().includes(query));
  const page = matching.slice(offset, offset + limit);
  const sessions = [];
  for (const file of page) sessions.push(await describeFile(file));
  return { sessions, total: matching.length, truncated: matching.length > offset + sessions.length };
}

/** Full transcript of one rollout. */
export async function readSession(ref) {
  const path = textOf(ref?.path);
  if (path === '' || !existsSync(path)) throw new Error(`readSession cannot open ${path === '' ? 'an empty path' : path}`);
  const messages = [];
  let cwd = '';
  let sessionId = '';
  let createdAt;
  let provider = '';
  let model = '';
  let lastAssistant;
  let pendingReasoning = [];
  let skippedDeveloper = 0;

  const pushAssistant = (content, at) => {
    const blocks = [...pendingReasoning, ...content];
    pendingReasoning = [];
    if (blocks.length === 0) return undefined;
    const message = { role: 'assistant', content: blocks, at };
    messages.push(message);
    return message;
  };

  await forEachJsonLine(path, (record) => {
    if (record === null || typeof record !== 'object') return;
    const at = timeOf(record.timestamp, undefined);
    const payload = record.payload;
    if (record.type === 'session_meta' && payload !== null && typeof payload === 'object') {
      if (cwd === '' && typeof payload.cwd === 'string') cwd = payload.cwd;
      if (sessionId === '' && typeof payload.id === 'string') sessionId = payload.id;
      if (provider === '' && typeof payload.model_provider === 'string') provider = payload.model_provider;
      if (model === '' && typeof payload.model === 'string') model = payload.model;
      if (createdAt === undefined) createdAt = timeOf(payload.timestamp, at);
      return;
    }
    if (record.type === 'turn_context' && payload !== null && typeof payload === 'object') {
      if (model === '' && typeof payload.model === 'string') model = payload.model;
      if (cwd === '' && typeof payload.cwd === 'string') cwd = payload.cwd;
      return;
    }
    if (record.type !== 'response_item' || payload === null || typeof payload !== 'object') return;

    switch (textOf(payload.type)) {
      case 'message': {
        const role = textOf(payload.role);
        const parts = Array.isArray(payload.content) ? payload.content : [];
        const text = parts
          .map((part) => (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text' ? textOf(part.text) : ''))
          .filter((value) => value !== '')
          .join('\n\n');
        if (text === '') return;
        if (role === 'developer') {
          // Agent scaffolding from the origin build: not conversation, not replayable.
          skippedDeveloper += 1;
          return;
        }
        if (role === 'assistant') {
          lastAssistant = pushAssistant([{ type: 'text', text }], at);
          return;
        }
        if (role === 'user') {
          lastAssistant = undefined;
          messages.push({ role: 'user', text, at });
        }
        return;
      }
      case 'reasoning': {
        const sources = [payload.summary, payload.content].filter((value) => Array.isArray(value));
        const text = sources
          .flat()
          .map((part) => textOf(part?.text))
          .filter((value) => value !== '')
          .join('\n\n');
        if (text !== '') pendingReasoning.push({ type: 'reasoning', text });
        return;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = textOf(payload.name) || 'tool';
        const callId = textOf(payload.call_id) || textOf(payload.callId) || `call-${messages.length}`;
        const raw = payload.type === 'function_call' ? payload.arguments : payload.input;
        const block = { type: 'tool-call', id: callId, name, arguments: argumentsOf(raw) };
        const target = lastAssistant !== undefined && messages.at(-1) === lastAssistant ? lastAssistant : pushAssistant([], at);
        if (target === undefined) return;
        target.content.push(block);
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = textOf(payload.call_id) || textOf(payload.callId);
        if (callId === '') return;
        const raw = payload.output;
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
        messages.push({ role: 'tool', callId, text, isError: payload.is_error === true || payload.status === 'error', at });
        return;
      }
      default:
        return;
    }
  });

  // A trailing reasoning-only item still deserves a place in the history.
  if (pendingReasoning.length > 0) pushAssistant([], messages.at(-1)?.at);

  return {
    source: id,
    label,
    foreignId: textOf(ref?.id) || sessionId,
    title: textOf(ref?.title),
    cwd: cwd || textOf(ref?.cwd),
    createdAt: createdAt ?? Date.now(),
    model: { provider: provider || 'openai', model },
    messages,
    notes: skippedDeveloper === 0 ? [] : [`${skippedDeveloper} developer instruction item(s) skipped`],
  };
}

/**
 * Sessions spawned inside one session.
 *
 * This store keeps a spawned run inside its parent's own transcript (or not at
 * all), so there is no separate child session to offer as context.
 * @returns always an empty list.
 */
export async function childSessions() {
  return [];
}
