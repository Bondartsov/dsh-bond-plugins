/**
 * Claude Code source adapter.
 *
 * Layout: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. One file is one
 * session; the record stream mixes human prompts, assistant turns, tool results
 * (delivered as `user` records carrying `tool_result` blocks), renaming records
 * (`custom-title`) and bookkeeping records this importer ignores.
 *
 * Read-only: nothing under `~/.claude` is written.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { timeOf } from '../events.js';
import { forEachJsonLine, parseJsonLines, readHead, readTail, userHome } from '../paths.js';

export const id = 'claude-code';
export const label = 'Claude Code';

/** Root of the Claude Code project store. */
export function root() {
  return join(userHome(), '.claude', 'projects');
}

/** Listing window: enough for `cwd`, the session id, the first prompt and a rename record. */
const WINDOW = 32 * 1024;

/** Coerce a value to text. */
const textOf = (value) => (typeof value === 'string' ? value : '');

/** Availability: the project store must exist. */
export async function status() {
  try {
    const entries = await readdir(root(), { withFileTypes: true });
    const projects = entries.filter((entry) => entry.isDirectory()).length;
    return { available: true, detail: `${projects} project director${projects === 1 ? 'y' : 'ies'}` };
  } catch {
    return { available: false, reason: `not found at ${root()}`, hint: 'Claude Code keeps sessions under ~/.claude/projects' };
  }
}

/** Collect every session file, newest first, without reading its content yet. */
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
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(dirPath, entry.name);
      const info = await stat(path).catch(() => undefined);
      files.push({
        projectDir: project.name,
        id: entry.name.replace(/\.jsonl$/u, ''),
        path,
        sizeBytes: info?.size ?? 0,
        updatedAt: info?.mtimeMs ?? 0,
      });
    }
  }
  files.sort((left, right) => right.updatedAt - left.updatedAt);
  return files;
}

/** Read the head and tail windows of one session file for its listing row. */
async function describe(file) {
  const head = parseJsonLines(await readHead(file.path, WINDOW));
  const tail = parseJsonLines(await readTail(file.path, WINDOW));
  let cwd = '';
  let firstPrompt = '';
  let title = '';
  for (const record of head) {
    if (cwd === '' && typeof record?.cwd === 'string') cwd = record.cwd;
    if (firstPrompt === '' && record?.type === 'user' && record?.isSidechain !== true && record?.isMeta !== true) {
      const content = record?.message?.content;
      if (typeof content === 'string') firstPrompt = content;
      else if (Array.isArray(content)) {
        const text = content
          .filter((block) => block?.type === 'text')
          .map((block) => textOf(block.text))
          .join('\n\n');
        if (text.trim() !== '') firstPrompt = text;
      }
    }
    if (title === '' && record?.type === 'custom-title') title = textOf(record.customTitle);
  }
  for (const record of tail) {
    if (record?.type === 'custom-title') {
      const value = textOf(record.customTitle);
      if (value !== '') title = value;
    }
  }
  return {
    source: id,
    id: file.id,
    title: title || firstPrompt.split('\n')[0]?.slice(0, 80) || '',
    cwd,
    projectDir: file.projectDir,
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

  const all = await collectFiles();
  const matching =
    query === ''
      ? all
      : all.filter((file) => file.id.toLowerCase().includes(query) || file.projectDir.toLowerCase().includes(query));

  const page = matching.slice(offset, offset + limit);
  const sessions = [];
  for (const file of page) sessions.push(await describe(file));
  return { sessions, total: matching.length, truncated: matching.length > offset + sessions.length };
}

/**
 * Full transcript of one session file.
 *
 * `ref.includeSidechains` reads the records a subagent run wrote into the same
 * file; the main dialogue never includes them, an appendix transcript does.
 */
export async function readSession(ref) {
  const path = textOf(ref?.path);
  if (path === '') throw new Error('readSession needs the session file path');
  const includeSidechains = ref?.includeSidechains === true;
  const messages = [];
  let title = '';
  let cwd = '';
  let createdAt;
  let firstPrompt = '';
  let model = '';

  await forEachJsonLine(path, (record) => {
    if (record === null || typeof record !== 'object') return;
    const at = timeOf(record.timestamp, undefined);
    if (cwd === '' && typeof record.cwd === 'string') cwd = record.cwd;
    if (createdAt === undefined && Number.isSafeInteger(at)) createdAt = at;

    if (record.type === 'custom-title') {
      const value = textOf(record.customTitle);
      if (value !== '') title = value;
      return;
    }
    if (record.type === 'assistant') {
      if (record.isSidechain === true && includeSidechains !== true) return;
      const message = record.message;
      if (message === null || typeof message !== 'object') return;
      if (textOf(message.model) !== '') model = textOf(message.model);
      const blocks = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type === 'text') {
          const value = textOf(block.text);
          if (value !== '') blocks.push({ type: 'text', text: value });
          continue;
        }
        if (block.type === 'thinking') {
          const value = textOf(block.thinking) || textOf(block.text);
          if (value !== '') blocks.push({ type: 'reasoning', text: value });
          continue;
        }
        if (block.type === 'tool_use') {
          blocks.push({ type: 'tool-call', id: textOf(block.id), name: textOf(block.name), arguments: block.input });
          continue;
        }
        if (block.type === 'image') blocks.push({ type: 'image' });
      }
      if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks, at });
      return;
    }
    if (record.type === 'user') {
      if (record.isMeta === true) return;
      if (record.isSidechain === true && includeSidechains !== true) return;
      const content = record.message?.content;
      const toolResults = [];
      const texts = [];
      if (typeof content === 'string') texts.push(content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue;
          if (block.type === 'text') texts.push(textOf(block.text));
          else if (block.type === 'tool_result') toolResults.push(block);
          else if (block.type === 'image') texts.push('[image omitted]');
        }
      }
      for (const block of toolResults) {
        const callId = textOf(block.tool_use_id);
        if (callId === '') continue;
        let text = '';
        if (typeof block.content === 'string') text = block.content;
        else if (Array.isArray(block.content)) {
          text = block.content
            .filter((part) => part?.type === 'text')
            .map((part) => textOf(part.text))
            .join('\n');
        } else if (block.content !== undefined && block.content !== null) {
          text = JSON.stringify(block.content);
        }
        messages.push({ role: 'tool', callId, text, isError: block.is_error === true, at });
      }
      const text = texts.join('\n\n').trim();
      if (text !== '') {
        if (firstPrompt === '' && toolResults.length === 0) firstPrompt = text;
        messages.push({ role: 'user', text, at });
      }
    }
    /* system, summary, queue-operation, attachment and last-prompt records are bookkeeping */
  });

  const provider = model.toLowerCase().includes('claude') ? 'anthropic' : 'claude-code';
  return {
    source: id,
    label,
    foreignId: textOf(ref?.id),
    title: title || firstPrompt.split('\n')[0]?.slice(0, 80) || '',
    cwd,
    createdAt: createdAt ?? Date.now(),
    model: { provider, model },
    messages,
  };
}

/**
 * Sessions spawned inside one session.
 *
 * Claude Code keeps each spawned run as its own JSON-lines file under
 * `<project>/<session>/subagents/`, optionally nested one level deeper for
 * workflows. The file name carries the agent id, so the reference is stable.
 *
 * @param ref - the parent session reference (its `.jsonl` path).
 * @returns child references, oldest first.
 */
export async function childSessions(ref) {
  const parentPath = textOf(ref?.path);
  if (parentPath === '' || !parentPath.endsWith('.jsonl')) return [];
  const sessionDir = join(parentPath.slice(0, -'.jsonl'.length), 'subagents');
  const files = [];
  const walk = async (directory, depth) => {
    if (depth > 3) return;
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
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const info = await stat(path).catch(() => undefined);
      files.push({ path, name: entry.name, updatedAt: info?.mtimeMs ?? 0 });
    }
  };
  await walk(sessionDir, 0);
  files.sort((left, right) => left.updatedAt - right.updatedAt);
  return files.map((file) => ({
    source: id,
    id: `${textOf(ref?.id)}#${file.name.replace(/\.jsonl$/u, '')}`,
    title: file.name.replace(/^agent-|\.jsonl$/gu, ''),
    cwd: textOf(ref?.cwd),
    path: file.path,
    parentId: textOf(ref?.id),
    child: true,
    childKind: 'subagent',
    includeSidechains: true,
  }));
}

/**
 * Transcripts to fold into the parent as context.
 * @param ref - the parent session reference.
 * @returns one context per spawned run found on disk.
 */
export async function readContext(ref) {
  const contexts = [];
  for (const child of await childSessions(ref)) {
    let transcript;
    try {
      transcript = await readSession(child);
    } catch {
      continue;
    }
    if (!Array.isArray(transcript?.messages) || transcript.messages.length === 0) continue;
    contexts.push({
      title: textOf(child.title) || 'subagent',
      foreignId: child.id,
      childKind: 'subagent',
      messages: transcript.messages,
    });
  }
  return contexts;
}


