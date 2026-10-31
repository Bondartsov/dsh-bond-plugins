/**
 * Read-only SQLite access for the foreign session stores.
 *
 * The Host process is Electron, so `node:sqlite` may be absent there. The fast
 * path uses it in-process when it exists; otherwise the same query runs inside
 * the DSH-bundled Node runtime, which ships `node:sqlite`. Both paths open the
 * database with `readOnly: true`: a foreign store is never written.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The runtime-side reader, executed only when the in-process module is missing. */
const READER = fileURLToPath(new URL('./sqlite-reader.mjs', import.meta.url));

/** `undefined` until probed, `null` when unavailable, the module otherwise. */
let inProcess;

/** Probe the in-process module once. */
async function loadInProcess() {
  if (inProcess !== undefined) return inProcess;
  try {
    inProcess = await import('node:sqlite');
  } catch {
    inProcess = null;
  }
  return inProcess;
}

/** Whether the fast in-process path is available. */
export async function sqliteInProcessAvailable() {
  return (await loadInProcess())?.DatabaseSync !== undefined;
}

/** Candidate Node executables that ship `node:sqlite`. */
function runtimeNodeCandidates() {
  const candidates = [];
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const runtimes = join(home, 'dsh-runtimes');
  try {
    for (const entry of readdirSync(runtimes)) {
      candidates.push(join(runtimes, entry, 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'));
    }
  } catch {
    /* no DSH runtime tree: fall back to the executable and PATH */
  }
  const executable = process.execPath;
  if (typeof executable === 'string' && /node(\.exe)?$/iu.test(executable)) candidates.push(executable);
  candidates.push(process.platform === 'win32' ? 'node.exe' : 'node');
  return candidates;
}

/** Run one payload in a child process and parse its JSON answer. */
function runReader(nodePath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      nodePath,
      [READER],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${error.message}${stderr === '' ? '' : `: ${String(stderr).trim().slice(0, 400)}`}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`sqlite reader returned unparsable output: ${String(parseError)}`));
        }
      },
    );
    child.on('error', (error) => reject(error));
    if (child.stdin !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    }
  });
}

/** Query through the bundled runtime Node. */
async function queryViaRuntime(dbPath, sql, params, options) {
  const timeoutMs = Number.isSafeInteger(options?.timeoutMs) ? options.timeoutMs : 30_000;
  const tried = [];
  for (const candidate of runtimeNodeCandidates()) {
    if (candidate.includes(join('dependencies', 'node', 'bin')) && !existsSync(candidate)) {
      tried.push(`${candidate}: missing`);
      continue;
    }
    try {
      return await runReader(candidate, { db: dbPath, sql, params }, timeoutMs);
    } catch (error) {
      tried.push(`${candidate}: ${error?.message ?? String(error)}`);
    }
  }
  throw new Error(`no SQLite reader available (${tried.join('; ')})`);
}

/**
 * Run one read-only query and return its rows.
 * @param dbPath - absolute database path.
 * @param sql - one statement without parameters interpolation hazards.
 * @param params - bound values.
 * @param options - `{timeoutMs}`.
 * @returns rows as plain objects.
 */
export async function querySqlite(dbPath, sql, params = [], options = {}) {
  const module = await loadInProcess();
  if (module?.DatabaseSync !== undefined) {
    const database = new module.DatabaseSync(dbPath, { readOnly: true });
    try {
      const statement = database.prepare(sql);
      return statement.all(...params).map((row) => ({ ...row }));
    } finally {
      database.close();
    }
  }
  const rows = await queryViaRuntime(dbPath, sql, params, options);
  if (!Array.isArray(rows)) throw new Error('sqlite reader returned a non-array result');
  return rows.map((row) => ({ ...row }));
}

/** Column names of one table, so a query adapts to a store's actual schema. */
export async function tableColumns(dbPath, table) {
  const rows = await querySqlite(dbPath, `PRAGMA table_info(${JSON.stringify(table)})`);
  return rows.map((row) => String(row.name ?? '')).filter((name) => name !== '');
}

/** Whether one table exists. */
export async function tableExists(dbPath, table) {
  const rows = await querySqlite(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return rows.length > 0;
}

/** Escape a value for a LIKE pattern, then wrap it in wildcards. */
export function likePattern(query) {
  return `%${String(query ?? '').replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;
}
