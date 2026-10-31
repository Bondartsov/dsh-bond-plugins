/**
 * Guard tests for workspace attachment — the «Ungrouped» repair.
 *
 * A session that is not listed by any workspace shows up as Ungrouped even when
 * its own cwd names a project. The import attaches itself; `attach.js` repairs
 * sessions imported before that existed. These tests pin: the import really puts
 * the session into the workspace `sessionIds`, a second attach reports `already`
 * without touching the registry, and a missing registry is reported in the
 * import's warnings instead of vanishing.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'dsh-migrate-attach-'));
process.env.DSH_HOME = join(home, '.dsh');
const project = join(home, 'Smart_Comply_Core');
await mkdir(project, { recursive: true });
const projectResolved = await realpath(project);

const { attachSessionToWorkspace, attachSessions } = await import('../lib/sessions/attach.js');
const { importSession, sessionIdFor } = await import('../lib/sessions/import.js');
const { findImport } = await import('../lib/sessions/ledger.js');

/** One workspace entity with a live `sessionIds` list. */
function makeWorkspace(path, title) {
  const workspace = {
    path,
    title,
    sessionIds: [],
    attachCalls: 0,
    async attachSession(sessionId) {
      workspace.attachCalls += 1;
      if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId);
    },
    hasSession(sessionId) {
      return workspace.sessionIds.includes(sessionId);
    },
  };
  return workspace;
}

/** A registry stub backed by real workspace entities (like the durable one). */
function makeRegistry(initial = []) {
  const workspaces = initial;
  return {
    workspaces,
    async list() {
      return workspaces.map((workspace) => ({ path: workspace.path, title: workspace.title, sessionIds: [...workspace.sessionIds] }));
    },
    async resolveByPath(path) {
      return workspaces.find((workspace) => workspace.path.toLowerCase() === String(path ?? '').toLowerCase());
    },
    async create(path, title) {
      const workspace = makeWorkspace(path, title ?? basename(path));
      workspaces.push(workspace);
      return workspace;
    },
  };
}

/** In-memory session persistence: create/open/stat, no real files. */
function makePersistence(cwdBySession = {}) {
  const handles = new Map();
  return {
    handles,
    async create(header) {
      if (handles.has(header.id)) {
        const error = new Error('that session id is already stored');
        error.name = 'SessionAlreadyExistsError';
        throw error;
      }
      const handle = { header, events: [], closed: false };
      handles.set(header.id, handle);
      return {
        async append(events) {
          handle.events.push(...events);
        },
        async flush() {},
        async close() {
          handle.closed = true;
        },
        async read() {
          return { events: handle.events };
        },
      };
    },
    async open(id) {
      const handle = handles.get(id);
      if (handle === undefined) throw new Error(`session ${id} is not stored`);
      return {
        async read() {
          return { events: handle.events };
        },
        async append(events) {
          handle.events.push(...events);
        },
        async flush() {},
        async close() {},
      };
    },
    async stat(id) {
      const handle = handles.get(id);
      if (handle !== undefined) return { header: handle.header };
      if (typeof cwdBySession[id] === 'string') return { header: { id, cwd: cwdBySession[id] } };
      return undefined;
    },
  };
}

/** A Host stub: only the services the attach/import path touches. */
function makeHost({ registry, persistence } = {}) {
  return {
    get(name) {
      if (name === 'sessionPersistence') return persistence;
      if (name === 'workspaceRegistry') return registry;
      return undefined;
    },
  };
}

/** Minimal transcript the importer accepts. */
function transcriptOf(foreignId, title) {
  return {
    source: 'zcode-cli',
    label: 'ZCode',
    foreignId,
    title,
    cwd: projectResolved,
    createdAt: 1_700_000_000_000,
    model: { provider: 'zai', model: 'glm-4.6' },
    messages: [
      { role: 'user', text: 'do the thing' },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
  };
}

test('an import attaches the new session to the workspace of its cwd', async () => {
  const workspace = makeWorkspace(projectResolved, 'Smart_Comply_Core');
  const registry = makeRegistry([workspace]);
  const persistence = makePersistence();
  const ctx = makeHost({ registry, persistence });

  const report = await importSession(ctx, transcriptOf('attach-1', 'RAG-качество'));
  assert.equal(report.status, 'imported');
  assert.equal(report.verified, true);
  assert.equal(workspace.attachCalls, 1, 'the import must attach the session');
  assert.ok(workspace.sessionIds.includes(report.sessionId), 'the session id must land in the workspace sessionIds');
  assert.equal(report.workspacePath, projectResolved);
  assert.equal(report.warnings.some((warning) => /workspace attach skipped/u.test(warning)), false, 'a successful attach must not warn');
});

test('an import creates the project workspace when none exists yet', async () => {
  const registry = makeRegistry();
  const persistence = makePersistence();
  const report = await importSession(makeHost({ registry, persistence }), transcriptOf('attach-2', 'Дашборд'));
  assert.equal(registry.workspaces.length, 1, 'a workspace is created for the project');
  assert.equal(registry.workspaces[0].path, projectResolved);
  assert.ok(registry.workspaces[0].sessionIds.includes(report.sessionId));
});

test('a missing workspaceRegistry is reported in the import warnings, not swallowed', async () => {
  const persistence = makePersistence();
  const report = await importSession(makeHost({ persistence }), transcriptOf('attach-3', 'Без реестра'));
  assert.equal(report.status, 'imported', 'the session itself is still imported');
  assert.ok(
    report.warnings.some((warning) => /workspace attach skipped/u.test(warning) && /workspaceRegistry is unavailable/u.test(warning)),
    `expected an explicit attach warning, saw: ${report.warnings.join(' | ')}`,
  );
  assert.equal(findImport('zcode-cli', 'attach-3').sessionId, report.sessionId, 'the ledger is still written');
});

test('attach repairs an ungrouped session using its stored cwd, without a restart', async () => {
  const workspace = makeWorkspace(projectResolved, 'Smart_Comply_Core');
  const registry = makeRegistry([workspace]);
  const sessionId = sessionIdFor('zcode-cli', 'attach-4');
  const persistence = makePersistence({ [sessionId]: projectResolved });
  const result = await attachSessionToWorkspace(makeHost({ registry, persistence }), sessionId);
  assert.equal(result.status, 'attached');
  assert.equal(result.workspaceTitle, 'Smart_Comply_Core');
  assert.equal(result.workspacePath, projectResolved);
  assert.ok(workspace.sessionIds.includes(sessionId));
});

test('attach for an already attached session reports `already` and does not touch the registry', async () => {
  const workspace = makeWorkspace(projectResolved, 'Smart_Comply_Core');
  const sessionId = sessionIdFor('zcode-cli', 'attach-5');
  workspace.sessionIds.push(sessionId);
  const registry = makeRegistry([workspace]);
  const result = await attachSessionToWorkspace(makeHost({ registry, persistence: makePersistence() }), sessionId);
  assert.equal(result.status, 'already');
  assert.equal(result.workspaceTitle, 'Smart_Comply_Core');
  assert.equal(workspace.attachCalls, 0, 'an idempotent attach must not call attachSession again');
});

test('attach fails honestly when the registry or the cwd is missing', async () => {
  const noRegistry = await attachSessionToWorkspace(makeHost({ persistence: makePersistence() }), 'session-unknown');
  assert.equal(noRegistry.status, 'failed');
  assert.match(noRegistry.reason, /workspaceRegistry is unavailable/u);

  const registry = makeRegistry([]);
  const noCwd = await attachSessionToWorkspace(makeHost({ registry, persistence: makePersistence() }), 'session-no-cwd');
  assert.equal(noCwd.status, 'failed');
  assert.match(noCwd.reason, /cwd пуст/u);
});

test('attachSessions summarises a mixed batch', async () => {
  const workspace = makeWorkspace(projectResolved, 'Smart_Comply_Core');
  const attachedId = sessionIdFor('zcode-cli', 'attach-6');
  const alreadyId = sessionIdFor('zcode-cli', 'attach-7');
  workspace.sessionIds.push(alreadyId);
  const registry = makeRegistry([workspace]);
  const persistence = makePersistence({ [attachedId]: projectResolved });
  const result = await attachSessions(makeHost({ registry, persistence }), [attachedId, alreadyId, 'session-no-cwd']);
  assert.deepEqual(result.summary, { requested: 3, attached: 1, already: 1, failed: 1 });
  assert.equal(result.items[0].status, 'attached');
  assert.equal(result.items[1].status, 'already');
  assert.equal(result.items[2].status, 'failed');
});
