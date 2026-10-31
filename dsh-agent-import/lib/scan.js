/**
 * Discovery across every configured agent store.
 *
 * One scan asks each adapter for a page of sessions and returns the same shape
 * for all of them, plus a project grouping derived from the session `cwd`. A
 * source that is missing or unreadable is reported as unavailable with its own
 * reason: one broken store never hides the other four.
 */
import { clampLimit, clampOffset } from './paths.js';
import { SOURCES } from './sources/index.js';
import { ledgerSummary } from './ledger.js';

/** Session fields the panel and the tool expose. */
function publicSession(row, imported) {
  return {
    source: String(row.source ?? ''),
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    cwd: String(row.cwd ?? ''),
    updatedAt: Number.isSafeInteger(row.updatedAt) ? row.updatedAt : 0,
    sizeBytes: Number.isSafeInteger(row.sizeBytes) ? row.sizeBytes : 0,
    path: String(row.path ?? ''),
    importedSessionId: imported.get(`${row.source}:${row.id}`) ?? '',
    // A session spawned inside another session is context for its parent, not a
    // session of its own: the panel hides it by default and offers it as import
    // context instead.
    parentId: String(row.parentId ?? ''),
    child: row.child === true,
    childKind: String(row.childKind ?? ''),
  };
}

/** Group sessions into project rows by their directory. */
function groupProjects(sources) {
  const projects = new Map();
  for (const source of sources) {
    for (const session of source.sessions) {
      const path = session.cwd === '' ? '(no project recorded)' : session.cwd;
      const entry = projects.get(path) ?? { path, sessions: 0, sources: new Set(), updatedAt: 0 };
      entry.sessions += 1;
      entry.sources.add(session.source);
      entry.updatedAt = Math.max(entry.updatedAt, session.updatedAt ?? 0);
      projects.set(path, entry);
    }
  }
  return [...projects.values()]
    .map((entry) => ({ path: entry.path, sessions: entry.sessions, sources: [...entry.sources], updatedAt: entry.updatedAt }))
    .sort((left, right) => right.sessions - left.sessions || right.updatedAt - left.updatedAt);
}

/**
 * Scan every source.
 * @param options - `{limit, offset, query, sources}`; `sources` narrows the scan.
 * @returns `{sources, projects, ledger, generatedAt}`.
 */
export async function inventory(options = {}) {
  const limit = clampLimit(options.limit, 50, 500);
  const offset = clampOffset(options.offset);
  const query = typeof options.query === 'string' ? options.query : '';
  const wanted = Array.isArray(options.sources) && options.sources.length > 0 ? new Set(options.sources.map(String)) : undefined;
  const ledger = ledgerSummary();
  const imported = new Map(ledger.imports.map((entry) => [`${entry.source}:${entry.foreignId}`, entry.sessionId]));

  const results = [];
  for (const source of SOURCES) {
    if (wanted !== undefined && !wanted.has(source.id)) continue;
    let state;
    try {
      state = await source.status();
    } catch (error) {
      results.push({
        id: source.id,
        label: source.label,
        available: false,
        reason: error?.message ?? String(error),
        sessions: [],
        total: 0,
        truncated: false,
      });
      continue;
    }
    if (state.available !== true) {
      results.push({
        id: source.id,
        label: source.label,
        available: false,
        reason: String(state.reason ?? 'unavailable'),
        hint: String(state.hint ?? ''),
        sessions: [],
        total: 0,
        truncated: false,
      });
      continue;
    }
    try {
      const page = await source.listSessions({ limit, offset, query });
      results.push({
        id: source.id,
        label: source.label,
        available: true,
        detail: String(state.detail ?? ''),
        sessions: page.sessions.map((row) => publicSession(row, imported)),
        total: Number.isSafeInteger(page.total) ? page.total : page.sessions.length,
        truncated: page.truncated === true,
      });
    } catch (error) {
      results.push({
        id: source.id,
        label: source.label,
        available: false,
        reason: error?.message ?? String(error),
        sessions: [],
        total: 0,
        truncated: false,
      });
    }
  }

  return {
    sources: results,
    projects: groupProjects(results),
    ledger: { total: ledger.total, bySource: ledger.bySource },
    generatedAt: Date.now(),
  };
}

/**
 * Free-text search over every source's listing.
 * @param query - text matched against session names and project paths.
 * @param options - `{limit, sources}`.
 */
export async function search(query, options = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  if (text === '') return await inventory(options);
  return await inventory({ ...options, query: text, offset: 0 });
}

/** How long a project tree is reused before the sources are scanned again. */
const TREE_TTL_MS = 20_000;

/** Cached tree, keyed by the query and the source filter. */
let treeCache = { key: '', at: 0, value: undefined };

/** Human order of the sources inside one project row. */
const SOURCE_ORDER = ['claude-code', 'codex', 'zcode-cli', 'zcode-v2', 'kilo', 'opencode'];

/** Group one session list into project rows, newest project first. */
function buildProjects(sessions, perProject, includeChildren) {
  const projects = new Map();
  for (const session of sessions) {
    const path = session.cwd === '' ? '' : session.cwd;
    const entry = projects.get(path) ?? {
      path,
      name: path === '' ? '' : path.split(/[\\/]+/u).filter((part) => part !== '').at(-1) ?? path,
      sources: new Set(),
      sessionCount: 0,
      importedCount: 0,
      subagentCount: 0,
      updatedAt: 0,
      sessions: [],
    };
    if (session.child === true) {
      entry.subagentCount += 1;
      if (includeChildren !== true) {
        projects.set(path, entry);
        continue;
      }
    }
    entry.sessionCount += 1;
    entry.sources.add(session.source);
    if (typeof session.importedSessionId === 'string' && session.importedSessionId !== '') entry.importedCount += 1;
    entry.updatedAt = Math.max(entry.updatedAt, session.updatedAt ?? 0);
    entry.sessions.push(session);
    projects.set(path, entry);
  }
  return [...projects.values()]
    .map((entry) => {
      entry.sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      const sessions = entry.sessions.slice(0, perProject);
      return {
        path: entry.path,
        name: entry.name === '' ? '(проект не записан)' : entry.name,
        sources: [...entry.sources].sort((left, right) => SOURCE_ORDER.indexOf(left) - SOURCE_ORDER.indexOf(right)),
        sessionCount: entry.sessionCount,
        importedCount: entry.importedCount,
        subagentCount: entry.subagentCount,
        updatedAt: entry.updatedAt,
        truncated: entry.sessionCount > sessions.length,
        hiddenCount: Math.max(0, entry.sessionCount - sessions.length),
        sessions,
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
}

/**
 * The panel's primary view: every detected session grouped by its project.
 *
 * One scan feeds both the folder list and the sessions inside each folder, so
 * the UI renders a tree instead of a flat sheet. The result is cached briefly:
 * switching a source filter or typing a search must not rescan six stores.
 *
 * @param options - `{query, sources, perProject, perSourceLimit, fresh}`.
 * @returns `{projects, totals, generatedAt, cached}`.
 */
export async function projectTree(options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  const sources = Array.isArray(options.sources) && options.sources.length > 0 ? [...options.sources].sort() : [];
  const perProject = clampLimit(options.perProject, 60, 500);
  const perSourceLimit = clampLimit(options.perSourceLimit, 500, 2000);
  const includeChildren = options.includeChildren === true;
  const key = `${query}\u0000${sources.join(',')}\u0000${perProject}\u0000${perSourceLimit}\u0000${includeChildren ? 'children' : 'parents'}`;
  const now = Date.now();
  if (options.fresh !== true && treeCache.value !== undefined && treeCache.key === key && now - treeCache.at < TREE_TTL_MS) {
    return { ...treeCache.value, cached: true };
  }

  const result = await inventory({ limit: perSourceLimit, query, sources: sources.length === 0 ? undefined : sources });
  const sessions = result.sources.flatMap((source) => source.sessions);
  const parents = sessions.filter((session) => session.child !== true);
  const children = sessions.filter((session) => session.child === true);
  const projects = buildProjects(sessions, perProject, includeChildren);
  const value = {
    projects,
    totals: {
      projects: projects.length,
      sessions: includeChildren ? sessions.length : parents.length,
      subagents: children.length,
      imported: parents.filter((session) => typeof session.importedSessionId === 'string' && session.importedSessionId !== '').length,
      sources: result.sources.filter((source) => source.available === true).length,
    },
    includeChildren,
    sources: result.sources.map((source) => ({
      id: source.id,
      label: source.label,
      available: source.available,
      total: source.total,
      reason: source.reason ?? '',
    })),
    generatedAt: now,
    cached: false,
  };
  treeCache = { key, at: now, value };
  return value;
}
