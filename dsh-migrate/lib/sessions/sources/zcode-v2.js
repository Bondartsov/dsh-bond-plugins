/**
 * ZCode v2 source adapter.
 *
 * Layout: `~/.zcode/v2/sessions/<sha256(cwd)[0:12]>/<id>.json`, one JSON document
 * per session: `{meta:{title, workspacePath, createdAt, updatedAt, ...},
 * messages:[{role, content, timestamp, turnIndex}]}`.
 *
 * This store keeps text only — no tool calls and no reasoning. The loss is
 * reported per import instead of being silently hidden.
 *
 * Read-only: nothing under `~/.zcode` is written.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { timeOf } from '../events.js';
import { userHome } from '../paths.js';

export const id = 'zcode-v2';
export const label = 'ZCode (v2)';

/** Root of the ZCode v2 session store. */
export function root() {
  return join(userHome(), '.zcode', 'v2', 'sessions');
}

/** Coerce a value to text. */
const textOf = (value) => (typeof value === 'string' ? value : '');

/** Availability: the session store must exist. */
export async function status() {
  try {
    const entries = await readdir(root(), { withFileTypes: true });
    return { available: true, detail: `${entries.filter((entry) => entry.isDirectory()).length} project director(ies)` };
  } catch {
    return { available: false, reason: `not found at ${root()}`, hint: 'ZCode v2 keeps sessions under ~/.zcode/v2/sessions' };
  }
}

/** Collect every session document, newest first. */
async function collectFiles() {
  const files = [];
  let projects;
  try {
    projects = await readdir(root(), { withFileTypes: true });
  } catch {
    return files;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dirPath = join(root(), project.name);
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(dirPath, entry.name);
      const info = await stat(path).catch(() => undefined);
      files.push({ path, id: entry.name.replace(/\.json$/u, ''), sizeBytes: info?.size ?? 0, updatedAt: info?.mtimeMs ?? 0 });
    }
  }
  files.sort((left, right) => right.updatedAt - left.updatedAt);
  return files;
}

/** Parse one session document, or `undefined` when it is unreadable. */
async function readDocument(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One listing page, newest first.
 * @param options - `{limit, offset, query}`.
 */
export async function listSessions(options = {}) {
  const limit = Number.isSafeInteger(options.limit) ? options.limit : 50;
  const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
  const query = textOf(options.query).trim().toLowerCase();

  const files = await collectFiles();
  const rows = [];
  for (const file of files) {
    const document = await readDocument(file.path);
    if (document === undefined) continue;
    const meta = document.meta !== null && typeof document.meta === 'object' ? document.meta : {};
    rows.push({
      source: id,
      id: textOf(meta.taskId) || textOf(meta.traceId) || file.id,
      title: textOf(meta.title),
      cwd: textOf(meta.workspacePath),
      updatedAt: timeOf(meta.updatedAt, file.updatedAt),
      sizeBytes: file.sizeBytes,
      path: file.path,
      messageCount: Array.isArray(document.messages) ? document.messages.length : 0,
    });
  }
  const matching =
    query === ''
      ? rows
      : rows.filter((row) => row.title.toLowerCase().includes(query) || row.cwd.toLowerCase().includes(query) || row.id.toLowerCase().includes(query));
  const page = matching.slice(offset, offset + limit);
  return { sessions: page, total: matching.length, truncated: matching.length > offset + page.length };
}

/** Full transcript of one ZCode v2 session document. */
export async function readSession(ref) {
  const path = textOf(ref?.path);
  if (path === '') throw new Error('readSession needs the session document path');
  const document = await readDocument(path);
  if (document === undefined) throw new Error(`session document ${path} is unreadable`);
  const meta = document.meta !== null && typeof document.meta === 'object' ? document.meta : {};
  const messages = [];
  let toolLoss = 0;

  for (const entry of Array.isArray(document.messages) ? document.messages : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const role = textOf(entry.role);
    const content = entry.content;
    const at = timeOf(entry.timestamp, undefined);
    const texts = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'text') texts.push(textOf(block.text));
        else if (block.type === 'tool' || block.type === 'tool-call' || block.type === 'tool_result') toolLoss += 1;
      }
    }
    const text = texts.join('\n\n').trim();
    if (text === '') continue;
    if (role === 'user') messages.push({ role: 'user', text, at });
    else if (role === 'assistant') {
      messages.push({ role: 'assistant', content: [{ type: 'text', text }], at });
    }
  }

  return {
    source: id,
    label,
    foreignId: textOf(ref?.id) || textOf(meta.taskId) || textOf(meta.traceId),
    title: textOf(meta.title),
    cwd: textOf(meta.workspacePath),
    createdAt: timeOf(meta.createdAt, Date.now()),
    model: { provider: 'zcode', model: textOf(meta.model) },
    messages,
    notes: toolLoss === 0 ? [] : [`${toolLoss} tool block(s) were not stored by ZCode v2`],
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
