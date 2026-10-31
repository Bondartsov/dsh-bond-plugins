/**
 * Import ledger: what this plugin already did.
 *
 * The ledger is what makes a repeat run honest rather than destructive: an entry
 * records the applied action per item, so the panel can say "уже есть", the run
 * route can skip instead of copying, and the owner can see the history.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assetsImportDir, legacyAssetsImportDir } from './paths.js';

/** Ledger format version; a different version is re-read as empty. */
export const LEDGER_VERSION = 1;

/** Runs kept in the history. */
const MAX_RUNS = 25;

/** Absolute path of the ledger file. */
export function ledgerPath() {
  return join(assetsImportDir(), 'assets-ledger.json');
}

/** Ledger file of the predecessor plugin; read once, never written. */
export function legacyLedgerPath() {
  return join(legacyAssetsImportDir(), 'ledger.json');
}

/** An empty ledger. */
function emptyLedger() {
  return { version: LEDGER_VERSION, entries: {}, runs: [] };
}

/** Parse one ledger file, tolerating a missing or broken one. */
async function parseLedgerFile(path) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed?.version !== LEDGER_VERSION) return undefined;
    return {
      version: LEDGER_VERSION,
      entries: parsed?.entries !== null && typeof parsed?.entries === 'object' ? parsed.entries : {},
      runs: Array.isArray(parsed?.runs) ? parsed.runs : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Read the ledger, tolerating a missing or broken file.
 *
 * The predecessor's ledger is the fallback so items imported before the merge
 * remain idempotent; every write goes to the unified file, same format.
 *
 * @param path - override for tests.
 * @returns the ledger object, never `undefined`.
 */
export async function readLedger(path = ledgerPath()) {
  const own = await parseLedgerFile(path);
  if (own !== undefined) return own;
  if (path !== ledgerPath()) return emptyLedger();
  return (await parseLedgerFile(legacyLedgerPath())) ?? emptyLedger();
}

/**
 * Write the ledger atomically.
 * @param ledger - the ledger object.
 * @param path - override for tests.
 */
export async function writeLedger(ledger, path = ledgerPath()) {
  await mkdir(join(assetsImportDir()), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(temporary, path);
}

/**
 * Record the result of one item.
 * @param ledger - ledger to mutate.
 * @param key - `${type}:${source}:${name}`.
 * @param entry - `{ action, target, backupPath, at }`.
 */
export function recordEntry(ledger, key, entry) {
  ledger.entries[key] = {
    action: entry.action,
    target: entry.target ?? '',
    backupPath: entry.backupPath ?? '',
    appliedAt: entry.at ?? Date.now(),
  };
  return ledger;
}

/**
 * Append one run to the history and keep it bounded.
 * @param ledger - ledger to mutate.
 * @param run - `{ at, summary, items }`.
 */
export function recordRun(ledger, run) {
  ledger.runs.unshift({
    at: run.at ?? Date.now(),
    summary: run.summary ?? {},
    items: Array.isArray(run.items)
      ? run.items.map((item) => ({ id: item.id ?? '', action: item.action ?? '', reason: item.reason ?? '' }))
      : [],
  });
  ledger.runs = ledger.runs.slice(0, MAX_RUNS);
  return ledger;
}

/** A compact status view for the panel header and the `status` route. */
export function summarizeLedger(ledger) {
  const byAction = {};
  const byType = {};
  for (const [key, entry] of Object.entries(ledger.entries ?? {})) {
    const [type] = key.split(':');
    byAction[entry.action ?? 'unknown'] = (byAction[entry.action ?? 'unknown'] ?? 0) + 1;
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return {
    total: Object.keys(ledger.entries ?? {}).length,
    byAction,
    byType,
    runs: Array.isArray(ledger.runs) ? ledger.runs.length : 0,
    lastRun: Array.isArray(ledger.runs) && ledger.runs.length > 0 ? ledger.runs[0] : null,
  };
}
