/**
 * Guard test for the unified plugin entry point.
 *
 * Installs the Host half on a stub context and drives the session tool's
 * read-only actions. It pins the Cordis plugin shape, both model-facing tools,
 * the one `/dsh-migrate/` route prefix with its two independent layers, and the
 * ledger location under the unified durable directory.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Tool registrations captured from the stub context. */
const tools = [];

/** Route registrations captured from the stub context. */
const routes = [];

const stubContext = {
  effect(callback) {
    const dispose = callback();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  get(serviceName) {
    if (serviceName === 'webServer') {
      return {
        register(spec) {
          routes.push(spec);
          return () => {};
        },
      };
    }
    return undefined;
  },
  inject() {
    /* the web server is already published in this stub */
  },
  tools: {
    register(spec) {
      tools.push(spec);
      return () => {};
    },
  },
};

const plugin = await import('../index.js');

test('the Host half exports the Cordis plugin shape', () => {
  assert.equal(plugin.name, 'dsh-migrate');
  assert.ok(Array.isArray(plugin.inject));
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.inject.includes('tools'));
  assert.ok(plugin.inject.includes('webServer'));
});

test('apply registers both tools and every route under one prefix', () => {
  plugin.apply(stubContext);
  assert.deepEqual(tools.map((tool) => tool.name), ['dsh_migrate_sessions', 'dsh_migrate_assets']);
  const sessions = tools[0];
  assert.deepEqual(sessions.parameters.action.enum, ['scan', 'search', 'import', 'update', 'reimport', 'attach', 'repair_watermark', 'verify', 'continue', 'ledger', 'ui']);
  assert.equal(tools[1].parameters.action.enum.includes('run'), true);

  const paths = routes.map((route) => route.path).sort();
  assert.deepEqual(paths, [
    '/dsh-migrate/assets/instruction',
    '/dsh-migrate/assets/preview',
    '/dsh-migrate/assets/run',
    '/dsh-migrate/assets/status',
    '/dsh-migrate/assets/tree',
    '/dsh-migrate/sessions/attach',
    '/dsh-migrate/sessions/import',
    '/dsh-migrate/sessions/reimport',
    '/dsh-migrate/sessions/repair-watermark',
    '/dsh-migrate/sessions/run',
    '/dsh-migrate/sessions/run-status',
    '/dsh-migrate/sessions/status',
    '/dsh-migrate/sessions/tree',
    '/dsh-migrate/sessions/update',
  ]);
  for (const route of routes) assert.equal(route.kind, 'exact');
  // Two independent layers, one prefix; no route of a predecessor plugin leaks.
  assert.equal(paths.some((path) => path.startsWith('/agent-import/')), false);
  assert.equal(paths.some((path) => path.startsWith('/assets-import/')), false);
});

test('the ledger action answers without any import having run', async () => {
  const result = await tools[0].execute({ action: 'ledger' });
  assert.equal(result.action, 'ledger');
  assert.match(result.text, /Импортировано сессий/);
  assert.equal(typeof result.data.total, 'number');
});

test('the scan action reports every source with a shape the panel can render', async () => {
  const result = await tools[0].execute({ action: 'scan', limit: 3, source: 'zcode-v2' });
  assert.equal(result.action, 'scan');
  const sources = result.data.sources;
  assert.ok(Array.isArray(sources) && sources.length === 1, 'the source filter must narrow the scan');
  const source = sources[0];
  assert.equal(source.id, 'zcode-v2');
  assert.equal(typeof source.available, 'boolean');
  assert.ok(Array.isArray(source.sessions));
  for (const session of source.sessions) {
    assert.equal(typeof session.source, 'string');
    assert.equal(typeof session.id, 'string');
    assert.equal(typeof session.title, 'string');
    assert.equal(typeof session.cwd, 'string');
  }
});

test('the assets tool inventories the same tree the assets tab renders', async () => {
  const result = await tools[1].execute({ action: 'tree' });
  assert.equal(result.action, 'tree');
  assert.match(result.text, /Ассеты чужих агентов/);
  assert.equal(typeof result.data.totals.total, 'number');
  assert.ok(Array.isArray(result.data.sources));
});

test('an unknown action is refused with the usable list', async () => {
  await assert.rejects(() => tools[0].execute({ action: 'nuke' }), /unknown action/);
  await assert.rejects(() => tools[1].execute({ action: 'nuke' }), /unknown action/);
});

test('import without a source and id is refused', async () => {
  await assert.rejects(() => tools[0].execute({ action: 'import' }), /needs `source` and `id`/);
});

test('the unified ledger lives under ~/.dsh/dsh-migrate', async () => {
  const { ledgerPath, ledgerKey } = await import('../lib/sessions/ledger.js');
  assert.match(ledgerPath().replace(/\\/gu, '/'), /\/\.dsh\/dsh-migrate\/sessions-ledger\.json$/u);
  assert.equal(ledgerKey('codex', 'abc'), 'codex:abc');
  const assetsLedger = await import('../lib/assets/ledger.js');
  assert.match(assetsLedger.ledgerPath().replace(/\\/gu, '/'), /\/\.dsh\/dsh-migrate\/assets-ledger\.json$/u);
});

test('the predecessor ledgers are only a read fallback, never a write target', async () => {
  const sessions = await import('../lib/sessions/ledger.js');
  assert.match(sessions.legacyLedgerPath().replace(/\\/gu, '/'), /\/\.dsh\/agent-import\/ledger\.json$/u);
  assert.notEqual(sessions.legacyLedgerPath(), sessions.ledgerPath());
  const assets = await import('../lib/assets/ledger.js');
  assert.match(assets.legacyLedgerPath().replace(/\\/gu, '/'), /\/\.dsh\/assets-import\/ledger\.json$/u);
  assert.notEqual(assets.legacyLedgerPath(), assets.ledgerPath());
});
