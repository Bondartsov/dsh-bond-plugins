/**
 * The import ledger: which foreign session already became which DSH session.
 *
 * The ledger is the provenance record the user can inspect, and it is what makes
 * a second import a no-op instead of a duplicate session. It carries no
 * credentials and no message bodies — only identity and counters.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { agentImportDir, legacyAgentImportDir } from './paths.js';

const LEDGER_VERSION = 1;

/** In-memory copy, loaded once per Host process. */
let loaded;

/** Serializes writes so two concurrent imports cannot interleave. */
let saveChain = Promise.resolve();

/** Absolute path of the ledger file. */
export function ledgerPath() {
  return join(agentImportDir(), 'sessions-ledger.json');
}

/** Ledger file of the predecessor plugin; read once, never written. */
export function legacyLedgerPath() {
  return join(legacyAgentImportDir(), 'ledger.json');
}

/** Composite ledger key of one foreign session. */
export function ledgerKey(source, foreignId) {
  return `${source}:${foreignId}`;
}

/** Parse one ledger file, tolerating a missing or broken one. */
function readLedgerFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && parsed.imports !== null && typeof parsed.imports === 'object') return parsed;
  } catch {
    /* no ledger at this path, or it is unreadable */
  }
  return undefined;
}

/**
 * Read the ledger from disk once, tolerating a missing or broken file.
 *
 * The predecessor's ledger is the fallback: it is read into memory so sessions
 * imported before the merge stay recognised, while every new write goes to the
 * unified file. Both files use the same format.
 */
function load() {
  if (loaded !== undefined) return loaded;
  loaded = { version: LEDGER_VERSION, imports: {} };
  for (const path of [ledgerPath(), legacyLedgerPath()]) {
    const parsed = readLedgerFile(path);
    if (parsed === undefined) continue;
    loaded.imports = parsed.imports;
    loaded.version = Number.isSafeInteger(parsed.version) ? parsed.version : LEDGER_VERSION;
    break;
  }
  return loaded;
}

/** One recorded import, or `undefined`. */
export function findImport(source, foreignId) {
  const entry = load().imports[ledgerKey(source, foreignId)];
  return entry !== null && typeof entry === 'object' ? entry : undefined;
}

/** Every recorded import, newest first. */
export function listImports() {
  return Object.values(load().imports)
    .filter((entry) => entry !== null && typeof entry === 'object')
    .sort((left, right) => Number(right.importedAt ?? 0) - Number(left.importedAt ?? 0));
}

/** Summary counters used by the panel and the agent tool. */
export function ledgerSummary() {
  const imports = listImports();
  const bySource = {};
  for (const entry of imports) {
    const key = typeof entry.source === 'string' ? entry.source : 'unknown';
    bySource[key] = (bySource[key] ?? 0) + 1;
  }
  return { total: imports.length, bySource, imports: imports.slice(0, 50) };
}

/**
 * Record one successful import and persist the ledger.
 * @param entry - `{source, foreignId, sessionId, title, cwd, originalCwd, ...counters}`.
 * @returns the stored entry.
 */
export async function recordImport(entry) {
  const ledger = load();
  const record = {
    source: String(entry.source ?? ''),
    foreignId: String(entry.foreignId ?? ''),
    sessionId: String(entry.sessionId ?? ''),
    title: String(entry.title ?? ''),
    cwd: String(entry.cwd ?? ''),
    originalCwd: String(entry.originalCwd ?? ''),
    importedAt: Number.isSafeInteger(entry.importedAt) ? entry.importedAt : Date.now(),
    eventCount: Number.isSafeInteger(entry.eventCount) ? entry.eventCount : 0,
    turnCount: Number.isSafeInteger(entry.turnCount) ? entry.turnCount : 0,
    droppedCalls: Number.isSafeInteger(entry.droppedCalls) ? entry.droppedCalls : 0,
    droppedResults: Number.isSafeInteger(entry.droppedResults) ? entry.droppedResults : 0,
    // Source watermark: how much of the origin transcript this copy holds, so a
    // later update can append only what appeared since.
    foreignMessageCount: Number.isSafeInteger(entry.foreignMessageCount) ? entry.foreignMessageCount : 0,
    foreignPrefixHash: typeof entry.foreignPrefixHash === 'string' ? entry.foreignPrefixHash : '',
    verified: entry.verified === true,
    warnings: Array.isArray(entry.warnings) ? entry.warnings.map(String) : [],
  };
  ledger.imports[ledgerKey(record.source, record.foreignId)] = record;
  const body = JSON.stringify({ version: LEDGER_VERSION, imports: ledger.imports }, null, 2);
  const path = ledgerPath();
  saveChain = saveChain
    .then(async () => {
      mkdirSync(agentImportDir(), { recursive: true });
      const staging = `${path}.tmp`;
      await writeFile(staging, body, 'utf8');
      await rename(staging, path);
    })
    .catch(() => {
      /* the ledger is provenance, not a gate: a failed write never blocks an import that already committed */
    });
  await saveChain;
  return record;
}

/** Forget one recorded import (the DSH session itself is left untouched). */
export async function forgetImport(source, foreignId) {
  const ledger = load();
  const key = ledgerKey(source, foreignId);
  if (ledger.imports[key] === undefined) return false;
  delete ledger.imports[key];
  const body = JSON.stringify({ version: LEDGER_VERSION, imports: ledger.imports }, null, 2);
  const path = ledgerPath();
  saveChain = saveChain
    .then(async () => {
      mkdirSync(agentImportDir(), { recursive: true });
      const staging = `${path}.tmp`;
      await writeFile(staging, body, 'utf8');
      await rename(staging, path);
    })
    .catch(() => {});
  await saveChain;
  return true;
}
