/**
 * Route tests: the unified Host half driven through a stub web server.
 *
 * `apply(ctx)` is called with a fake context, the handlers are invoked with fake
 * request/response objects, and the JSON contract of every route is asserted —
 * both layers, the same-origin guard, the argument errors, the idempotency of a
 * repeat scan/dry run and the promise that a secret value never reaches a route
 * payload.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { apply } from '../index.js';

/** A stub plugin context that records the routes and the registered tools. */
function createFakeHost(services = {}) {
  const routes = new Map();
  const tools = [];
  const effects = [];
  const webServer = {
    register({ kind, path, handler }) {
      assert.equal(kind, 'exact');
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  };
  const ctx = {
    get: (service) => (service === 'webServer' ? webServer : services[service]),
    inject: (_names, callback) => callback(ctx),
    effect: (callback) => {
      effects.push(callback);
      // A real Cordis effect runs its body immediately and keeps the disposer.
      return callback() ?? (() => {});
    },
    tools: {
      register: (tool) => tools.push(tool),
    },
  };
  return { ctx, routes, tools, effects };
}

/** A fake request with an optional JSON body. */
function request({ method = 'GET', url = '/', body, site = 'same-origin' }) {
  const emitter = new EventEmitter();
  emitter.method = method;
  emitter.url = url;
  emitter.headers = site === '' ? {} : { 'sec-fetch-site': site };
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    setImmediate(() => {
      emitter.emit('data', Buffer.from(text, 'utf8'));
      emitter.emit('end');
    });
  } else {
    setImmediate(() => emitter.emit('end'));
  }
  return emitter;
}

/** A fake response that collects the JSON payload. */
function createResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    text: '',
    writeHead(status, headers) {
      response.statusCode = status;
      response.headers = headers ?? {};
      return response;
    },
    end(chunk) {
      if (chunk !== undefined) response.text += String(chunk);
      response.done = true;
      return response;
    },
  };
  return response;
}

/** Invoke one registered route handler. */
async function call(routes, path, options) {
  const handler = routes.get(path);
  assert.equal(typeof handler, 'function', `route ${path} must be registered`);
  const response = createResponse();
  await handler(request(options), response);
  const parsed = response.text === '' ? undefined : JSON.parse(response.text);
  return { status: response.statusCode, headers: response.headers, body: parsed };
}

const ROUTES = {
  sessionsTree: '/dsh-migrate/sessions/tree',
  sessionsRun: '/dsh-migrate/sessions/run',
  sessionsRunStatus: '/dsh-migrate/sessions/run-status',
  sessionsImport: '/dsh-migrate/sessions/import',
  sessionsUpdate: '/dsh-migrate/sessions/update',
  sessionsReimport: '/dsh-migrate/sessions/reimport',
  sessionsAttach: '/dsh-migrate/sessions/attach',
  sessionsRepairWatermark: '/dsh-migrate/sessions/repair-watermark',
  sessionsStatus: '/dsh-migrate/sessions/status',
  assetsTree: '/dsh-migrate/assets/tree',
  assetsRun: '/dsh-migrate/assets/run',
  assetsPreview: '/dsh-migrate/assets/preview',
  assetsStatus: '/dsh-migrate/assets/status',
  assetsInstruction: '/dsh-migrate/assets/instruction',
};

test('apply() registers both layers, every route and both model-facing tools', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  for (const path of Object.values(ROUTES)) assert.equal(host.routes.has(path), true, `${path} must be registered`);
  assert.equal(host.effects.length >= 1, true, 'routes must be installed inside an effect so they are disposed');
  assert.deepEqual(host.tools.map((tool) => tool.name), ['dsh_migrate_sessions', 'dsh_migrate_assets']);
  // The predecessor prefixes are gone: one plugin, one prefix.
  assert.equal([...host.routes.keys()].some((path) => /^\/(agent|assets)-import\//u.test(path)), false);
});

test('GET /dsh-migrate/sessions/tree returns the project tree and really re-requests with fresh=1', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const first = await call(host.routes, ROUTES.sessionsTree, { method: 'GET', url: `${ROUTES.sessionsTree}?perProject=5` });
  assert.equal(first.status, 200);
  assert.match(first.headers['cache-control'], /no-store/u);
  assert.ok(Array.isArray(first.body.projects), 'the panel renders project folders');
  assert.ok(Array.isArray(first.body.sources));
  assert.equal(typeof first.body.totals.projects, 'number');
  assert.equal(typeof first.body.generatedAt, 'number');

  // A second plain read inside the TTL may be served from the Host cache...
  const second = await call(host.routes, ROUTES.sessionsTree, { method: 'GET', url: `${ROUTES.sessionsTree}?perProject=5` });
  assert.equal(second.body.cached, true, 'a plain read is allowed to reuse the short-lived scan');
  // ...but Refresh (fresh=1) must always scan again — this is what the button does.
  const refreshed = await call(host.routes, ROUTES.sessionsTree, { method: 'GET', url: `${ROUTES.sessionsTree}?perProject=5&fresh=1` });
  assert.equal(refreshed.body.cached, false, 'the Refresh button must bypass the cache');
  assert.deepEqual(
    { projects: refreshed.body.totals.projects, sessions: refreshed.body.totals.sessions },
    { projects: first.body.totals.projects, sessions: first.body.totals.sessions },
  );
});

test('GET /dsh-migrate/sessions/status reports the unified ledger and the client half', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const answer = await call(host.routes, ROUTES.sessionsStatus, { method: 'GET' });
  assert.equal(answer.status, 200);
  assert.equal(typeof answer.body.ledger.total, 'number');
  assert.equal(typeof answer.body.ui.packageName, 'string');
  assert.match(answer.body.generatedAtText, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/u, 'dates are shown in the Russian format');
});

test('POST /dsh-migrate/sessions/run validates its body and never imports on a bad request', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const bad = await call(host.routes, ROUTES.sessionsRun, { method: 'POST', body: { items: 'nope' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /^BAD_ARGUMENT/u);
  const empty = await call(host.routes, ROUTES.sessionsRun, { method: 'POST', body: { items: [] } });
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /^BAD_ARGUMENT/u);
  const noId = await call(host.routes, ROUTES.sessionsImport, { method: 'POST', body: { source: 'codex' } });
  assert.equal(noId.status, 400);
  const noSource = await call(host.routes, ROUTES.sessionsUpdate, { method: 'POST', body: { id: 'x' } });
  assert.equal(noSource.status, 400);
});

test('the run routes expose live progress: a run id, a status endpoint and a settled report', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  // A stub Host has no sessionPersistence, so the import fails per item — which is
  // exactly what lets this test drive the run lifecycle without writing anything.
  const started = await call(host.routes, ROUTES.sessionsRun, {
    method: 'POST',
    body: { items: [{ source: 'codex', id: 'does-not-matter' }] },
  });
  assert.equal(started.status, 200);
  assert.equal(typeof started.body.runId, 'string');
  assert.equal(started.body.statusRoute, ROUTES.sessionsRunStatus);
  assert.equal(started.body.run.status, 'running');
  assert.equal(started.body.run.total, 1);

  // Poll until the background work settles.
  let snapshot;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const poll = await call(host.routes, ROUTES.sessionsRunStatus, { method: 'GET', url: `${ROUTES.sessionsRunStatus}?run=${started.body.runId}` });
    assert.equal(poll.status, 200);
    assert.equal(poll.body.run.id, started.body.runId);
    snapshot = poll.body.run;
    if (snapshot.status !== 'running') break;
  }
  assert.notEqual(snapshot.status, 'running', 'the run must settle');
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.percent, 100);
  assert.equal(snapshot.items[0].status, 'failed');
  assert.equal(typeof snapshot.items[0].error, 'string');
  assert.ok(snapshot.items[0].error.length > 0, 'a failed item must say why');

  // A settled report is also available in one request (`wait=1`), for scripts.
  const whole = await call(host.routes, ROUTES.sessionsRun, {
    method: 'POST',
    url: `${ROUTES.sessionsRun}?wait=1`,
    body: { items: [{ source: 'codex', id: 'another-one' }] },
  });
  assert.equal(whole.status, 200);
  assert.notEqual(whole.body.run.status, 'running');
  assert.equal(whole.body.run.percent, 100);

  const unknown = await call(host.routes, ROUTES.sessionsRunStatus, { method: 'GET', url: `${ROUTES.sessionsRunStatus}?run=run-nope` });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /^RUN_NOT_FOUND/u);
  const latest = await call(host.routes, ROUTES.sessionsRunStatus, { method: 'GET' });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.run.id, whole.body.runId);
});

test('POST /dsh-migrate/sessions/attach repairs an Ungrouped session and is idempotent', async () => {
  const sessionId = 'session-82038439-e85b-abe1-6e2f-7b9c9eeb8ce8';
  const sessionIds = [];
  const workspace = {
    path: 'D:\\Projects\\Smart_Comply_Core',
    title: 'Smart_Comply_Core',
    sessionIds,
    async attachSession(id) {
      if (!sessionIds.includes(id)) sessionIds.push(id);
    },
  };
  const services = {
    workspaceRegistry: {
      async list() {
        return [{ path: workspace.path, title: workspace.title, sessionIds: [...sessionIds] }];
      },
      async resolveByPath(path) {
        return path === workspace.path ? workspace : undefined;
      },
      async create() {
        return workspace;
      },
    },
    sessionPersistence: {
      async stat() {
        return { header: { id: sessionId, cwd: workspace.path } };
      },
    },
  };
  const host = createFakeHost(services);
  apply(host.ctx);

  const bad = await call(host.routes, ROUTES.sessionsAttach, { method: 'POST', body: {} });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /^BAD_ARGUMENT/u);
  const empty = await call(host.routes, ROUTES.sessionsAttach, { method: 'POST', body: { sessionIds: [] } });
  assert.equal(empty.status, 400);

  const attached = await call(host.routes, ROUTES.sessionsAttach, { method: 'POST', body: { sessionIds: [sessionId] } });
  assert.equal(attached.status, 200);
  assert.deepEqual(attached.body.summary, { requested: 1, attached: 1, already: 0, failed: 0 });
  assert.equal(attached.body.items[0].workspaceTitle, 'Smart_Comply_Core');
  assert.ok(sessionIds.includes(sessionId), 'the session must land in the project workspace');

  const again = await call(host.routes, ROUTES.sessionsAttach, { method: 'POST', body: { sessionIds: [sessionId] } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.summary, { requested: 1, attached: 0, already: 1, failed: 0 });
  assert.equal(sessionIds.filter((id) => id === sessionId).length, 1, 'attach is idempotent');
});

test('POST /dsh-migrate/sessions/reimport: copy needs no confirmation, replace does', async () => {
  const host = createFakeHost();
  apply(host.ctx);

  // The default, non-destructive copy: no confirm flag required.
  const copy = await call(host.routes, ROUTES.sessionsReimport, { method: 'POST', body: { source: 'codex', id: 'x' } });
  assert.equal(copy.status, 200);
  assert.equal(copy.body.run.kind, 'reimport');
  assert.equal(copy.body.run.items[0].stage, 'queued');
  assert.equal(typeof copy.body.runId, 'string');
  assert.equal(copy.body.statusRoute, ROUTES.sessionsRunStatus);

  // The destructive replace path still demands an explicit confirmation.
  const refused = await call(host.routes, ROUTES.sessionsReimport, { method: 'POST', body: { source: 'codex', id: 'x', mode: 'replace' } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /^CONFIRMATION_REQUIRED/u);
  const replace = await call(host.routes, ROUTES.sessionsReimport, {
    method: 'POST',
    body: { source: 'codex', id: 'x', mode: 'replace', confirm: true },
  });
  assert.equal(replace.status, 200);
  assert.equal(replace.body.run.kind, 'reimport');
});

test('POST /dsh-migrate/sessions/repair-watermark validates its body and reports per row', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const bad = await call(host.routes, ROUTES.sessionsRepairWatermark, { method: 'POST', body: { sessionIds: 'nope' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /^BAD_ARGUMENT/u);

  // A target that is not in the ledger: the route answers with an empty report
  // and writes nothing — the real ledger of this machine is never touched.
  const answer = await call(host.routes, ROUTES.sessionsRepairWatermark, {
    method: 'POST',
    body: { sessionIds: ['session-does-not-exist'] },
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.items, []);
  assert.equal(answer.body.summary.requested, 0);
});

test('GET /dsh-migrate/assets/tree returns the inventory with targets and statuses', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const answer = await call(host.routes, ROUTES.assetsTree, { method: 'GET' });
  assert.equal(answer.status, 200);
  assert.match(answer.headers['content-type'], /application\/json/u);
  assert.ok(Array.isArray(answer.body.sources));
  assert.ok(answer.body.totals.total > 0);
  assert.match(answer.body.targets.skills.replace(/\\/gu, '/'), /\/\.dsh\/skills$/u);
  assert.match(answer.body.targets.instructions.replace(/\\/gu, '/'), /\/\.dsh\/dsh-migrate\/instructions$/u);
  assert.equal(typeof answer.body.policy.secrets, 'string');
});

test('GET /dsh-migrate/assets/status returns the ledger view', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const answer = await call(host.routes, ROUTES.assetsStatus, { method: 'GET' });
  assert.equal(answer.status, 200);
  assert.equal(typeof answer.body.ledger.total, 'number');
  assert.equal(typeof answer.body.profile.path, 'string');
});

test('an assets dry run writes nothing, reports per item and is repeatable', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const tree = await call(host.routes, ROUTES.assetsTree, { method: 'GET' });
  const item = tree.body.sources.flatMap((source) => source.types.flatMap((group) => group.items)).find((row) => row.selectable === true);
  if (item === undefined) return; // nothing importable on this host
  const before = await call(host.routes, ROUTES.assetsStatus, { method: 'GET' });
  const first = await call(host.routes, ROUTES.assetsRun, {
    method: 'POST',
    body: { items: [{ type: item.type, source: item.source, name: item.name }], dryRun: true },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.summary.dryRun, true);
  assert.equal(first.body.summary.requested, 1);
  assert.equal(first.body.items.length, 1);
  assert.match(first.body.items[0].action, /^would-/u);
  const again = await call(host.routes, ROUTES.assetsRun, {
    method: 'POST',
    body: { items: [{ type: item.type, source: item.source, name: item.name }], dryRun: true },
  });
  assert.deepEqual(again.body.summary, first.body.summary, 'a repeated dry run must not drift');
  assert.deepEqual(again.body.items, first.body.items, 'a repeated dry run must report the same actions');
  const after = await call(host.routes, ROUTES.assetsStatus, { method: 'GET' });
  assert.deepEqual(after.body.ledger, before.body.ledger, 'a dry run must not touch the ledger');
});

test('POST /dsh-migrate/assets/preview describes the profile change and prints YAML', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const tree = await call(host.routes, ROUTES.assetsTree, { method: 'GET' });
  const mcpNew = tree.body.sources
    .flatMap((source) => source.types.filter((group) => group.type === 'mcp').flatMap((group) => group.items))
    .filter((row) => row.status === 'new');
  if (mcpNew.length === 0) return;
  const answer = await call(host.routes, ROUTES.assetsPreview, {
    method: 'POST',
    body: { items: mcpNew.map((row) => ({ type: 'mcp', source: row.source, name: row.name })) },
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.changesProfile, true);
  assert.match(answer.body.yaml, /- insert:/u);
  assert.match(answer.body.note, /cordis\.patch\.yml/u);
  // The preview of the profile change writes nothing.
  const treeAgain = await call(host.routes, ROUTES.assetsTree, { method: 'GET' });
  const mcpAgain = treeAgain.body.sources
    .flatMap((source) => source.types.filter((group) => group.type === 'mcp').flatMap((group) => group.items))
    .filter((row) => row.status === 'new');
  assert.deepEqual(mcpAgain.map((row) => row.name), mcpNew.map((row) => row.name), 'a preview must not append profile rows');
});

test('POST /dsh-migrate/assets/run rejects a body without items', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const answer = await call(host.routes, ROUTES.assetsRun, { method: 'POST', body: { items: 'nope' } });
  assert.equal(answer.status, 400);
  assert.match(answer.body.error, /^BAD_ARGUMENT/u);
  const preview = await call(host.routes, ROUTES.assetsPreview, { method: 'POST', body: {} });
  assert.equal(preview.status, 400);
});

test('GET /dsh-migrate/assets/instruction masks credentials and validates its argument', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const missing = await call(host.routes, ROUTES.assetsInstruction, { method: 'GET', url: ROUTES.assetsInstruction });
  assert.equal(missing.status, 400);

  const answer = await call(host.routes, ROUTES.assetsInstruction, { method: 'GET', url: `${ROUTES.assetsInstruction}?id=claude-code:CLAUDE.md` });
  if (answer.body.ok !== true) return; // the document is absent on this host
  assert.equal(typeof answer.body.content, 'string');
  assert.doesNotMatch(answer.body.content, /gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{24,}/u);
});

test('the secrets group never carries a value through any route', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const plain = await call(host.routes, ROUTES.assetsTree, { method: 'GET' });
  assert.equal(plain.status, 200);
  const rows = plain.body.sources.flatMap((source) => source.types.filter((group) => group.type === 'secrets').flatMap((group) => group.items));
  assert.ok(rows.length > 0, 'this host has credential-like env entries');
  for (const row of rows) {
    assert.equal(typeof row.name, 'string');
    assert.equal(typeof row.valueLength, 'number');
    assert.equal('value' in row, false, 'a secret row must not carry a value');
    assert.equal('secret' in row, false, 'a secret row must not carry a value');
  }
  // The preview names the variables and their lengths only.
  const secret = rows.find((row) => row.selectable === true);
  if (secret !== undefined) {
    const preview = await call(host.routes, ROUTES.assetsPreview, {
      method: 'POST',
      body: { items: [{ type: 'secrets', source: secret.source, name: secret.name }] },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.changesEnvironment, true);
    for (const entry of preview.body.environment.variables) {
      assert.equal(typeof entry.valueLength, 'number');
      assert.equal('value' in entry, false);
    }
    const serialized = JSON.stringify(preview.body);
    assert.doesNotMatch(serialized, /"value"\s*:/u, 'no route payload may carry a secret value');
    assert.doesNotMatch(serialized, /"secret"\s*:/u);
  }
});

test('a cross-origin request is refused and a wrong method is 405 on both layers', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  for (const path of [ROUTES.sessionsTree, ROUTES.assetsTree]) {
    const forbidden = await call(host.routes, path, { method: 'GET', site: 'cross-site' });
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.body.error, /^NOT_OWNER/u);
  }
  const wrongMethod = await call(host.routes, ROUTES.sessionsTree, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  const runGet = await call(host.routes, ROUTES.sessionsRun, { method: 'GET' });
  assert.equal(runGet.status, 405);
  const assetsRunGet = await call(host.routes, ROUTES.assetsRun, { method: 'GET' });
  assert.equal(assetsRunGet.status, 405);
});

test('the model-facing tools answer their read-only actions', async () => {
  const host = createFakeHost();
  apply(host.ctx);
  const [sessions, assets] = host.tools;

  const scan = await sessions.execute({ action: 'scan', limit: 2 });
  assert.equal(scan.action, 'scan');
  assert.ok(Array.isArray(scan.data.sources));

  const ledger = await sessions.execute({ action: 'ledger' });
  assert.match(ledger.text, /Импортировано сессий/u);

  const tree = await assets.execute({ action: 'tree' });
  assert.match(tree.text, /Ассеты чужих агентов/u);
  assert.equal(typeof tree.data.totals.total, 'number');

  const status = await assets.execute({ action: 'status' });
  assert.match(status.text, /Патч профиля/u);

  await assert.rejects(() => assets.execute({ action: 'run', items: [] }), /needs `items`/u);
});
