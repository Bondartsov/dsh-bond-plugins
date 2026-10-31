/**
 * Guard test for the plugin entry point.
 *
 * Installs the Host half on a stub context and drives the agent tool's read-only
 * actions. It pins three things: the plugin exports the Cordis plugin shape, the
 * tool is registered with an `import` action, and the same-origin routes are
 * registered once the web server is present.
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
  assert.equal(typeof plugin.name, 'string');
  assert.ok(Array.isArray(plugin.inject));
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.inject.includes('tools'));
  assert.ok(plugin.inject.includes('webServer'));
});

test('apply registers the agent tool and the panel routes', () => {
  plugin.apply(stubContext);
  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.name, 'agent_import');
  assert.deepEqual(tool.parameters.action.enum, ['scan', 'search', 'import', 'update', 'reimport', 'verify', 'continue', 'ledger', 'assets', 'mcp_plan', 'copy_skills', 'ui']);
  assert.equal(tool.parameters.action.required, true);
  assert.equal(typeof tool.execute, 'function');
  const paths = routes.map((route) => route.path).sort();
  assert.deepEqual(paths, [
    '/agent-import/assets',
    '/agent-import/continue',
    '/agent-import/import',
    '/agent-import/import-batch',
    '/agent-import/inventory',
    '/agent-import/ledger',
    '/agent-import/mcp-plan',
    '/agent-import/reimport',
    '/agent-import/skills',
    '/agent-import/tree',
    '/agent-import/ui',
    '/agent-import/update',
    '/agent-import/verify',
  ]);
  for (const route of routes) assert.equal(route.kind, 'exact');
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

test('the assets action inventories skills, plugins, MCP servers and configs', async () => {
  const result = await tools[0].execute({ action: 'assets' });
  assert.equal(result.action, 'assets');
  assert.ok(Array.isArray(result.data.skills));
  assert.ok(Array.isArray(result.data.plugins));
  assert.ok(Array.isArray(result.data.mcp));
  assert.ok(Array.isArray(result.data.configs));
  assert.equal(typeof result.text, 'string');
});

test('an unknown action is refused with the usable list', async () => {
  await assert.rejects(() => tools[0].execute({ action: 'nuke' }), /unknown action/);
});

test('import without a source and id is refused', async () => {
  await assert.rejects(() => tools[0].execute({ action: 'import' }), /needs `source` and `id`/);
});


