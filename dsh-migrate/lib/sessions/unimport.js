/**
 * Removing an imported copy.
 *
 * "Un-import" is the reverse of import: the copy is archived (it stays on disk),
 * the ledger row is forgotten so the foreign session can be imported again like a
 * fresh one, and the artifact is moved into a quarantine folder instead of being
 * deleted. Nothing is destroyed without the owner asking for it.
 */
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { findImport, forgetImport, listImports } from './ledger.js';
import { sessionDirectory } from './reimport.js';
import { agentImportDir } from './paths.js';

/** Settle a maybe-promise value the same way the rest of the plugin does. */
async function calm(value) {
  try {
    return await value;
  } catch {
    return undefined;
  }
}

/**
 * Where the quarantine for removed copies lives.
 * @returns the quarantine directory path.
 */
export function quarantineDir() {
  return join(agentImportDir(), 'quarantine');
}

/**
 * Remove one imported copy: archive, forget the ledger row, quarantine the file.
 *
 * @param ctx - the Host context.
 * @param sessionId - the DSH session id of the copy.
 * @param options - `{dryRun}`: report what would happen without touching anything.
 * @returns `{sessionId, status: 'removed'|'dry-run'|'failed', archived, ledgerForgotten, quarantinedTo?, reason?}`.
 */
export async function unimportSession(ctx, sessionId, options = {}) {
  const dry = options.dryRun === true;
  const entry = listImports().find((row) => row.sessionId === sessionId);
  const source = String(entry?.source ?? '');
  const foreignId = String(entry?.foreignId ?? '');
  const base = { sessionId, status: 'failed', archived: false, ledgerForgotten: false, quarantinedTo: '' };

  // SAFETY GATE. Un-import may only touch a copy this plugin imported: the ledger
  // row is the proof of ownership. Without it the id may be the owner's own
  // session, and archiving or moving it would destroy real work — exactly the
  // incident of 06.11.2026, when an empty ledger let a bulk call carry 609
  // artifacts (including live sessions) into quarantine. Refuse before any write.
  if (entry === undefined) {
    return {
      ...base,
      status: 'refused',
      reason: 'эта сессия не числится в журнале импорта — убирать её нельзя: возможно, это ваша собственная сессия',
    };
  }

  // 1. Hide the copy from the session list: archive it in the workspace registry.
  let archived = false;
  const workspace = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
  if (workspace !== undefined && workspace !== null && typeof workspace.archiveSession === 'function') {
    await calm(workspace.archiveSession(sessionId, {}));
    archived = true;
  }

  // 2. Forget the ledger row, so a later import of the same foreign session is a
  //    fresh import again instead of "already imported".
  let ledgerForgotten = false;
  if (entry !== undefined) {
    await calm(forgetImport(source, foreignId));
    ledgerForgotten = true;
  }

  // 3. Quarantine the artifact: out of the session store, still recoverable.
  let quarantinedTo = '';
  const dir = await sessionDirectory(sessionId);
  if (dir !== undefined && dir !== '' && existsSync(dir)) {
    const target = join(quarantineDir(), String(options.batch ?? 'manual'), sessionId);
    if (dry !== true) {
      mkdirSync(join(quarantineDir(), String(options.batch ?? 'manual')), { recursive: true });
      renameSync(dir, target);
    }
    quarantinedTo = target;
  } else if (dry !== true) {
    // No artifact on disk — the copy is already gone; the archive step above did the hiding.
  }

  const failed = archived === false && ledgerForgotten === false && quarantinedTo === '';
  return {
    ...base,
    status: dry === true ? 'dry-run' : failed === true ? 'failed' : 'removed',
    archived,
    ledgerForgotten,
    quarantinedTo,
    reason: dry === true ? '' : failed === true ? 'нечего убирать: нет ни архивации, ни записи журнала, ни файла' : '',
  };
}

/**
 * Remove many copies at once.
 *
 * @param ctx - the Host context.
 * * @param sessionIds - the DSH session ids to remove.
 * @param options - `{dryRun, batch}`: a batch name groups the quarantined files.
 * @returns `{results[], summary}`.
 */
export async function unimportSessions(ctx, sessionIds, options = {}) {
  const ids = Array.isArray(sessionIds) ? sessionIds.map(String).filter((id) => id !== '') : [];
  const results = [];
  const tally = { removed: 0, dryRun: 0, failed: 0 };
  for (const sessionId of ids.slice(0, 2000)) {
    const result = await unimportSession(ctx, sessionId, options);
    results.push(result);
    tally[result.status === 'removed' ? 'removed' : result.status === 'dry-run' ? 'dryRun' : 'failed'] += 1;
  }
  return { results, summary: { total: ids.length, ...tally } };
}

/**
 * The ledger rows that were created inside a time window — the safe way to undo a
 * bulk operation: only explicit identities are touched, never "everything".
 *
 * @param sinceMs - the inclusive start of the window (epoch ms).
 * @param untilMs - the exclusive end; defaults to now.
 * @returns ledger rows with `sessionId`, plus `source`/`foreignId` for the report.
 */
export function importsBetween(sinceMs, untilMs = Date.now()) {
  return listImports()
    .filter((row) => Number.isSafeInteger(row.importedAt) && row.importedAt >= sinceMs && row.importedAt < untilMs)
    .map((row) => ({ sessionId: row.sessionId, source: row.source, foreignId: row.foreignId, title: row.title, importedAt: row.importedAt }));
}

/** Find which workspace holds a session — the read-only diagnostic for "где моя сессия". */
export async function whereIsSession(ctx, sessionId) {
  const { findWorkspaceOfSession } = await import('./attach.js');
  const workspace = await findWorkspaceOfSession(ctx, sessionId);
  return { sessionId, workspace: workspace ?? null };
}
