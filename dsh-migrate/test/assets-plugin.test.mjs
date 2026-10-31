/**
 * Package and contract tests: the manifest the Host and the browser loader read,
 * the route map the ТЗ requires, and the shape of the tree the panel renders.
 *
 * These tests read the real foreign sources of this host (read-only) and never
 * write anything: the tree, the preview and a dry run are the only calls.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { buildStatus, buildTree, previewImport, runImport } from '../lib/assets/operations.js';
import * as hostEntry from '../index.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');

test('package.json declares the bundle patch and the web client half', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@local/dsh-migrate');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@deepseek-ai/dsh-client-ui-sidebar-right',
  ]);
  assert.equal(manifest.scripts.test, 'node --test "test/*.test.mjs"');
});

test('cordis.patch.yml inserts the plugin under its own id', async () => {
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /^- insert:$/mu);
  assert.match(patch, /id: migrate/u);
  assert.match(patch, /name: "@local\/dsh-migrate"/u);
});

test('the Host half exports the plugin name and injects webServer before registering routes', () => {
  assert.equal(hostEntry.name, 'dsh-migrate');
  assert.ok(Array.isArray(hostEntry.inject));
  assert.ok(hostEntry.inject.includes('webServer'), 'without webServer in inject the routes are missing on a cold start');
  assert.ok(hostEntry.inject.includes('tools'));
  assert.equal(typeof hostEntry.apply, 'function');
});

test('the browser half loads through the module loader and injects slots and locale', async () => {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/u);
  assert.match(source, /id: '@local\/dsh-migrate'/u);
  assert.match(source, /const inject = \['slots', 'locale'\];/u);
  for (const route of [
    '/dsh-migrate/sessions/tree',
    '/dsh-migrate/sessions/run',
    '/dsh-migrate/assets/tree',
    '/dsh-migrate/assets/run',
    '/dsh-migrate/assets/status',
    '/dsh-migrate/assets/preview',
    '/dsh-migrate/assets/instruction',
  ]) {
    assert.ok(source.includes(route), `the client must know ${route}`);
  }
  // Only theme tokens of this build are allowed in the stylesheet.
  assert.equal(/\bvar\(--(?!dsw-alias-|dsw-radius-|ds-)/u.test(source), false, 'the stylesheet must use --dsw-alias-*/--dsw-radius-* tokens only');
  for (const slot of ['main', 'sidebar.panellist', 'conversation.session.header.utilities', 'sidebar.right.pane.tab']) {
    assert.ok(source.includes(`'${slot}'`), `the client must register the ${slot} slot`);
  }
  // One plugin, two tabs, remembered in localStorage.
  assert.match(source, /'dsh-migrate\.tab'/u);
  assert.match(source, /tab\.sessions/u);
  assert.match(source, /tab\.assets/u);
});

test('the tree is «источник → тип → элемент» with target paths and statuses', async () => {
  const tree = await buildTree();
  assert.ok(tree.sources.length > 0, 'at least one foreign source must be discovered');
  assert.equal(typeof tree.generatedAtText, 'string');
  assert.match(tree.generatedAtText, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/u, 'dates are shown in the Russian format');

  const types = new Set();
  const allowedStatus = {
    skills: ['new', 'update', 'exists', 'available', 'duplicate', 'invalid'],
    mcp: ['new', 'exists', 'duplicate', 'invalid'],
    secrets: ['new', 'set', 'empty', 'conflict', 'duplicate', 'invalid'],
    plugins: ['runtime'],
    instructions: ['new', 'exists', 'view'],
  };
  for (const source of tree.sources) {
    assert.equal(typeof source.id, 'string');
    assert.ok(source.types.length > 0, `${source.id} must carry at least one type group`);
    for (const group of source.types) {
      types.add(group.type);
      assert.ok(Array.isArray(group.items));
      for (const item of group.items) {
        assert.ok(['skills', 'mcp', 'secrets', 'plugins', 'instructions'].includes(item.type));
        assert.equal(typeof item.status, 'string');
        assert.equal(typeof item.selectable, 'boolean');
        assert.equal(item.source, source.id);
        assert.ok(allowedStatus[item.type].includes(item.status), `${item.type}/${item.name} carries an unknown status ${item.status}`);
        if (item.selectable === true) {
          assert.ok(group.type === 'secrets' ? ['new', 'set'].includes(item.status) : true, 'only a new/overwritten secret is selectable');
        }
      }
    }
  }
  for (const expected of ['skills', 'mcp', 'secrets', 'plugins']) assert.ok(types.has(expected), `the tree must expose ${expected}`);

  // The copy target is the root the shipped skill provider actually reads.
  assert.match(tree.targets.skills.replace(/\\/gu, '/'), /\/\.dsh\/skills$/u);
  assert.equal(typeof tree.targets.profilePatch, 'string');
  assert.ok(tree.totals.total > 0);
  assert.equal(typeof tree.policy.secrets, 'string');
});

test('an MCP row states its transport, its destination and the variables it needs', async () => {
  const tree = await buildTree();
  const mcp = tree.sources.flatMap((source) => source.types.filter((group) => group.type === 'mcp').flatMap((group) => group.items));
  assert.ok(mcp.length > 0, 'this host configures MCP servers');
  for (const item of mcp) {
    assert.ok(['stdio', 'streamable-http', 'unknown'].includes(item.transport));
    assert.ok(Array.isArray(item.needsEnv));
    assert.equal(item.target, tree.targets.profilePatch);
    if (item.status === 'new') assert.equal(item.selectable, true);
    if (item.status === 'exists') assert.equal(item.selectable, false);
  }
});

test('a dry run reports every requested item and changes nothing', async () => {
  const before = await buildStatus();
  const tree = await buildTree();
  const selectable = tree.sources.flatMap((source) => source.types.flatMap((group) => group.items)).filter((item) => item.selectable === true);
  assert.ok(selectable.length > 0, 'this host has something importable');
  const items = selectable.slice(0, 3).map((item) => ({ type: item.type, source: item.source, name: item.name }));
  const report = await runImport(items, { dryRun: true });
  assert.equal(report.summary.dryRun, true);
  assert.equal(report.summary.requested, items.length);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.items.length, items.length);
  for (const item of report.items) {
    assert.match(item.action, /^would-|^skipped$/u, `unexpected dry-run action ${item.action}`);
  }
  const after = await buildStatus();
  assert.deepEqual(after.ledger, before.ledger, 'a dry run must not touch the ledger');
});

test('an unknown item is reported as a failure instead of a silent success', async () => {
  const report = await runImport([{ type: 'skills', source: 'no-such-source', name: 'no-such-skill' }], { dryRun: true });
  assert.equal(report.summary.failed, 1);
  assert.match(report.items[0].reason, /не найден/u);
});

test('the MCP preview warns about the profile and lists missing variables', async () => {
  const tree = await buildTree();
  const mcpNew = tree.sources
    .flatMap((source) => source.types.filter((group) => group.type === 'mcp').flatMap((group) => group.items))
    .filter((item) => item.status === 'new');
  if (mcpNew.length === 0) return;
  const preview = await previewImport(mcpNew.map((item) => ({ type: 'mcp', source: item.source, name: item.name })));
  assert.equal(preview.changesProfile, true);
  assert.match(preview.yaml, /^- insert:$/mu);
  assert.match(preview.yaml, /@deepseek-ai\/dsh-mcp-client/u);
  assert.match(preview.note, /cordis\.patch\.yml/u);
  for (const warning of preview.warnings) assert.match(warning, /переменная окружения/u);
});

test('the README documents what travels and how to roll back the MCP change', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /~\/\.dsh\/skills|\.dsh\\skills/u);
  assert.match(readme, /cordis\.patch\.yml/u);
  assert.match(readme, /backup-profile\.ps1/u);
  assert.match(readme, /секрет/iu);
  assert.match(readme, /перезапуск/iu);
  assert.ok(existsSync(join(ROOT, 'lib', 'assets', 'operations.js')));
});
