/**
 * Re-importing a session whose DSH copy cannot be updated in place.
 *
 * Two modes, and the difference is what happens to the existing copy:
 *
 *  - `copy` (default, non-destructive): the origin is imported into a NEW session
 *    id, the ledger row moves to it with fresh watermarks, and the old copy is
 *    ARCHIVED — hidden from the active list, its data untouched. An open session
 *    is no obstacle: nothing is deleted, so the owner never has to close it.
 *  - `replace` (explicit only): the old artifact is deleted and the session is
 *    rebuilt under its deterministic id. This is destructive, needs
 *    `confirm:true` from the route, and refuses while the session is open.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { importForeign, sessionIdFor } from './import.js';
import { findImport, forgetImport } from './ledger.js';
import { dshHome } from './paths.js';

/**
 * Locate the stored directory of one session across the per-project folders.
 *
 * DSH lays sessions out as `<sessions>/<encoded-cwd>/<sessionId>/`; this scans
 * the first level instead of re-encoding a path, so it cannot disagree with the
 * store about how a directory name is spelled.
 *
 * @param sessionId - the session id from the ledger.
 * @param options - `{sessionsRoot}` override for tests.
 * @returns the absolute directory, or `undefined` when the session has no artifact.
 */
export async function sessionDirectory(sessionId, options = {}) {
  const id = String(sessionId ?? '');
  if (id === '') return undefined;
  const root = resolve(options.sessionsRoot ?? join(dshHome(), 'sessions'));
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const matches = [];
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue;
    const candidate = resolve(join(root, entry.name, id));
    // A directory named like the id must stay inside the session root.
    if (!candidate.startsWith(`${root}\\`) && !candidate.startsWith(`${root}/`)) continue;
    const candidateStat = await stat(candidate).catch(() => undefined);
    if (candidateStat?.isDirectory() === true) matches.push(candidate);
  }
  if (matches.length > 1) throw new Error(`сессия ${id} найдена в нескольких папках проектов — удаление небезопасно`);
  return matches[0];
}

/** Resolve one optional Host service. */
function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** Await a possibly-synchronous service answer. */
async function settle(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function' ? await value : value;
}

/** Whether the session is open in this process right now (deleting it would be unsafe). */
function isLive(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions');
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return false;
  try {
    return sessions.get(sessionId) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Delete the imported copy of one session — the destructive half of `replace`.
 *
 * @param ctx - the Host context.
 * @param entry - the ledger record of this import.
 * @param options - `{sessionsRoot}`; the importer seam is not used here.
 * @returns `{sessionId, removed, path, archived}`.
 */
export async function deleteImportedCopy(ctx, entry, options = {}) {
  const sessionId = String(entry?.sessionId ?? '');
  if (sessionId === '') throw new Error('в журнале импорта нет идентификатора сессии — удалять нечего');
  if (isLive(ctx, sessionId)) {
    throw new Error('сессия открыта в DSH — разрушающий переимпорт невозможен; используйте переимпорт копией (mode=copy)');
  }

  let archived = false;
  const registry = serviceOf(ctx, 'workspaceRegistry');
  if (registry !== undefined && registry !== null && typeof registry.archiveSession === 'function') {
    try {
      await settle(registry.archiveSession(sessionId));
      archived = true;
    } catch {
      /* hiding is a convenience: the artifact removal below is what matters */
    }
  }

  const directory = await sessionDirectory(sessionId, options);
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  return { sessionId, removed: directory !== undefined, path: directory ?? '', archived };
}

/** Bring a session back into the workspace list (used by the replace path). */
async function unarchive(ctx, sessionId) {
  const registry = serviceOf(ctx, 'workspaceRegistry');
  if (registry === undefined || registry === null || typeof registry.unarchiveSession !== 'function') return false;
  try {
    await settle(registry.unarchiveSession(sessionId));
    return true;
  } catch {
    return false;
  }
}

/** Hide the previous copy after a non-destructive re-import. */
async function archivePrevious(ctx, sessionId) {
  const registry = serviceOf(ctx, 'workspaceRegistry');
  if (registry === undefined || registry === null || typeof registry.archiveSession !== 'function') {
    return { archived: false, reason: 'workspaceRegistry is unavailable' };
  }
  try {
    await settle(registry.archiveSession(sessionId));
    return { archived: true, reason: '' };
  } catch (error) {
    return { archived: false, reason: String(error?.message ?? error) };
  }
}

/** The fresh id of a copy: deterministic input, unique per re-import. */
export function copySessionIdFor(source, foreignId, previousSessionId, at = Date.now()) {
  return sessionIdFor(source, `${foreignId}@dsh-migrate-copy:${previousSessionId}:${at}`);
}

/**
 * Re-import one session.
 *
 * @param ctx - the Host context.
 * @param ref - `{source, id, path?}` of the foreign session.
 * @param options - `{mode: 'copy'|'replace', includeSubagents, sessionsRoot,
 *   importer, onProgress}`.
 * @returns `{status, mode, sessionId, previousSessionId, deleted, archived,
 *   archiveReason, warnings, report}`.
 */
export async function reimportSession(ctx, ref, options = {}) {
  const source = String(ref?.source ?? '');
  const foreignId = String(ref?.id ?? '');
  if (source === '' || foreignId === '') throw new Error('переимпорт требует source и id');

  const entry = findImport(source, foreignId);
  const importer = typeof options.importer === 'function' ? options.importer : importForeign;
  const mode = options.mode === 'replace' ? 'replace' : 'copy';
  const warnings = [];

  if (mode === 'replace') {
    let removed = { sessionId: String(entry?.sessionId ?? sessionIdFor(source, foreignId)), removed: false, path: '', archived: false };
    if (entry !== undefined) {
      removed = await deleteImportedCopy(ctx, entry, options);
      if (removed.removed !== true) warnings.push('файл сессии не найден — журнал всё равно сброшен, импорт выполняется заново');
      await forgetImport(source, foreignId);
    } else {
      warnings.push('записи в журнале нет — выполняется обычный первый импорт');
    }
    const report = await importer(ctx, { source, id: foreignId, path: ref?.path }, {
      force: true,
      includeSubagents: options.includeSubagents === true,
      onProgress: options.onProgress,
    });
    const sessionId = String(report?.sessionId ?? removed.sessionId);
    const unarchived = removed.archived === true ? await unarchive(ctx, sessionId) : false;
    if (removed.archived === true && unarchived !== true) warnings.push('сессия осталась в архиве — верните её в список вручную');
    return {
      status: report?.status === 'already-imported' ? 'reimported-existing' : 'reimported',
      mode,
      sessionId,
      previousSessionId: removed.sessionId,
      deleted: removed.removed === true,
      archived: removed.archived === true,
      archiveReason: '',
      unarchived,
      turns: Number.isSafeInteger(report?.turnCount) ? report.turnCount : 0,
      warnings,
      report,
    };
  }

  // Non-destructive copy: nothing is deleted, so an open session is no obstacle.
  const previousSessionId = String(entry?.sessionId ?? '');
  const requestedSessionId = previousSessionId === '' ? sessionIdFor(source, foreignId) : copySessionIdFor(source, foreignId, previousSessionId);
  const report = await importer(ctx, { source, id: foreignId, path: ref?.path }, {
    force: true,
    includeSubagents: options.includeSubagents === true,
    onProgress: options.onProgress,
    sessionId: requestedSessionId,
  });
  const sessionId = String(report?.sessionId ?? requestedSessionId);
  let archived = false;
  let archiveReason = '';
  if (previousSessionId !== '' && previousSessionId !== sessionId) {
    const result = await archivePrevious(ctx, previousSessionId);
    archived = result.archived;
    archiveReason = result.reason;
    if (archived !== true) warnings.push(`старая копия осталась в списке: ${archiveReason}`);
  }
  return {
    status: report?.status === 'already-imported' ? 'reimported-existing' : 'reimported',
    mode,
    sessionId,
    previousSessionId,
    deleted: false,
    archived,
    archiveReason,
    turns: Number.isSafeInteger(report?.turnCount) ? report.turnCount : 0,
    warnings,
    report,
  };
}
