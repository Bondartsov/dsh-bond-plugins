/**
 * Guard tests for V4 event synthesis.
 *
 * These are Storozh tests: they pin the invariants an imported session must
 * satisfy to be readable and continuable by DSH. A change that silently relaxes
 * one of them fails here, before any session is written to the store.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  argumentsOf,
  assertEventStream,
  blocksFromStream,
  buildEvents,
  groupTurns,
  truncateTitle,
} from '../lib/sessions/events.js';

const header = { id: 'session-test', createdAt: 1_700_000_000_000, cwd: 'C:\\work\\demo' };

const transcript = (messages, extra = {}) => ({
  source: 'claude-code',
  label: 'Claude Code',
  foreignId: 'abc-123',
  title: 'Fix the login redirect',
  model: { provider: 'anthropic', model: 'claude-sonnet-4' },
  messages,
  ...extra,
});

test('a plain conversation produces a valid, closed V4 log', () => {
  const { events, title } = buildEvents(
    transcript([
      { role: 'user', text: 'Why does login loop?', at: 1_700_000_000_100 },
      {
        role: 'assistant',
        at: 1_700_000_000_200,
        content: [
          { type: 'reasoning', text: 'check the redirect target' },
          { type: 'text', text: 'The redirect target is wrong.' },
        ],
      },
    ]),
    header,
  );

  assertEventStream(events);
  assert.equal(title, 'Fix the login redirect');
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'turn/start',
      'step/start',
      'system/message',
      'user/message',
      'session/title',
      'assistant/message',
      'step/end',
      'turn/end',
    ],
  );
  events.forEach((event, index) => assert.equal(event.seq, index, 'seq must be dense from zero'));
});

test('the first surface event is always the protected system head', () => {
  const { events } = buildEvents(
    transcript([
      { role: 'user', text: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]),
    header,
  );
  assertEventStream(events);
  const surfaceTypes = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);
  const firstSurface = events.find((event) => surfaceTypes.has(event.type));
  assert.equal(firstSurface.type, 'system/message');
  assert.equal(firstSurface.surfaceOp, 'append');
  for (const block of firstSurface.data.message.content) assert.equal(block.type, 'text');
});

test('a tool call is advertised, started and settled inside one step', () => {
  const { events } = buildEvents(
    transcript([
      { role: 'user', text: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Listing.' },
          { type: 'tool-call', id: 'call_1', name: 'Bash', arguments: { cmd: 'ls' } },
        ],
      },
      { role: 'tool', callId: 'call_1', text: 'a.txt\nb.txt', isError: false },
    ]),
    header,
  );

  assertEventStream(events);
  const call = events.find((event) => event.type === 'tool/call');
  const result = events.find((event) => event.type === 'tool/result');
  const assistant = events.find((event) => event.type === 'assistant/message');
  const advertised = assistant.data.message.content.find((block) => block.type === 'tool-call');

  assert.equal(call.data.callId, 'call_1');
  assert.equal(call.surfaceOp, undefined, 'tool/call is not a surface event');
  assert.equal(call.sourceEventSeqs, undefined);
  assert.equal(call.data.arguments, advertised.arguments, 'arguments must be byte-identical');
  assert.equal(result.data.message.toolCallId, 'call_1');
  assert.deepEqual(result.sourceEventSeqs, [call.seq]);
  assert.equal(result.surfaceOp, 'append');
  assert.equal(assistant.sourceEventSeqs, undefined, 'assistant/message must not cite source events');
});

test('a call without a recorded result is dropped instead of leaving the step open', () => {
  const { events, droppedCalls } = buildEvents(
    transcript([
      { role: 'user', text: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Trying.' },
          { type: 'tool-call', id: 'call_lost', name: 'Bash', arguments: '{}' },
        ],
      },
    ]),
    header,
  );

  assertEventStream(events);
  assert.equal(droppedCalls, 1);
  assert.equal(events.filter((event) => event.type === 'tool/call').length, 0);
  const assistant = events.find((event) => event.type === 'assistant/message');
  assert.equal(assistant.data.message.content.filter((block) => block.type === 'tool-call').length, 0);
});

test('each human prompt opens a turn and every assistant message is a step', () => {
  const { events } = buildEvents(
    transcript([
      { role: 'user', text: 'first' },
      { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', text: 'second' },
      { role: 'assistant', content: [{ type: 'text', text: 'three' }] },
    ]),
    header,
  );

  assertEventStream(events);
  const turns = events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn);
  assert.deepEqual(turns, [1, 2]);
  const steps = events
    .filter((event) => event.type === 'step/start')
    .map((event) => `${event.data.turn}:${event.data.step}`);
  assert.deepEqual(steps, ['1:1', '1:2', '2:1'], 'steps restart at one inside each turn');
  const assignments = events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => `${event.data.turn}:${event.data.step}`);
  assert.deepEqual(assignments, ['1:1', '1:2', '2:1']);
});

test('the imported name is pinned through a user-sourced title event', () => {
  const { events } = buildEvents(transcript([{ role: 'user', text: 'hi' }], { title: '  My   session  ' }), header);
  const title = events.find((event) => event.type === 'session/title');
  assert.equal(title.data.title, 'My session');
  assert.deepEqual(title.data.messageSeqs, []);
  assert.equal(title.data.source.kind, 'user');
  assert.equal(title.surfaceOp, undefined);
});

test('a title without a recorded name falls back to the opening prompt', () => {
  const { title } = buildEvents(transcript([{ role: 'user', text: 'Why is the deploy red?' }], { title: '' }), header);
  assert.equal(title, 'Why is the deploy red?');
});

test('titles are truncated on a character boundary inside the byte budget', () => {
  const long = 'я'.repeat(200);
  const cut = truncateTitle(long);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 80);
  assert.ok(cut.length > 0);
  assert.ok(long.startsWith(cut));
});

test('the assistant stream reproduces the content it was built from', () => {
  const content = [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'answer' },
    { type: 'tool-call', id: 'c9', name: 'Read', arguments: '{"path":"a"}' },
  ];
  const { events } = buildEvents(
    transcript([
      { role: 'user', text: 'go' },
      { role: 'assistant', content },
      { role: 'tool', callId: 'c9', text: 'ok' },
    ]),
    header,
  );
  const assistant = events.find((event) => event.type === 'assistant/message');
  const rebuilt = blocksFromStream(assistant.data.stream);
  assert.deepEqual(rebuilt, assistant.data.message.content);
  assert.deepEqual(assistant.data.usage, undefined, 'no invented usage');
  assert.equal(assistant.data.message.source.replayState, undefined, 'foreign history replays without replay state');
});

test('images become a text placeholder because pi-ai cannot replay them', () => {
  const { events } = buildEvents(
    transcript([
      { role: 'user', text: 'look' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I see it.' },
          { type: 'image', data: 'AAA' },
        ],
      },
    ]),
    header,
  );
  assertEventStream(events);
  const assistant = events.find((event) => event.type === 'assistant/message');
  assert.equal(assistant.data.message.content.some((block) => block.type === 'image'), false);
});

test('an assistant message before any human prompt still opens a replayable turn', () => {
  const { events } = buildEvents(
    transcript([{ role: 'assistant', content: [{ type: 'text', text: 'orphan' }] }]),
    header,
  );
  assertEventStream(events);
  const user = events.find((event) => event.type === 'user/message');
  assert.ok(user !== undefined, 'a leading user message is required by every provider protocol');
  assert.equal(user.data.role, 'user');
  assert.equal(events[0].data.turn, 1);
});

test('an empty transcript still yields a readable session', () => {
  const { events } = buildEvents(transcript([]), header);
  assertEventStream(events);
  assert.equal(events.at(-1).type, 'turn/end');
});

test('a user message without an assistant reply closes its turn cleanly', () => {
  const { events } = buildEvents(transcript([{ role: 'user', text: 'pending question' }]), header);
  assertEventStream(events);
  const stepEnd = events.findIndex((event) => event.type === 'step/end');
  assert.ok(stepEnd > 0);
  assert.equal(events.at(-1).type, 'turn/end');
});

test('provider and model are always non-empty so foreign history is admissible', () => {
  const { events } = buildEvents(
    transcript(
      [
        { role: 'user', text: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
      { model: undefined },
    ),
    header,
  );
  const assistant = events.find((event) => event.type === 'assistant/message');
  assert.ok(assistant.data.message.source.provider.length > 0);
  assert.ok(assistant.data.message.source.model.length > 0);
});

/* ------------------------------------------------------------ guard: refusals */

const buildSimple = () =>
  buildEvents(
    transcript([
      { role: 'user', text: 'go' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: '{}' }] },
      { role: 'tool', callId: 'c1', text: 'ok' },
    ]),
    header,
  ).events;

test('a non-dense seq is refused', () => {
  const events = buildSimple();
  events[3] = { ...events[3], seq: 99 };
  assert.throws(() => assertEventStream(events), /seq must be dense/);
});

test('replacing the protected system head with a user message is refused', () => {
  const events = buildSimple();
  const index = events.findIndex((event) => event.type === 'system/message');
  events[index] = {
    ...events[index],
    type: 'user/message',
    data: { id: 'x', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
  };
  assert.throws(() => assertEventStream(events), /protected system head/);
});

test('an unresolved tool call at step end is refused', () => {
  const events = buildSimple().filter((event) => event.type !== 'tool/result').map((event, index) => ({ ...event, seq: index }));
  assert.throws(() => assertEventStream(events), /unresolved/);
});

test('a tool call whose arguments differ from the advertisement is refused', () => {
  const events = buildSimple();
  const index = events.findIndex((event) => event.type === 'tool/call');
  events[index] = { ...events[index], data: { ...events[index].data, arguments: '{"other":1}' } };
  assert.throws(() => assertEventStream(events), /arguments differ/);
});

test('a surface op on a non-surface event is refused', () => {
  const events = buildSimple();
  const index = events.findIndex((event) => event.type === 'tool/call');
  events[index] = { ...events[index], surfaceOp: 'append' };
  assert.throws(() => assertEventStream(events), /not a surface event/);
});

test('a stream that does not reproduce the content is refused', () => {
  const events = buildSimple();
  const index = events.findIndex((event) => event.type === 'assistant/message');
  events[index] = {
    ...events[index],
    data: { ...events[index].data, stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['other'] }] },
  };
  assert.throws(() => assertEventStream(events), /stream (block \d+ has another type|does not reproduce)/);
});

test('an unreplayable assistant block is refused', () => {
  const events = buildSimple();
  const index = events.findIndex((event) => event.type === 'assistant/message');
  const content = events[index].data.message.content.map((block) =>
    block.type === 'tool-call' ? { type: 'image', data: 'x' } : block,
  );
  events[index] = {
    ...events[index],
    data: { ...events[index].data, message: { ...events[index].data.message, content } },
  };
  assert.throws(() => assertEventStream(events), /cannot be replayed/);
});

test('a title that cites messages while claiming a user source is refused', () => {
  const events = buildSimple();
  const index = events.findIndex((event) => event.type === 'session/title');
  events[index] = { ...events[index], data: { ...events[index].data, messageSeqs: [2] } };
  assert.throws(() => assertEventStream(events), /mixes a "user" source/);
});

test('an unclosed turn is refused', () => {
  const events = buildSimple().filter((event) => event.type !== 'turn/end').map((event, index) => ({ ...event, seq: index }));
  assert.throws(() => assertEventStream(events), /never closed|step/);
});

test('arguments are normalized to a JSON string once and reused verbatim', () => {
  assert.equal(argumentsOf({ a: 1 }), '{"a":1}');
  assert.equal(argumentsOf('{"a":1}'), '{"a":1}');
  assert.equal(argumentsOf('not json'), '{"input":"not json"}');
  assert.equal(argumentsOf(undefined), '{}');

  const { turns } = groupTurns(
    transcript([
      { role: 'user', text: 'go' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'Bash', arguments: { a: 1 } }] },
      { role: 'tool', callId: 'c1', text: 'ok' },
    ]),
  );
  const advertised = turns[0].steps[0].blocks.find((block) => block.type === 'tool-call');
  const call = turns[0].steps[0].calls[0];
  assert.equal(advertised.arguments, call.arguments);
});
