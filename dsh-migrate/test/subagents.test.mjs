/**
 * Guard tests for subagent context folding and for tail synthesis.
 *
 * A spawned (subagent) run is not a session of its own for the user, but its
 * content must still reach the model when the parent session is continued. An
 * update appends only the new tail, so it must start after the last turn and add
 * no second system head.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertEventStream, buildEvents } from '../lib/sessions/events.js';
import { signatureOf, withSubagentContext } from '../lib/sessions/import.js';

const header = { id: 'session-appendix', createdAt: 1_700_000_000_000, cwd: 'D:\\work' };

/** A parent transcript with one finished turn. */
const parentTranscript = () => ({
  source: 'zcode-cli',
  label: 'ZCode',
  foreignId: 'parent-1',
  title: 'Parent session',
  cwd: 'D:\\work',
  createdAt: 1_700_000_000_000,
  model: { provider: 'zai', model: 'glm-4.6' },
  messages: [
    { role: 'user', text: 'do the thing' },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ],
});

/** One spawned transcript that calls a tool. */
const childMessages = () => [
  { role: 'user', text: 'explore the repo' },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'Read', arguments: '{"path":"a"}' }] },
  { role: 'tool', callId: 'c1', text: 'a.txt' },
];

const contextOf = (index, extra = {}) => ({
  title: `Run ${index}`,
  foreignId: `child-${index}`,
  childKind: 'subagent_child',
  messages: childMessages(),
  ...extra,
});

test('a spawned run becomes one delimited appendix turn of its parent', () => {
  const parent = parentTranscript();
  const appended = withSubagentContext(parent, [contextOf(1, { title: 'Explore repo' })]);

  assert.equal(appended, 1);
  assert.equal(parent.messages.length, 6, 'marker plus the three child messages follow the parent dialogue');
  assert.match(parent.messages[2].text, /subagent transcript 1/u);
  assert.match(parent.messages[2].text, /Explore repo/u);
  assert.equal(parent.notes.length, 1);

  const { events } = buildEvents(parent, header);
  assertEventStream(events);
  assert.deepEqual(
    events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn),
    [1, 2, 3],
    'the parent turn, the marker turn and the spawned prompt turn',
  );
});

test('two spawned runs never share a tool call id', () => {
  const parent = parentTranscript();
  withSubagentContext(parent, [contextOf(1), contextOf(2, { childKind: 'workflow_child' })]);

  const { events } = buildEvents(parent, header);
  assertEventStream(events);
  const calls = events.filter((event) => event.type === 'tool/call').map((event) => event.data.callId);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1], 'a provider-local id must not collide across children');
  const advertised = events
    .filter((event) => event.type === 'assistant/message')
    .flatMap((event) => event.data.message.content)
    .filter((block) => block.type === 'tool-call')
    .map((block) => block.id);
  assert.deepEqual(advertised.sort(), calls.slice().sort(), 'advertised ids and started calls agree');
});

test('a context without messages is skipped', () => {
  const parent = parentTranscript();
  const appended = withSubagentContext(parent, [{ title: 'Empty', foreignId: 'empty', messages: [] }, contextOf(2)]);
  assert.equal(appended, 1);
  assert.equal(parent.notes.length, 1);
  assertEventStream(buildEvents(parent, header).events);
});

test('an empty context list adds nothing', () => {
  const parent = parentTranscript();
  assert.equal(withSubagentContext(parent, []), 0);
  assert.equal(parent.messages.length, 2);
  assert.equal(parent.notes, undefined);
});

test('the appendix is capped so one huge parent cannot explode its log', () => {
  const parent = parentTranscript();
  const contexts = Array.from({ length: 60 }, (_, index) => contextOf(index));
  assert.equal(withSubagentContext(parent, contexts), 50);
  assertEventStream(buildEvents(parent, header).events);
});

test('a tail update starts after the last turn and adds no second system head', () => {
  const tail = {
    source: 'zcode-cli',
    label: 'ZCode',
    foreignId: 'parent-1',
    title: 'Parent session',
    cwd: 'D:\\work',
    model: { provider: 'zai', model: 'glm-4.6' },
    messages: [
      { role: 'user', text: 'a new prompt' },
      { role: 'assistant', content: [{ type: 'text', text: 'new answer' }] },
    ],
  };
  const { events } = buildEvents(tail, header, { startTurn: 5, emitSystemHead: false, emitTitle: false });
  assertEventStream(events, { startTurn: 5, requireHead: false });
  assert.equal(events.filter((event) => event.type === 'system/message').length, 0, 'the head already exists');
  assert.equal(events.filter((event) => event.type === 'session/title').length, 0, 'the pinned title stays');
  assert.deepEqual(events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn), [5]);
});

test('the guard distinguishes a whole import from a tail', () => {
  const tail = buildEvents(parentTranscript(), header, { startTurn: 2, emitSystemHead: false, emitTitle: false }).events;
  assert.equal(tail.filter((event) => event.type === 'system/message').length, 0);
  // A tail is legitimately headless, but only the caller that appends knows that:
  // the default guard still demands a protected head.
  assert.doesNotThrow(() => assertEventStream(tail, { startTurn: 2, requireHead: false }));
  assert.throws(() => assertEventStream(tail, { startTurn: 2 }), /protected system head/u);
});

test('the source signature fingerprints the opening and survives appends', () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', text: `m${index}` }));
  const first = signatureOf(messages);
  assert.equal(first.count, 8);
  assert.match(first.prefixHash, /^[0-9a-f]{16}$/u);
  const updated = signatureOf([...messages, { role: 'user', text: 'later' }]);
  assert.equal(updated.prefixHash, first.prefixHash, 'appending does not change the opening');
  assert.equal(updated.count, 9);
  const rewritten = signatureOf([{ role: 'user', text: 'compacted' }, ...messages]);
  assert.notEqual(rewritten.prefixHash, first.prefixHash, 'a rewritten history is detected');
});

