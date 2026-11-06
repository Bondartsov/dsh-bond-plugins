/**
 * Guard tests for un-importing a copy.
 *
 * Removing an import must hide the copy, forget the ledger row and quarantine the
 * artifact — never delete it. The classic failure mode here is an async helper
 * called without `await`: `existsSync(Promise)` is silently false and the file
 * step is skipped, so the quarantine is tested against a real store directory.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'dsh-migrate-unimport-'));
process.env.DSH_HOME = join(home, '.dsh');

const { unimportSession } = await import('../lib/sessions/unimport.js');

/** A store directory that looks exactly like one imported session. */
async function createArtifact(sessionId) {
  const dir = join(home, '.dsh', 'sessions', '--D-work-proj--', sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('zstd-bytes'));
  return dir;
}

test('unimport quarantines the artifact for real: out of the store, recoverable in quarantine', async () => {
  const sessionId = 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const dir = await createArtifact(sessionId);
  const ctx = { get: () => undefined }; // no workspaceRegistry — the move must still happen

  const result = await unimportSession(ctx, sessionId, { batch: 'guard' });

  assert.equal(result.status, 'removed');
  assert.notEqual(result.quarantinedTo, '', 'the artifact must be moved, not left in the store');
  const { existsSync, statSync } = await import('node:fs');
  assert.equal(existsSync(dir), false, 'the store must not keep the copy');
  assert.equal(existsSync(result.quarantinedTo), true, 'the quarantined copy must exist');
  assert.equal(statSync(join(result.quarantinedTo, 'session.v4.jsonl.zstd')).size, 10);
});

test('a dry run reports the artifact location without moving anything', async () => {
  const sessionId = 'session-11111111-2222-4333-8444-555555555555';
  const dir = await createArtifact(sessionId);
  const ctx = { get: () => undefined };

  const result = await unimportSession(ctx, sessionId, { dryRun: true, batch: 'guard' });

  assert.equal(result.status, 'dry-run');
  assert.notEqual(result.quarantinedTo, '', 'the dry run must name where the file WOULD go');
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(dir), true, 'a dry run must not move the artifact');
});

test('an unknown session id is an honest failure, not a silent success', async () => {
  const ctx = { get: () => undefined };
  const result = await unimportSession(ctx, 'session-99999999-9999-4999-8999-999999999999', { batch: 'guard' });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /нечего убирать/u);
});
