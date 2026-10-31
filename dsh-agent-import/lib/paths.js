/**
 * Shared filesystem helpers for the import plugin.
 *
 * Every foreign agent keeps its own store under the user's home directory; the
 * plugin only ever reads there and only ever writes under the DSH home.
 */
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The per-user DSH home; the Host exports it, with a home-directory fallback for tests. */
export function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return join(homedir(), '.dsh');
}

/** Where this plugin keeps its own durable state (import ledger, proposals). */
export function agentImportDir() {
  return join(dshHome(), 'agent-import');
}

/** One directory inside the DSH home. */
export function dshPath(...segments) {
  return join(dshHome(), ...segments);
}

/** The user's home directory, resolved once. */
export function userHome() {
  return homedir();
}

/** Whether a path exists and is a directory. */
export async function directoryExists(path) {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path exists and is a regular file. */
export async function fileExists(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Stat a path, or `undefined` when it cannot be read. */
export async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/** Read a whole UTF-8 file, or `undefined` when it cannot be read. */
export async function readTextOrUndefined(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Read a JSON file, or `undefined` when it is missing or malformed. */
export async function readJsonOrUndefined(path) {
  const text = await readTextOrUndefined(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Read at most `count` bytes from the start of a file.
 * @param path - file path.
 * @param count - byte budget.
 * @returns the decoded text, possibly cut mid-line.
 */
export async function readHead(path, count) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
  }
}

/**
 * Read at most `count` bytes from the end of a file, starting at a line boundary
 * when one is found inside the window.
 * @param path - file path.
 * @param count - byte budget.
 * @returns the decoded text.
 */
export async function readTail(path, count) {
  let handle;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    const start = Math.max(0, info.size - count);
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start === 0) return text;
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(newline + 1);
  } catch {
    return '';
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
  }
}

/** Parse the complete JSON lines of one text window, skipping broken lines. */
export function parseJsonLines(text) {
  const records = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      /* a truncated head or tail window ends mid-line: the record is simply skipped */
    }
  }
  return records;
}

/**
 * Stream one JSON-lines file, invoking `visit` per parsed record.
 * @param path - file path.
 * @param visit - callback receiving `(record, index)`; return `false` to stop early.
 * @returns the number of records visited.
 */
export async function forEachJsonLine(path, visit) {
  let count = 0;
  let buffer = '';
  const stream = createReadStream(path, { encoding: 'utf8' });
  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line === '') continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        count += 1;
        if (visit(record, count - 1) === false) return count;
      }
    }
    const tail = buffer.trim();
    if (tail !== '') {
      try {
        count += 1;
        visit(JSON.parse(tail), count - 1);
      } catch {
        /* a torn final line is a crash tail, not a record */
      }
    }
  } finally {
    stream.destroy();
  }
  return count;
}

/** Sort newest first by a timestamp accessor. */
export function byNewest(accessor) {
  return (left, right) => (accessor(right) ?? 0) - (accessor(left) ?? 0);
}

/** Clamp a requested page size. */
export function clampLimit(value, fallback = 50, max = 500) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.floor(numeric), max);
}

/** Clamp a requested offset. */
export function clampOffset(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.floor(numeric);
}
