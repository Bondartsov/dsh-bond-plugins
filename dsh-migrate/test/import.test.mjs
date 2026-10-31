/**
 * Guard tests for import identity and the ledger.
 *
 * The deterministic session id is what makes a second import a no-op: these
 * tests pin that property, plus the ledger round-trip that records provenance.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'dsh-agent-import-ledger-'));
process.env.DSH_HOME = join(home, '.dsh');

const { sessionIdFor } = await import('../lib/sessions/import.js');
const { findImport, forgetImport, ledgerPath, ledgerSummary, listImports, recordImport } = await import('../lib/sessions/ledger.js');

test('the session id is deterministic per foreign session', () => {
  const first = sessionIdFor('claude-code', 'abc');
  const second = sessionIdFor('claude-code', 'abc');
  assert.equal(first, second);
  assert.match(first, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
});

test('the same foreign id under two sources yields two distinct sessions', () => {
  assert.notEqual(sessionIdFor('claude-code', 'abc'), sessionIdFor('kilo', 'abc'));
});

test('a source/id pair never collides with a shifted pair', () => {
  assert.notEqual(sessionIdFor('a', 'b:c'), sessionIdFor('a:b', 'c'));
});

test('the ledger records provenance and makes a repeat import a no-op', async () => {
  const sessionId = sessionIdFor('codex', 'rollout-1');
  const recorded = await recordImport({
    source: 'codex',
    foreignId: 'rollout-1',
    sessionId,
    title: 'Run the tests',
    cwd: 'D:\\work\\demo',
    originalCwd: 'D:\\work\\demo',
    eventCount: 21,
    turnCount: 3,
    verified: true,
  });

  assert.equal(recorded.sessionId, sessionId);
  const found = findImport('codex', 'rollout-1');
  assert.equal(found?.sessionId, sessionId);
  assert.equal(found?.title, 'Run the tests');
  assert.equal(found?.turnCount, 3);

  const summary = ledgerSummary();
  assert.equal(summary.total, 1);
  assert.equal(summary.bySource.codex, 1);
  assert.equal(listImports().length, 1);
});

test('the ledger file lands in the plugin-owned directory under the DSH home', () => {
  // The unified plugin keeps both layers in one durable directory.
  assert.equal(ledgerPath(), join(home, '.dsh', 'dsh-migrate', 'sessions-ledger.json'));
});

test('forgetting an import drops it from the ledger without touching the session', async () => {
  assert.equal(await forgetImport('codex', 'rollout-1'), true);
  assert.equal(findImport('codex', 'rollout-1'), undefined);
  assert.equal(await forgetImport('codex', 'rollout-1'), false);
});

test('a ledger entry survives a fresh process reading the same file', async () => {
  await recordImport({ source: 'kilo', foreignId: 'ses-9', sessionId: 'session-x', title: 'Kilo session' });
  const { readFile } = await import('node:fs/promises');
  const persisted = JSON.parse(await readFile(ledgerPath(), 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.imports['kilo:ses-9'].sessionId, 'session-x');
});
