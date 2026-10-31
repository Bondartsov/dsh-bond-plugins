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
const { assertEventStream, buildEvents } = await import('../lib/sessions/events.js');
const { signatureOf, updateImported } = await import('../lib/sessions/import.js');
const { recordImport } = await import('../lib/sessions/ledger.js');

/** Create the store fixture: one session with `count` messages. */
async function createFixture(dbPath, sessionId, count) {
  await mkdir(join(dbPath, '..'), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
  `);
  database
    .prepare('INSERT INTO session (id, directory, title, time_created, time_updated, task_type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, 'C:\\work\\upd', 'Updatable session', 1_000, 9_000, 'interactive');
  const insertMessage = database.prepare('INSERT INTO message (id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?)');
  const insertPart = database.prepare('INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?, ?)');
  for (let index = 0; index < count; index += 1) {
    const isUser = index % 2 === 0;
    const messageId = `m${index}`;
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
      `p${index}`,
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
  /** Rename requests the plugin made through `sessionController.rename`. */
  const renames = [];
  return {
    state,
    renames,
    get(name) {
      if (name === 'sessionController') {
        return {
          async rename(request) {
            renames.push(request);
            return { title: request.title };
          },
        };
      }
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
                // The real writer rejects a chunk that does not continue the stored numbering;
                // a lenient stub hides exactly the "append seq mismatch" bug.
                for (const event of events) {
                  if (event.seq !== state.events.length) {
                    throw new Error(
                      `append seq mismatch: expected ${state.events.length} at index 0, got ${event.seq}`,
                    );
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
  const { sourceById } = await import('../lib/sessions/sources/index.js');
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
  const { sourceById } = await import('../lib/sessions/sources/index.js');
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
  const { sourceById } = await import('../lib/sessions/sources/index.js');
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
  const { sourceById } = await import('../lib/sessions/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  const header = { id: `session-${sessionId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(full, header);
  // This copy no longer matches its origin (its first user message was rewritten here), so the
  // watermark cannot be proven and appending would duplicate history.
  const tampered = events.map((event) =>
    event.type === 'user/message' && Array.isArray(event.data?.content)
      ? { ...event, data: { ...event.data, content: [{ type: 'text', text: 'переписано вручную' }] } }
      : event,
  );
  const ctx = hostStub(tampered);
  await recordImport({ source: 'kilo', foreignId: sessionId, sessionId: header.id, title: full.title, cwd: 'C:\\work\\upd', eventCount: tampered.length });
  const report = await updateImported(ctx, ref);
  assert.ok(['needs-reimport', 'diverged'].includes(report.status), `a tampered copy is refused, got ${report.status}`);
  assert.equal(report.rebuilt, undefined, 'a copy that is not provably untouched is never rebuilt silently');
  assert.equal(ctx.state.events.length, tampered.length, 'nothing is appended');
});



test('hasOpenTurn reads lifecycle markers, not the last stored row', async () => {
  const { hasOpenTurn } = await import('../lib/sessions/import.js');
  assert.equal(
    hasOpenTurn([{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'session/title' }]),
    false,
    'service events after turn/end do not open a turn',
  );
  assert.equal(hasOpenTurn([{ type: 'turn/start' }, { type: 'turn/end' }, { type: 'turn/start' }]), true);
  assert.equal(hasOpenTurn([{ type: 'turn/start' }, { type: 'step/start' }, { type: 'step/end' }]), true, 'the turn is still open');
  assert.equal(hasOpenTurn([{ type: 'turn/start' }, { type: 'step/start' }]), true);
  assert.equal(hasOpenTurn([{ type: 'session/title' }]), false);
  assert.equal(hasOpenTurn([]), false);
});

test('a finished copy whose log ends with service events is updated, not called busy', async () => {
  const localId = 'ses_service_tail';
  const db = join(home, 'kilo-home', 'kilo-tail.db');
  await createFixture(db, localId, 4);
  const ref = { source: 'kilo', id: localId, path: db };
  const { sourceById } = await import('../lib/sessions/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  const imported = { ...full, messages: full.messages.slice(0, 2) };
  const header = { id: `session-${localId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(imported, header);
  // DSH appends service rows after the closing turn/end; none of them is a lifecycle marker.
  const service = [
    { type: 'session/title', data: { title: 'x' } },
    { type: 'permission/preset', data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
    { type: 'session/end-seed', data: {} },
  ].map((event, index) => ({ ...event, seq: events.length + index, at: 1_000 + index }));
  const signature = signatureOf(imported.messages);
  await recordImport({
    source: 'kilo',
    foreignId: localId,
    sessionId: header.id,
    title: imported.title,
    cwd: 'C:\\work\\upd',
    eventCount: events.length,
    foreignMessageCount: signature.count,
    foreignPrefixHash: signature.prefixHash,
  });

  const ctx = hostStub([...events, ...service]);
  const report = await updateImported(ctx, ref);
  assert.notEqual(report.status, 'busy', 'a log ending with service events is not a running turn');
  assert.equal(report.status, 'updated');
  assert.equal(report.addedMessages, 2, 'the tail of the origin is appended');
  // The stub writer is strict about seq: reaching here proves the numbering continues.
  assert.ok(ctx.state.events.length > events.length + service.length, 'the log grew by the new tail');
});

test('the appended tail continues the stored seq numbering even when it starts above zero', async () => {
  const localId = 'ses_seq_offset';
  const db = join(home, 'kilo-home', 'kilo-seq.db');
  await createFixture(db, localId, 4);
  const ref = { source: 'kilo', id: localId, path: db };
  const { sourceById } = await import('../lib/sessions/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  const imported = { ...full, messages: full.messages.slice(0, 2) };
  const header = { id: `session-${localId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(imported, header);
  // A store whose numbering starts at 100: the base must come from the last stored seq.
  const shifted = events.map((event, index) => ({ ...event, seq: 100 + index }));
  const signature = signatureOf(imported.messages);
  await recordImport({
    source: 'kilo',
    foreignId: localId,
    sessionId: header.id,
    title: imported.title,
    cwd: 'C:\\work\\upd',
    eventCount: shifted.length,
    foreignMessageCount: signature.count,
    foreignPrefixHash: signature.prefixHash,
  });

  const state = { events: [...shifted] };
  const ctx = {
    state,
    get(name) {
      if (name === 'sessionQuery') {
        return { async readSession() { return { session: { createdAt: 1_000, cwd: 'C:\\work\\upd' }, events: state.events }; } };
      }
      if (name === 'sessionPersistence') {
        return {
          async open() {
            return {
              async read() {},
              async append(chunk) {
                const expected = state.events[state.events.length - 1].seq + 1;
                if (chunk[0].seq !== expected) {
                  throw new Error(`append seq mismatch: expected ${expected} at index 0, got ${chunk[0].seq}`);
                }
                for (const event of chunk) state.events.push({ ...event });
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

  const report = await updateImported(ctx, ref);
  assert.equal(report.status, 'updated');
  assert.equal(state.events[shifted.length].seq, 100 + shifted.length, 'the first appended event continues the stored range');
});

test('a row without a watermark is proven and appended, never rebuilt into a new copy', async () => {
  const localId = 'ses_no_watermark_proof';
  const db = join(home, 'kilo-home', 'kilo-proof.db');
  await createFixture(db, localId, 4);
  const ref = { source: 'kilo', id: localId, path: db };
  const { sourceById } = await import('../lib/sessions/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  const imported = { ...full, messages: full.messages.slice(0, 2) };
  const header = { id: `session-${localId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(imported, header);
  // A ledger row written before watermarks existed: no foreignMessageCount, no prefix hash.
  await recordImport({
    source: 'kilo',
    foreignId: localId,
    sessionId: header.id,
    title: imported.title,
    cwd: 'C:\\work\\upd',
    eventCount: events.length,
  });

  const ctx = hostStub(events);
  const report = await updateImported(ctx, ref);

  assert.notEqual(report.status, 'needs-reimport', 'a provable copy is not a dead end');
  assert.equal(report.rebuilt, undefined, 'no rebuild, so no new session id and no duplicate row');
  assert.equal(report.sessionId, header.id, 'the copy keeps its identity');
  assert.equal(report.status, 'updated');
  assert.equal(report.addedMessages, 2, 'the tail of the origin is appended after the proof');
});

test('a renamed origin renames the copy on update, keeping its identity', async () => {
  const localId = 'ses_title_sync';
  const db = join(home, 'kilo-home', 'kilo-title.db');
  await createFixture(db, localId, 4);
  const ref = { source: 'kilo', id: localId, path: db };
  const { sourceById } = await import('../lib/sessions/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  const imported = { ...full, title: 'ИБ Э2 извлечение', messages: full.messages.slice(0, 4) };
  const header = { id: `session-${localId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(imported, header);
  const signature = signatureOf(imported.messages);
  await recordImport({
    source: 'kilo',
    foreignId: localId,
    sessionId: header.id,
    title: imported.title,
    cwd: 'C:\\work\\upd',
    eventCount: events.length,
    turnCount: 1,
    foreignMessageCount: signature.count,
    foreignPrefixHash: signature.prefixHash,
  });

  const ctx = hostStub(events);
  const report = await updateImported(ctx, ref);

  assert.equal(report.status, 'up-to-date', 'the messages did not change');
  assert.equal(report.sessionId, header.id, 'the copy keeps its identity');
  assert.equal(ctx.renames.length, 1, 'the origin name reached the copy');
  assert.equal(ctx.renames[0].sessionId, header.id);
  assert.equal(ctx.renames[0].title, full.title, 'the copy takes the origin title verbatim');
  assert.equal(report.renamedTitle, full.title, 'the report names the change');
});

test('a copy renamed here keeps its name: the origin never overwrites the owner', async () => {
  const localId = 'ses_title_owner';
  const db = join(home, 'kilo-home', 'kilo-title-owner.db');
  await createFixture(db, localId, 4);
  const ref = { source: 'kilo', id: localId, path: db };
  const { sourceById } = await import('../lib/sessions/sources/index.js');
  const adapter = sourceById('kilo');
  const full = await adapter.readSession(ref);
  const imported = { ...full, title: full.title, messages: full.messages.slice(0, 4) };
  const header = { id: `session-${localId}`, createdAt: 1_000, cwd: 'C:\\work\\upd' };
  const { events } = buildEvents(imported, header);
  // The owner renamed the copy in the sidebar: its own log carries a different title.
  const renamedHere = events.map((event) =>
    event.type === 'session/title' ? { ...event, data: { ...event.data, title: 'Моё имя' } } : event,
  );
  const signature = signatureOf(imported.messages);
  await recordImport({
    source: 'kilo',
    foreignId: localId,
    sessionId: header.id,
    title: imported.title,
    cwd: 'C:\\work\\upd',
    eventCount: renamedHere.length,
    turnCount: 1,
    foreignMessageCount: signature.count,
    foreignPrefixHash: signature.prefixHash,
  });

  const ctx = hostStub(renamedHere);
  const report = await updateImported(ctx, ref);

  assert.equal(ctx.renames.length, 0, 'the owner name is never overwritten');
  assert.equal(report.renamedTitle, undefined);
});
