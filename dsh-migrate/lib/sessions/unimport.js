/**
 * Removing an imported copy.
 *
 * "Un-import" reverses one import: the artifact leaves the live store, the ledger
 * row is forgotten so the foreign session can be imported again, and the file is
 * kept in quarantine — never deleted.
 *
 * ## Why this file is defensive
 *
 * On 06.11.2026 a bulk call of an earlier version carried **609 artifacts** out of
 * `~/.dsh/sessions`, including the owner's own live sessions. Three mistakes made
 * that possible, and each one is now impossible by construction:
 *
 * 1. **No ownership proof.** The ledger row was looked up but not required, so any
 *    `sessionId` was archived and moved. Now a missing row means `refused` — the id
 *    may be the owner's own session.
 * 2. **Wrong order.** The row was forgotten *before* the file was moved; a repeated
 *    call then had no ownership proof left. Now the file moves first, and the row is
 *    forgotten only after the move succeeded.
 * 3. **All-or-nothing batch.** A batch was applied item by item with no review step.
 *    Now every id is validated up front (`dryRun` reports the full plan), and a batch
 *    larger than `MAX_BATCH` needs an explicit `confirm`.
 *
 * A quarantine entry also carries a manifest with the original project folder, so a
 * mistaken move can be undone mechanically instead of by hand.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { forgetImport, listImports } from './ledger.js';
import { sessionDirectory } from './reimport.js';
import { agentImportDir } from './paths.js';

/** A batch above this size is treated as a bulk operation and needs `confirm`. */
export const MAX_BATCH = 50;

/** Await a maybe-promise service answer. */
async function calm(value) {
  try {
    return await value;
  } catch {
    return undefined;
  }
}

/** Where removed copies are kept. */
export function quarantineDir() {
  return join(agentImportDir(), 'quarantine');
}

/** The project directory that physically held the artifact, for a mechanical restore. */
function projectFolderOf(directory) {
  if (typeof directory !== 'string' || directory === '') return '';
  const parts = directory.split(/[\\/]/u).filter((part) => part !== '');
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/**
 * Remove one imported copy.
 *
 * @param ctx - the Host context.
 * @param sessionId - the DSH session id of the copy.
 * @param options - `{dryRun, batch}`.
 * @returns `{sessionId, status: 'removed'|'dry-run'|'refused'|'failed', archived,
 *   ledgerForgotten, quarantinedTo, projectFolder, reason}`.
 */
export async function unimportSession(ctx, sessionId, options = {}) {
  const dry = options.dryRun === true;
  const batch = typeof options.batch === 'string' && options.batch !== '' ? options.batch : 'manual';
  const entry = listImports().find((row) => row.sessionId === sessionId);
  const base = {
    sessionId,
    status: 'failed',
    archived: false,
    ledgerForgotten: false,
    quarantinedTo: '',
    projectFolder: '',
    reason: '',
  };

  // Gate 1: the ledger row is the proof that this plugin created the copy. Without
  // it the id may be one of the owner's own sessions — refuse before any write.
  if (entry === undefined) {
    return {
      ...base,
      status: 'refused',
      reason: 'сессия не числится в журнале импорта — убирать её нельзя: возможно, это ваша собственная сессия',
    };
  }

  const directory = await sessionDirectory(sessionId);
  const projectFolder = projectFolderOf(directory);
  const target = join(quarantineDir(), batch, sessionId);

  if (dry === true) {
    return {
      ...base,
      status: 'dry-run',
      quarantinedTo: target,
      projectFolder,
      reason: directory === undefined ? 'артефакта нет в store — переносить нечего' : '',
    };
  }

  // Step 1 (first, so a crash cannot leave the copy without an ownership proof):
  // move the artifact out of the live store into quarantine.
  let quarantinedTo = '';
  if (directory !== undefined && existsSync(directory)) {
    if (existsSync(target)) {
      return { ...base, status: 'failed', reason: 'в карантине уже есть запись с таким id — не перезаписываю' };
    }
    mkdirSync(join(quarantineDir(), batch), { recursive: true });
    renameSync(directory, target);
    quarantinedTo = target;
    try {
      writeFileSync(
        join(join(quarantineDir(), batch), `${sessionId}.manifest.json`),
        `${JSON.stringify({ sessionId, projectFolder, source: entry.source, foreignId: entry.foreignId, title: entry.title, movedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      /* the manifest is a convenience for restore; the copy itself matters */
    }
  }

  // Step 2: forget the row — only when nothing was left behind in the store.
  let ledgerForgotten = false;
  if (directory === undefined || quarantinedTo !== '') {
    await calm(forgetImport(String(entry.source ?? ''), String(entry.foreignId ?? '')));
    ledgerForgotten = true;
  }

  // Step 3: hide it from the session list.
  let archived = false;
  const workspace = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
  if (workspace !== undefined && workspace !== null && typeof workspace.archiveSession === 'function') {
    await calm(workspace.archiveSession(sessionId, {}));
    archived = true;
  }

  const ok = quarantinedTo !== '' || directory === undefined;
  return {
    ...base,
    status: ledgerForgotten === true && (quarantinedTo !== '' || directory === undefined) ? 'removed' : 'failed',
    archived,
    ledgerForgotten,
    quarantinedTo,
    projectFolder,
    reason: quarantinedTo === '' && directory !== undefined ? 'артефакт не удалось перенести в карантин' : '',
  };
}

/**
 * Remove many copies, validating the whole plan before touching anything.
 *
 * @param ctx - the Host context.
 * @param sessionIds - the DSH session ids to remove.
 * @param options - `{dryRun, batch, confirm}`; a batch above `MAX_BATCH` is refused
 *   without `confirm: true`.
 * @returns `{results[], summary:{total,removed,dryRun,refused,failed}}`.
 */
export async function unimportSessions(ctx, sessionIds, options = {}) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : []).map(String).filter((id) => id !== '');
  const bulk = ids.length > MAX_BATCH;
  if (bulk && options.confirm !== true) {
    return {
      results: [],
      summary: { total: ids.length, removed: 0, dryRun: 0, refused: ids.length, failed: 0 },
      refused: true,
      reason: `массовое удаление (${ids.length} > ${MAX_BATCH}) требует явного confirm: true`,
    };
  }
  const results = [];
  const tally = { removed: 0, dryRun: 0, refused: 0, failed: 0 };
  for (const sessionId of ids) {
    const result = await unimportSession(ctx, sessionId, options);
    results.push(result);
    tally[result.status === 'removed' ? 'removed' : result.status === 'dry-run' ? 'dryRun' : result.status === 'refused' ? 'refused' : 'failed'] += 1;
  }
  return { results, summary: { total: ids.length, ...tally } };
}

/** Ledger rows created inside a time window — the only safe selection for a bulk undo. */
export function importsBetween(sinceMs, untilMs = Date.now()) {
  return listImports()
    .filter((row) => Number.isSafeInteger(row.importedAt) && row.importedAt >= sinceMs && row.importedAt < untilMs)
    .map((row) => ({ sessionId: row.sessionId, source: row.source, foreignId: row.foreignId, title: row.title, importedAt: row.importedAt }));
}

/**
 * Restore quarantined copies back into the store using their manifests.
 *
 * @param options - `{batch, dryRun}`: which quarantine bucket to restore.
 * @returns `{restored[], summary:{total,restored,skipped,failed}}`.
 */
export async function restoreQuarantine(options = {}) {
  const batch = typeof options.batch === 'string' && options.batch !== '' ? options.batch : 'manual';
  const root = join(quarantineDir(), batch);
  const dry = options.dryRun === true;
  const results = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { results: [], summary: { total: 0, restored: 0, skipped: 0, failed: 0 } };
  }
  const storeRoot = join(agentImportDir(), '..', 'sessions');
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue;
    const sessionId = entry.name;
    const manifestPath = join(root, `${sessionId}.manifest.json`);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      results.push({ sessionId, status: 'skipped', reason: 'нет манифеста — неизвестно, куда возвращать' });
      continue;
    }
    const destination = join(storeRoot, String(manifest.projectFolder ?? ''), sessionId);
    if (manifest.projectFolder === undefined || manifest.projectFolder === '') {
      results.push({ sessionId, status: 'skipped', reason: 'в манифесте нет папки проекта' });
      continue;
    }
    if (dry === true) {
      results.push({ sessionId, status: 'dry-run', to: destination });
      continue;
    }
    if (existsSync(destination)) {
      results.push({ sessionId, status: 'skipped', reason: 'в store уже есть сессия с таким id' });
      continue;
    }
    try {
      mkdirSync(join(storeRoot, String(manifest.projectFolder)), { recursive: true });
      renameSync(join(root, sessionId), destination);
      rmSync(manifestPath, { force: true });
      results.push({ sessionId, status: 'restored', to: destination });
    } catch (error) {
      results.push({ sessionId, status: 'failed', reason: String(error?.message ?? error) });
    }
  }
  return {
    results,
    summary: {
      total: results.length,
      restored: results.filter((row) => row.status === 'restored').length,
      skipped: results.filter((row) => row.status === 'skipped').length,
      failed: results.filter((row) => row.status === 'failed').length,
    },
  };
}
/** Which workspace holds a session — the read-only answer to «где моя сессия». */
export async function whereIsSession(ctx, sessionId) {
  const { findWorkspaceOfSession } = await import('./attach.js');
  const workspace = await findWorkspaceOfSession(ctx, sessionId);
  return { sessionId, workspace: workspace ?? null };
}