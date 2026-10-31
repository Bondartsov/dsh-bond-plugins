/**
 * Guard tests for the foreign source adapters.
 *
 * Each adapter is driven over a faithful fixture of its own store, then the
 * produced transcript is pushed through the event synthesizer and the V4 guard:
 * an adapter that misreads its store fails here instead of writing an
 * unreadable session.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertEventStream, buildEvents } from '../lib/sessions/events.js';

const home = await mkdtemp(join(tmpdir(), 'dsh-agent-import-sources-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.DSH_HOME = join(home, '.dsh');
process.env.KILO_HOME = join(home, 'kilo-home');

const claudeCode = await import('../lib/sessions/sources/claude-code.js');
const codex = await import('../lib/sessions/sources/codex.js');
const zcodeV2 = await import('../lib/sessions/sources/zcode-v2.js');
const { createSqliteFamilySource } = await import('../lib/sessions/sources/sqlite-agent-family.js');

/** Serialize one JSON-lines file. */
async function writeJsonLines(path, records) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

/** Build a valid session log from a transcript, refusing an invalid one. */
function eventsOf(transcript) {
  const built = buildEvents(transcript, { id: 'session-fixture', createdAt: 1_700_000_000_000, cwd: home });
  assertEventStream(built.events);
  return built.events;
}

test('claude code: listing reads the project path, the rename and the first prompt', async () => {
  const projectDir = join(home, '.claude', 'projects', '-tmp-demo-project');
  const sessionId = '11111111-2222-3333-4444-555555555555';
  await writeJsonLines(join(projectDir, `${sessionId}.jsonl`), [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      isSidechain: false,
      cwd: 'C:\\demo\\project',
      sessionId,
      timestamp: '2026-01-02T03:04:05.000Z',
      message: { role: 'user', content: 'Why does the login loop?' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      cwd: 'C:\\demo\\project',
      sessionId,
      timestamp: '2026-01-02T03:04:06.000Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [
          { type: 'thinking', thinking: 'the redirect target is wrong' },
          { type: 'text', text: 'The redirect target points at /login.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'auth.ts' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      cwd: 'C:\\demo\\project',
      sessionId,
      timestamp: '2026-01-02T03:04:07.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'redirect("/login")', is_error: false }],
      },
    },
    { type: 'custom-title', customTitle: 'Login redirect loop', sessionId, timestamp: '2026-01-02T03:05:00.000Z' },
  ]);

  const status = await claudeCode.status();
  assert.equal(status.available, true);

  const listed = await claudeCode.listSessions({ limit: 10 });
  assert.equal(listed.sessions.length, 1);
  const row = listed.sessions[0];
  assert.equal(row.id, sessionId);
  assert.equal(row.title, 'Login redirect loop');
  assert.equal(row.cwd, 'C:\\demo\\project');

  const transcript = await claudeCode.readSession(row);
  assert.equal(transcript.title, 'Login redirect loop');
  assert.equal(transcript.model.model, 'claude-sonnet-4-5');
  assert.equal(transcript.messages.filter((message) => message.role === 'user').length, 1, 'a tool result is not a human prompt');
  assert.equal(transcript.messages.filter((message) => message.role === 'tool').length, 1);

  const events = eventsOf(transcript);
  assert.equal(events.filter((event) => event.type === 'tool/call').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool/result').length, 1);
});

test('claude code: a sidechain record is not imported as the main conversation', async () => {
  const projectDir = join(home, '.claude', 'projects', '-tmp-demo-side');
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await writeJsonLines(join(projectDir, `${sessionId}.jsonl`), [
    { type: 'user', cwd: 'C:\\demo', sessionId, timestamp: '2026-01-02T03:04:05.000Z', message: { role: 'user', content: 'main prompt' } },
    {
      type: 'assistant',
      isSidechain: true,
      cwd: 'C:\\demo',
      sessionId,
      timestamp: '2026-01-02T03:04:06.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'subagent work' }] },
    },
  ]);
  const listed = await claudeCode.listSessions({ limit: 10, query: sessionId.slice(0, 8) });
  const transcript = await claudeCode.readSession(listed.sessions[0]);
  assert.equal(transcript.messages.some((message) => message.role === 'assistant'), false);
});

test('codex: a rollout becomes a replayable transcript with its tool call settled', async () => {
  const sessionId = '0199aaaa-1111-2222-3333-444444444444';
  const path = join(home, '.codex', 'sessions', '2026', '01', '02', `rollout-2026-01-02T03-04-05-${sessionId}.jsonl`);
  await writeJsonLines(path, [
    {
      timestamp: '2026-01-02T03:04:05.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'D:\\work\\codex-demo', model_provider: 'openai', timestamp: '2026-01-02T03:04:05.000Z' },
    },
    { timestamp: '2026-01-02T03:04:06.000Z', type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    {
      timestamp: '2026-01-02T03:04:07.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tests' }] },
    },
    {
      timestamp: '2026-01-02T03:04:08.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'need the test command' }] },
    },
    {
      timestamp: '2026-01-02T03:04:09.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Running them now.' }] },
    },
    {
      timestamp: '2026-01-02T03:04:10.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}', call_id: 'call_1' },
    },
    {
      timestamp: '2026-01-02T03:04:11.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'all green' },
    },
  ]);

  const status = await codex.status();
  assert.equal(status.available, true);

  const listed = await codex.listSessions({ limit: 10 });
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].id, sessionId);
  assert.equal(listed.sessions[0].cwd, 'D:\\work\\codex-demo');

  const transcript = await codex.readSession({ ...listed.sessions[0], title: 'Run the tests' });
  assert.equal(transcript.model.provider, 'openai');
  const assistant = transcript.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.content[0].type, 'reasoning');
  assert.equal(assistant.content.some((block) => block.type === 'tool-call'), true);

  const events = eventsOf({ ...transcript, title: 'Run the tests' });
  assert.equal(events.filter((event) => event.type === 'tool/call').length, 1);
});

test('zcode v2: a text-only document imports and reports its tool loss', async () => {
  const path = join(home, '.zcode', 'v2', 'sessions', 'abcdef123456', 'task-42.json');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      meta: {
        taskId: 'task-42',
        title: 'ZCode session',
        workspacePath: 'C:\\work\\zcode',
        createdAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-01-02T04:04:05.000Z',
      },
      messages: [
        { role: 'user', content: 'hello', timestamp: '2026-01-02T03:04:06.000Z', turnIndex: 0 },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool', name: 'bash' }], timestamp: '2026-01-02T03:04:07.000Z' },
      ],
    }),
    'utf8',
  );

  const status = await zcodeV2.status();
  assert.equal(status.available, true);

  const listed = await zcodeV2.listSessions({ limit: 10 });
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].title, 'ZCode session');

  const transcript = await zcodeV2.readSession(listed.sessions[0]);
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.notes.length, 1, 'the tool loss is reported, not hidden');
  eventsOf(transcript);
});

test('sqlite family: listing and transcript read through the real schema', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = join(home, 'kilo-home', 'kilo.db');
  await mkdir(join(dbPath, '..'), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
  `);
  const sessionId = 'ses_kilo_1';
  database
    .prepare('INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, 'p1', 'C:\\work\\kilo', 'Kilo session', 1_700_000_000_000, 1_700_000_100_000);
  const insertMessage = database.prepare('INSERT INTO message (id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?)');
  insertMessage.run('msg_u', sessionId, 1_700_000_000_100, JSON.stringify({ role: 'user', time: { created: 1_700_000_000_100 } }), 1);
  insertMessage.run(
    'msg_a',
    sessionId,
    1_700_000_000_200,
    JSON.stringify({ role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4', time: { created: 1_700_000_000_200 } }),
    2,
  );
  const insertPart = database.prepare('INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?, ?)');
  insertPart.run('part_u1', 'msg_u', sessionId, 1_700_000_000_100, JSON.stringify({ type: 'text', text: 'check the deploy' }), 1);
  insertPart.run('part_a1', 'msg_a', sessionId, 1_700_000_000_200, JSON.stringify({ type: 'reasoning', text: 'look at the log' }), 0);
  insertPart.run(
    'part_a2',
    'msg_a',
    sessionId,
    1_700_000_000_210,
    JSON.stringify({
      type: 'tool',
      tool: 'bash',
      callID: 'call_k1',
      state: { status: 'completed', input: { cmd: 'ls' }, output: 'a.txt' },
    }),
    1,
  );
  insertPart.run('part_a3', 'msg_a', sessionId, 1_700_000_000_220, JSON.stringify({ type: 'text', text: 'The deploy is red.' }), 2);
  database.close();

  const kilo = createSqliteFamilySource({
    id: 'kilo',
    label: 'KiloCode',
    dbPath: () => dbPath,
    unavailableHint: 'fixture',
  });

  const status = await kilo.status();
  assert.equal(status.available, true, `status failed: ${status.reason ?? ''}`);

  const listed = await kilo.listSessions({ limit: 10 });
  assert.equal(listed.total, 1);
  const row = listed.sessions[0];
  assert.equal(row.id, sessionId);
  assert.equal(row.title, 'Kilo session');
  assert.equal(row.cwd, 'C:\\work\\kilo');

  const transcript = await kilo.readSession(row);
  assert.equal(transcript.model.provider, 'anthropic');
  assert.equal(transcript.model.model, 'claude-sonnet-4');
  assert.equal(transcript.messages.filter((message) => message.role === 'user').length, 1);
  const assistant = transcript.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.content.some((block) => block.type === 'tool-call'), true);

  const events = eventsOf({ ...transcript, title: 'Kilo session' });
  assert.equal(events.filter((event) => event.type === 'tool/call').length, 1);
  assert.equal(events.filter((event) => event.type === 'tool/result').length, 1);
});

test('sqlite family: a missing database reports itself unavailable instead of throwing', async () => {
  const missing = createSqliteFamilySource({
    id: 'opencode',
    label: 'OpenCode',
    dbPath: () => join(home, 'missing', 'opencode.db'),
    unavailableHint: 'fixture hint',
  });
  const status = await missing.status();
  assert.equal(status.available, false);
  assert.match(status.reason, /not found/);
});

test('sqlite family: search filters by title', async () => {
  const dbPath = join(home, 'kilo-home', 'kilo.db');
  const kilo = createSqliteFamilySource({ id: 'kilo', label: 'KiloCode', dbPath: () => dbPath, unavailableHint: 'fixture' });
  const hit = await kilo.listSessions({ limit: 10, query: 'Kilo' });
  assert.equal(hit.total, 1);
  const miss = await kilo.listSessions({ limit: 10, query: 'nothing-here' });
  assert.equal(miss.total, 0);
});

test('sqlite family: spawned sessions are children, a user fork stays top-level', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = join(home, 'kilo-home', 'kilo2.db');
  await mkdir(join(dbPath, '..'), { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT, sequence INTEGER);
  `);
  const insert = database.prepare(
    'INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, task_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('ses_parent', null, 'C:\\work\\k2', 'Parent session', 1000, 9000, 'interactive');
  insert.run('ses_child', 'ses_parent', 'C:\\work\\k2', 'Spawned run', 2000, 3000, 'subagent_child');
  insert.run('ses_fork', 'ses_parent', 'C:\\work\\k2', 'User fork', 4000, 5000, 'fork');
  insert.run('ses_wf', 'ses_parent', 'C:\\work\\k2', 'Workflow run', 6000, 7000, 'workflow_child');
  database.close();

  const store = createSqliteFamilySource({ id: 'kilo', label: 'KiloCode', dbPath: () => dbPath, unavailableHint: 'fixture' });
  const listed = await store.listSessions({ limit: 10 });
  const byId = new Map(listed.sessions.map((row) => [row.id, row]));
  assert.equal(byId.get('ses_parent').child, false);
  assert.equal(byId.get('ses_fork').child, false, 'a user fork is a session of its own');
  assert.equal(byId.get('ses_child').child, true);
  assert.equal(byId.get('ses_child').parentId, 'ses_parent');
  assert.equal(byId.get('ses_child').childKind, 'subagent_child');
  assert.equal(byId.get('ses_wf').childKind, 'workflow_child');

  const children = await store.childSessions({ id: 'ses_parent', path: dbPath });
  assert.deepEqual(
    children.map((row) => row.id),
    ['ses_child', 'ses_wf'],
    'only spawned runs are offered as context, oldest first',
  );
});
