/**
 * Guard tests for updating an already imported session.
 *
 * An update must append only what appeared in the origin since the import, keep
 * the session identity, and refuse to touch a copy whose origin rewrote its
 * history. The Host persistence and query services are stubbed here, so the test
 * pins the plugin's own logic rather than the harness.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'dsh-agent-import-update-'));
process.env.DSH_HOME = join(home, '.dsh');
process.env.KILO_HOME = join(home, 'kilo-home');

const { DatabaseSync } = await import('node:sqlite');
const { assertEventStream, buildEvents } = await import('../lib/events.js');
const { hasOpenTurn, reimportImported, signatureOf, updateImported } = await import('../lib/import.js');
const { recordImport } = await import('../lib/ledger.js');

/** Create the store fixture: one session with `count` messages. */
async function createFixture(dbPath, sessionId, count) {
  await mkdir(join(dbPath, '..'), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT);
    CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
  `);
  database
    .prepare('INSERT INTO session (id, directory, title, time_created, time_updated, task_type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, 'C:\\work\\upd', 'Updatable session', 1_000, 9_000, 'interactive');
  const insertMessage = database.prepare('INSERT INTO message (id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?)');
  const insertPart = database.prepare('INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?, ?)');
  for (let index = 0; index < count; index += 1) {
    const isUser = index % 2 === 0;
    const messageId = `${sessionId}-m${index}`;
    insertMessage.run(
      messageId,
      sessionId,
      1_000 + index,
      JSON.stringify(
        isUser
          ? { role: 'user', time: { created: 1_000 + index } }
          : { role: 'assistant', providerID: 'zai', modelID: 'glm-4.6', time: { created: 1_000 + index } },
      ),
      index,
    );
    insertPart.run(
      `${sessionId}-p${index}`,
      messageId,
      sessionId,
      1_000 + index,
      JSON.stringify({ type: 'text', text: isUser ? `prompt ${index}` : `answer ${index}` }),
      index,
    );
  }
  database.close();
}

/** A Host stub: one in-memory log plus the two services the update needs. */
function hostStub(initialEvents) {
  const state = { events: [...initialEvents] };
  return {
    state,
    get(name) {
      if (name === 'sessionQuery') {
        return {
          async readSession() {
            return { session: { createdAt: 1_000, cwd: 'C:\\work\\upd' }, events: state.events, inheritedEventCount: 0 };
          },
        };
      }
      if (name === 'sessionPersistence') {
        return {
          async open() {
            return {
              async read() {},
              async append(events) {
                // The real writer rejects a chunk that does not continue the log.
                let maxSeq = -1;
                for (const saved of state.events) {
                  if (Number.isSafeInteger(saved?.seq) && saved.seq > maxSeq) maxSeq = saved.seq;
                }
                const expectedBase = maxSeq >= 0 ? maxSeq + 1 : state.events.length;
                for (const event of events) {
                  if (event.seq !== expectedBase + events.indexOf(event)) {
                    throw new Error(`append seq mismatch: expected {expectedBase}, got {event.seq}`);
                  }
                  state.events.push({ ...event });
                }
              },
              async flush() {},
              async close() {},
            };
          },
        };
      }
      return undefined;
    },
  };
}

const dbPath = () => join(home, 'kilo-home', 'kilo.db');
const sessionId = 'ses_updatable';

test('an update appends only the new tail and keeps the session identity', async () => {
  await createFixture(dbPath(), sessionId, 6);
  const ref = { source: 'kilo', id: sessionId, path: dbPath() };

  // The plugin's own view of the origin: import the first four messages only.
  const { sourceById } = await import('../lib/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  assert.equal(full.messages.length, 6);
  const imported = { ...full, messages: full.messages.slice(0, 4) };
  const header = { id: `session-${sessionId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(imported, header);
  assertEventStream(events);

  const signature = signatureOf(imported.messages);
  await recordImport({
    source: 'kilo',
    foreignId: sessionId,
    sessionId: header.id,
    title: imported.title,
    cwd: 'C:\\work\\upd',
    eventCount: events.length,
    foreignMessageCount: signature.count,
    foreignPrefixHash: signature.prefixHash,
  });

  const ctx = hostStub(events);
  const report = await updateImported(ctx, ref);

  assert.equal(report.status, 'updated');
  assert.equal(report.addedMessages, 2, 'only the two messages that appeared later are appended (one further turn)');
  assert.equal(report.verified, true);
  assert.equal(report.sessionId, header.id, 'the session identity is preserved');
  assert.ok(ctx.state.events.length > events.length, 'the log grew');

  const appended = ctx.state.events.slice(events.length);
  const turns = appended.filter((event) => event.type === 'turn/start').map((event) => event.data.turn);
  assert.deepEqual(turns, [3], 'turn numbering continues after the imported log');
  assert.equal(appended.filter((event) => event.type === 'system/message').length, 0, 'no second system head');
  assert.equal(appended.filter((event) => event.type === 'session/title').length, 0, 'the title is not rewritten');
});

test('a second update finds nothing new and writes nothing', async () => {
  const ref = { source: 'kilo', id: sessionId, path: dbPath() };
  const { sourceById } = await import('../lib/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  const header = { id: `session-${sessionId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(full, header);
  const ctx = hostStub(events);
  const report = await updateImported(ctx, ref);
  assert.equal(report.status, 'up-to-date');
  assert.equal(report.addedMessages, 0);
  assert.equal(ctx.state.events.length, events.length);
});

test('an origin that rewrote its history is reported instead of appended', async () => {
  const ref = { source: 'kilo', id: sessionId, path: dbPath() };
  const { sourceById } = await import('../lib/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  const header = { id: `session-${sessionId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(full, header);
  const ctx = hostStub(events);
  // A watermark that does not match the origin's prefix means the origin was
  // compacted or edited; appending would mix two different histories.
  await recordImport({
    source: 'kilo',
    foreignId: sessionId,
    sessionId: header.id,
    title: full.title,
    cwd: 'C:\\work\\upd',
    eventCount: events.length,
    foreignMessageCount: 6,
    foreignPrefixHash: 'deadbeefdeadbeef',
  });
  const report = await updateImported(ctx, ref);
  assert.equal(report.status, 'diverged');
  assert.equal(report.addedMessages, 0);
  assert.equal(ctx.state.events.length, events.length);
});

test('an entry without a watermark asks for a clean re-import instead of duplicating', async () => {
  const ref = { source: 'kilo', id: sessionId, path: dbPath() };
  const { sourceById } = await import('../lib/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  const header = { id: `session-${sessionId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(full, header);
  const ctx = hostStub(events);
  await recordImport({ source: 'kilo', foreignId: sessionId, sessionId: header.id, title: full.title, cwd: 'C:\\work\\upd', eventCount: events.length });
  const report = await updateImported(ctx, ref);
  assert.equal(report.status, 'needs-reimport');
  assert.equal(ctx.state.events.length, events.length);
});
test('service events after the closing turn do not make an update look busy', async () => {
  const tailId = 'ses_tail';
  await createFixture(dbPath(), tailId, 6);
  const ref = { source: 'kilo', id: tailId, path: dbPath() };
  const { sourceById } = await import('../lib/sources/index.js');
  const full = await sourceById('kilo').readSession(ref);
  const imported = { ...full, messages: full.messages.slice(0, 4) };
  const header = { id: `session-${tailId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(imported, header);
  // DSH appends service events after the closing event of a finished turn; the
  // tail must be judged by lifecycle markers, not by the last row.
  const withServiceTail = [...events, { type: 'model/selection', seq: events.length, time: events.at(-1).time + 1, data: { model: 'zai/glm-4.6' } }];
  const signature = signatureOf(imported.messages);
  await recordImport({
    source: 'kilo',
    foreignId: tailId,
    sessionId: header.id,
    title: imported.title,
    cwd: 'C:\\work\\upd',
    eventCount: events.length,
    turnCount: events.filter((event) => event.type === 'turn/start').length,
    foreignMessageCount: signature.count,
    foreignPrefixHash: signature.prefixHash,
  });

  const ctx = hostStub(withServiceTail);
  const report = await updateImported(ctx, ref);
  assert.equal(report.status, 'updated', 'a service event after turn/end is not a running session');
  assert.equal(report.addedTurns, 1);
});

test('an open turn is reported as busy instead of being written into', () => {
  const closed = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'session/title', data: { title: 'x', messageSeqs: [], source: { kind: 'user' } } },
  ];
  assert.equal(hasOpenTurn(closed), false);
  assert.equal(hasOpenTurn([...closed, { type: 'turn/start', data: { turn: 2 } }]), true, 'an open turn');
  assert.equal(
    hasOpenTurn([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'assistant/message', data: { turn: 1, step: 1 } },
    ]),
    true,
    'an open step',
  );
  assert.equal(hasOpenTurn([]), false);
});
test('a refused rebuild reports failure, keeps the old mapping and deletes nothing', async () => {
  const reimportId = 'ses_reimport';
  await createFixture(dbPath(), reimportId, 6);
  const ref = { source: 'kilo', id: reimportId, path: dbPath() };
  const { sourceById } = await import('../lib/sources/index.js');
  const full = await sourceById('kilo').readSession(ref);
  const header = { id: 'session-original-copy', createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(full, header);
  const signature = signatureOf(full.messages);
  await recordImport({
    source: 'kilo',
    foreignId: reimportId,
    sessionId: header.id,
    title: full.title,
    cwd: 'C:\\work\\upd',
    eventCount: events.length,
    turnCount: events.filter((event) => event.type === 'turn/start').length,
    foreignMessageCount: signature.count,
    foreignPrefixHash: signature.prefixHash,
  });

  // The store refuses the new copy the way the real one does when it still knows
  // the identity: the rebuild must say so instead of pretending to succeed.
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return { async readSession() { return { session: { createdAt: 1_000, cwd: 'C:\\work\\upd' }, events, inheritedEventCount: 0 }; } };
      }
      if (name === 'sessionPersistence') {
        return {
          async open() {
            return { async read() {}, async append() {}, async flush() {}, async close() {} };
          },
          async create() {
            throw Object.assign(new Error('Session already exists'), { name: 'SessionAlreadyExists' });
          },
        };
      }
      return undefined;
    },
  };

  const report = await reimportImported(ctx, ref);
  assert.equal(report.status, 'failed', 'a refused rebuild must not be reported as an update');
  assert.equal(report.rebuilt, false);

  const { findImport } = await import('../lib/ledger.js');
  const entry = findImport('kilo', reimportId);
  assert.equal(entry.sessionId, header.id, 'the ledger must still point at the copy that exists');
});
test('the tail continues numbering when the stored log does not start at zero', async () => {
  const shiftedId = 'ses_shifted';
  await createFixture(dbPath(), shiftedId, 6);
  const ref = { source: 'kilo', id: shiftedId, path: dbPath() };
  const { sourceById } = await import('../lib/sources/index.js');
  const full = await sourceById('kilo').readSession(ref);
  const imported = { ...full, messages: full.messages.slice(0, 4) };
  const header = { id: `session-${shiftedId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const local = buildEvents(imported, header);
  // Some stores keep a non-zero base; the writer continues from the last saved seq.
  const shifted = local.events.map((event) => ({ ...event, seq: event.seq + 100 }));
  const signature = signatureOf(imported.messages);
  await recordImport({
    source: 'kilo',
    foreignId: shiftedId,
    sessionId: header.id,
    title: imported.title,
    cwd: 'C:\\work\\upd',
    eventCount: shifted.length,
    turnCount: shifted.filter((event) => event.type === 'turn/start').length,
    foreignMessageCount: signature.count,
    foreignPrefixHash: signature.prefixHash,
  });

  const ctx = hostStub(shifted);
  const report = await updateImported(ctx, ref);
  assert.equal(report.status, 'updated', 'a non-zero base log must still accept the tail');
  const appended = ctx.state.events.slice(shifted.length);
  let maxSeq = -1;
  for (const event of shifted) if (Number.isSafeInteger(event.seq) && event.seq > maxSeq) maxSeq = event.seq;
  assert.equal(appended[0].seq, maxSeq + 1, 'the first tail event follows the highest saved seq');
});

