/**
 * Guard tests for the re-import repair path.
 *
 * What must never regress: a re-import deletes only the artifact the importer
 * created (by its ledger id), it refuses to touch a session that is open, it
 * clears the ledger row so a second copy cannot appear, and the fresh import
 * writes the watermark that makes later `update` calls work.
 *
 * The importer is injected, so this file never writes into the real DSH session
 * store: the test owns a temporary DSH home and a fake session directory.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'dsh-migrate-reimport-'));
process.env.DSH_HOME = join(home, '.dsh');

const { deleteImportedCopy, reimportSession, sessionDirectory } = await import('../lib/sessions/reimport.js');
const { findImport, ledgerPath, listImports, recordImport } = await import('../lib/sessions/ledger.js');
const { sessionIdFor } = await import('../lib/sessions/import.js');

/** Create the on-disk artifact of one session under a fake project folder. */
async function seedArtifact(sessionId, folder = '--proj--') {
  const directory = join(home, '.dsh', 'sessions', folder, sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'fake artifact', 'utf8');
  return directory;
}

/** A fake Host context: workspace registry records calls, sessions can be "live". */
function fakeContext({ live = false } = {}) {
  const calls = { archived: [], unarchived: [] };
  return {
    calls,
    ctx: {
      get(name) {
        if (name === 'workspaceRegistry') {
          return {
            archiveSession: async (id) => {
              calls.archived.push(id);
            },
            unarchiveSession: async (id) => {
              calls.unarchived.push(id);
            },
          };
        }
        if (name === 'sessions') return { get: () => (live === true ? { id: 'live' } : undefined) };
        return undefined;
      },
    },
  };
}

/** Record one ledger row the way a pre-watermark install left it. */
async function seedLedger(source, foreignId, sessionId, title) {
  await recordImport({
    source,
    foreignId,
    sessionId,
    title,
    cwd: 'C:\\work\\demo',
    eventCount: 100,
    turnCount: 10,
    verified: true,
  });
}

/** A stand-in importer that behaves like the real one: records a fresh watermark. */
function fakeImporter(log) {
  return async (ctx, ref, options) => {
    log.push({ ctx: ctx !== undefined, ref, options });
    const sessionId = typeof options?.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : sessionIdFor(ref.source, ref.id);
    await recordImport({
      source: ref.source,
      foreignId: ref.id,
      sessionId,
      title: 'Переимпортированная',
      cwd: 'C:\\work\\demo',
      eventCount: 120,
      turnCount: 12,
      verified: true,
      foreignMessageCount: 4242,
      foreignPrefixHash: 'deadbeefdeadbeef',
    });
    if (typeof options?.onProgress === 'function') options.onProgress('done', { turns: 12 });
    return {
      status: 'imported',
      sessionId,
      title: 'Переимпортированная',
      cwd: 'C:\\work\\demo',
      workspacePath: 'C:\\work\\demo',
      eventCount: 120,
      turnCount: 12,
      verified: true,
      warnings: [],
    };
  };
}

test('the session directory is found across project folders and refuses ambiguity', async () => {
  const sessionId = sessionIdFor('codex', 'locate-me');
  const directory = await seedArtifact(sessionId, '--one--');
  assert.equal(await sessionDirectory(sessionId), directory);

  // The same id under two project folders means the store disagrees with itself.
  const duplicate = await seedArtifact(sessionId, '--two--');
  await assert.rejects(() => sessionDirectory(sessionId), /нескольких папках/u);
  await Promise.all([import('node:fs/promises').then((fs) => fs.rm(directory, { recursive: true, force: true })), import('node:fs/promises').then((fs) => fs.rm(duplicate, { recursive: true, force: true }))]);
});

test('a re-import deletes the imported copy, rewrites the watermark and never duplicates', async () => {
  const source = 'codex';
  const foreignId = 'legacy-no-watermark';
  const sessionId = sessionIdFor(source, foreignId);
  const directory = await seedArtifact(sessionId);
  await seedLedger(source, foreignId, sessionId, 'Старая копия');

  const before = findImport(source, foreignId);
  assert.equal(before.foreignMessageCount, 0, 'the seeded row has no watermark, like an inherited one');

  const { ctx, calls } = fakeContext();
  const log = [];
  const result = await reimportSession(ctx, { source, id: foreignId }, { importer: fakeImporter(log), mode: 'replace' });

  assert.equal(result.status, 'reimported');
  assert.equal(result.mode, 'replace');
  assert.equal(result.deleted, true);
  assert.equal(result.sessionId, sessionId, 'the deterministic id keeps the identity');
  await assert.rejects(() => stat(directory), 'the old artifact must be gone');
  assert.deepEqual(calls.archived, [sessionId], 'the old copy is hidden from the workspace list first');
  assert.deepEqual(calls.unarchived, [sessionId], 'the fresh copy is brought back into the list');
  assert.equal(log.length, 1);
  assert.equal(log[0].options.force, true);

  const after = findImport(source, foreignId);
  assert.equal(after.sessionId, sessionId);
  assert.equal(after.foreignMessageCount, 4242, 'the re-import writes the watermark an update needs');
  assert.equal(after.foreignPrefixHash, 'deadbeefdeadbeef');
  const rows = listImports().filter((entry) => entry.source === source && entry.foreignId === foreignId);
  assert.equal(rows.length, 1, 'a re-import must not leave two ledger rows for one session');
});

test('a re-import refuses to delete a session that is open in this process', async () => {
  const source = 'codex';
  const foreignId = 'open-session';
  const sessionId = sessionIdFor(source, foreignId);
  const directory = await seedArtifact(sessionId);
  await seedLedger(source, foreignId, sessionId, 'Открытая');
  const { ctx } = fakeContext({ live: true });
  await assert.rejects(
    () => reimportSession(ctx, { source, id: foreignId }, { importer: fakeImporter([]), mode: 'replace' }),
    /открыта в DSH/u,
    'only the destructive path needs a closed session',
  );
  assert.equal((await stat(directory)).isDirectory(), true, 'nothing is deleted when the guard refuses');
});

test('a missing artifact is reported but the import still runs and resets the row', async () => {
  const source = 'kilo';
  const foreignId = 'already-gone';
  const sessionId = sessionIdFor(source, foreignId);
  await seedLedger(source, foreignId, sessionId, 'Без файла');
  const { ctx } = fakeContext();
  const log = [];
  const result = await reimportSession(ctx, { source, id: foreignId }, { importer: fakeImporter(log), mode: 'replace' });
  assert.equal(result.status, 'reimported');
  assert.equal(result.deleted, false);
  assert.ok(result.warnings.some((warning) => /файл сессии не найден/u.test(warning)));
  assert.equal(log.length, 1, 'the import is not blocked by a missing old artifact');
  const after = findImport(source, foreignId);
  assert.equal(after.foreignMessageCount, 4242);
});

test('a session without a ledger row gets a plain first import, with a warning', async () => {
  const source = 'opencode';
  const foreignId = 'never-imported';
  const { ctx } = fakeContext();
  const log = [];
  const result = await reimportSession(ctx, { source, id: foreignId }, { importer: fakeImporter(log), mode: 'replace' });
  assert.equal(result.status, 'reimported');
  assert.equal(result.deleted, false);
  assert.ok(result.warnings.some((warning) => /записи в журнале нет/u.test(warning)));
  assert.equal(log.length, 1);
});

test('deleteImportedCopy refuses a ledger row without a session id', async () => {
  const { ctx } = fakeContext();
  await assert.rejects(() => deleteImportedCopy(ctx, { title: 'no id' }), /нет идентификатора сессии/u);
});

test('a non-destructive re-import writes a NEW copy, archives the old one and needs no closed session', async () => {
  const source = 'codex';
  const foreignId = 'copy-open-session';
  const oldId = sessionIdFor(source, foreignId);
  const oldDirectory = await seedArtifact(oldId);
  await seedLedger(source, foreignId, oldId, 'Старая открытая копия');
  // The old session is OPEN in this process: the copy path must not care.
  const { ctx, calls } = fakeContext({ live: true });
  const log = [];
  const result = await reimportSession(ctx, { source, id: foreignId }, { importer: fakeImporter(log) });

  assert.equal(result.mode, 'copy');
  assert.equal(result.status, 'reimported');
  assert.notEqual(result.sessionId, oldId, 'the new copy gets its own session id');
  assert.equal(result.previousSessionId, oldId);
  assert.equal(result.deleted, false, 'nothing is deleted');
  assert.equal(result.archived, true, 'the old copy is archived instead');
  assert.deepEqual(calls.archived, [oldId]);
  assert.equal((await stat(oldDirectory)).isDirectory(), true, 'the old artifact is untouched');
  assert.equal(log[0].options.sessionId, result.sessionId, 'the importer is told the new id');
  const ledgerRow = findImport(source, foreignId);
  assert.equal(ledgerRow.sessionId, result.sessionId, 'the ledger row moves to the new copy');
  assert.equal(ledgerRow.foreignMessageCount, 4242, 'the new copy carries fresh watermarks');
});

test('a copy re-import reports an old copy that could not be archived instead of failing', async () => {
  const source = 'codex';
  const foreignId = 'copy-no-registry';
  const oldId = sessionIdFor(source, foreignId);
  await seedArtifact(oldId);
  await seedLedger(source, foreignId, oldId, 'Старой некуда прятаться');
  const ctx = { get: (name) => (name === 'sessions' ? { get: () => undefined } : undefined) };
  const result = await reimportSession(ctx, { source, id: foreignId }, { importer: fakeImporter([]) });
  assert.equal(result.mode, 'copy');
  assert.equal(result.archived, false);
  assert.ok(result.warnings.some((warning) => /старая копия осталась в списке/u.test(warning)));
  assert.equal(result.sessionId, findImport(source, foreignId).sessionId, 'the new copy is recorded anyway');
});

test('a first-time re-import without a ledger row keeps the deterministic id', async () => {
  const { ctx, calls } = fakeContext();
  const result = await reimportSession(ctx, { source: 'kilo', id: 'copy-first-time' }, { importer: fakeImporter([]) });
  assert.equal(result.mode, 'copy');
  assert.equal(result.previousSessionId, '');
  assert.equal(result.archived, false);
  assert.deepEqual(calls.archived, []);
  assert.equal(result.sessionId, sessionIdFor('kilo', 'copy-first-time'));
});

test('the ledger file is the only durable state the re-import rewrites', async () => {
  const raw = await readFile(ledgerPath(), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.ok(Object.keys(parsed.imports).length >= 1);
});
