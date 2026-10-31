/**
 * Putting an imported session into the workspace (project folder) of its cwd.
 *
 * DSH groups the session list by the workspace registry: a session that is not
 * in any workspace's `sessionIds` shows up as **Ungrouped**, even when its own
 * `identity.cwd` names a project. An import normally attaches itself (see
 * `attachToWorkspace` in `import.js`), but a session imported by a predecessor
 * install — or an import whose attach step failed — needs the same action later.
 * That is what this module and the `POST /dsh-migrate/sessions/attach` route do.
 *
 * The registry is the only writer: this module never edits `workspace.json`.
 */
import { basename } from 'node:path';

import { attachToWorkspace } from './import.js';

/** Await a possibly-synchronous service answer. */
async function settle(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function' ? await value : value;
}

/** Resolve one optional Host service. */
function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** Human title of one workspace entry. */
function titleOf(workspace, fallback) {
  if (workspace !== null && typeof workspace === 'object') {
    if (typeof workspace.title === 'string' && workspace.title !== '') return workspace.title;
    if (typeof workspace.name === 'string' && workspace.name !== '') return workspace.name;
    if (typeof workspace.path === 'string' && workspace.path !== '') return basename(workspace.path) || workspace.path;
  }
  return fallback;
}

/** Path of one workspace entry. */
function pathOf(workspace, fallback) {
  if (workspace !== null && typeof workspace === 'object' && typeof workspace.path === 'string' && workspace.path !== '') return workspace.path;
  return fallback;
}

/** Whether one workspace already lists the session. */
export function workspaceHasSession(workspace, sessionId) {
  if (workspace === null || typeof workspace !== 'object') return false;
  if (typeof workspace.hasSession === 'function') {
    try {
      if (workspace.hasSession(sessionId) === true) return true;
    } catch {
      /* fall through to the list fields */
    }
  }
  for (const field of ['sessionIds', 'sessionIdList', 'sessions']) {
    const value = workspace[field];
    if (!Array.isArray(value)) continue;
    if (value.some((entry) => entry === sessionId || entry?.id === sessionId || entry?.sessionId === sessionId)) return true;
  }
  return false;
}

/** The registry's workspaces, or `undefined` when the service is absent. */
export async function listWorkspaces(ctx) {
  const registry = serviceOf(ctx, 'workspaceRegistry');
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return undefined;
  try {
    const value = await settle(registry.list());
    return Array.isArray(value) ? value : [];
  } catch {
    return undefined;
  }
}

/** The workspace already holding one session, or `undefined`. */
export async function findWorkspaceOfSession(ctx, sessionId) {
  const workspaces = await listWorkspaces(ctx);
  if (workspaces === undefined) return undefined;
  return workspaces.find((workspace) => workspaceHasSession(workspace, sessionId));
}

/**
 * The cwd of a stored session, read without taking ownership.
 *
 * `sessionPersistence.stat` is the cheapest seam; `sessionQuery.readSession` is
 * the fallback for a store that does not publish it.
 */
export async function resolveSessionCwd(ctx, sessionId) {
  const persistence = serviceOf(ctx, 'sessionPersistence');
  if (persistence !== undefined && persistence !== null && typeof persistence.stat === 'function') {
    try {
      const snapshot = await settle(persistence.stat(sessionId));
      const cwd = snapshot?.header?.cwd;
      if (typeof cwd === 'string') return cwd;
    } catch {
      /* try the query seam */
    }
  }
  const query = serviceOf(ctx, 'sessionQuery');
  if (query !== undefined && query !== null && typeof query.readSession === 'function') {
    try {
      const log = await settle(query.readSession(sessionId));
      const cwd = log?.session?.cwd ?? log?.header?.cwd;
      if (typeof cwd === 'string') return cwd;
    } catch {
      /* nothing readable */
    }
  }
  return '';
}

/**
 * Attach one stored session to the workspace of its own cwd.
 *
 * Idempotent: a session already listed by a workspace reports `already` and the
 * registry is not touched.
 *
 * @param ctx - the Host context.
 * @param sessionId - the DSH session id.
 * @param options - `{cwd, title, attach}`; `attach` is the importer's
 *   `attachToWorkspace` (injectable for tests).
 * @returns `{sessionId, status: 'attached'|'already'|'failed', workspaceTitle, workspacePath, reason}`.
 */
export async function attachSessionToWorkspace(ctx, sessionId, options = {}) {
  const id = String(sessionId ?? '');
  if (id === '') throw new Error('attach needs a session id');
  const registry = serviceOf(ctx, 'workspaceRegistry');
  if (registry === undefined || registry === null) {
    return { sessionId: id, status: 'failed', workspaceTitle: '', workspacePath: '', reason: 'workspaceRegistry is unavailable in this composition' };
  }

  const existing = await findWorkspaceOfSession(ctx, id);
  if (existing !== undefined && existing !== null) {
    return { sessionId: id, status: 'already', workspaceTitle: titleOf(existing, ''), workspacePath: pathOf(existing, ''), reason: '' };
  }

  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : await resolveSessionCwd(ctx, id);
  if (cwd === '') {
    return { sessionId: id, status: 'failed', workspaceTitle: '', workspacePath: '', reason: 'у сессии не записан каталог проекта (cwd пуст)' };
  }

  const attach = typeof options.attach === 'function' ? options.attach : attachToWorkspace;
  const attachment = await attach(ctx, { id, cwd }, String(options.title ?? ''));
  if (attachment?.attached === true) {
    return {
      sessionId: id,
      status: 'attached',
      workspaceTitle: String(attachment.workspaceTitle ?? titleOf(undefined, basename(cwd) || cwd)),
      workspacePath: String(attachment.workspacePath ?? cwd),
      reason: '',
    };
  }
  return {
    sessionId: id,
    status: 'failed',
    workspaceTitle: '',
    workspacePath: '',
    reason: String(attachment?.reason ?? 'workspace attach failed'),
  };
}

/**
 * Attach a list of sessions and summarise the outcome.
 * @param ctx - the Host context.
 * @param sessionIds - the ids to attach.
 * @param options - `{attach, cwdById}`.
 */
export async function attachSessions(ctx, sessionIds, options = {}) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : []).map(String).filter((id) => id !== '');
  const items = [];
  for (const sessionId of ids) {
    try {
      const cwd = options.cwdById?.[sessionId];
      items.push(await attachSessionToWorkspace(ctx, sessionId, { ...options, cwd: typeof cwd === 'string' ? cwd : undefined }));
    } catch (error) {
      items.push({ sessionId, status: 'failed', workspaceTitle: '', workspacePath: '', reason: String(error?.message ?? error) });
    }
  }
  return {
    items,
    summary: {
      requested: ids.length,
      attached: items.filter((item) => item.status === 'attached').length,
      already: items.filter((item) => item.status === 'already').length,
      failed: items.filter((item) => item.status === 'failed').length,
    },
  };
}
