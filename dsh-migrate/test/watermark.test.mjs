/**
 * Guard tests for the watermark repair — Update without deleting or re-importing.
 *
 * The proof is the point: an inherited copy is trusted only when its normalized
 * history is a prefix of the origin. These tests pin the two outcomes that
 * matter — an ideal prefix gets a watermark and (therefore) a working update,
 * a rewritten opening stays `diverged` — plus the normalization rules that let
 * both sides be compared at all (tool calls, tool results and the importer's own
 * head are not comparable and must not break the match).
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'dsh-migrate-watermark-'));
process.env.DSH_HOME = join(home, '.dsh');

const { buildEvents } = await import('../lib/sessions/events.js');
const { findImport, recordImport } = await import('../lib/sessions/ledger.js');
const {
  commonPrefixLength,
  normalizeSessionEvents,
  normalizeSourceMessages,
  repairLedgerWatermark,
  repairWatermarks,
} = await import('../lib/sessions/watermark.js');

/** Six plain messages: three prompts, three answers. */
function messages() {
  return [
    { role: 'user', text: 'first prompt' },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    { role: 'user', text: 'second prompt' },
    { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
    { role: 'user', text: 'third prompt' },
    { role: 'assistant', content: [{ type: 'text', text: 'third answer' }] },
  ];
}

/** The origin transcript an adapter would return. */
function transcript(foreignId, list) {
  return {
    source: 'zcode-cli',
    label: 'ZCode',
    foreignId,
    title: 'Watermark session',
    cwd: 'D:\\work',
    createdAt: 1_700_000_000_000,
    model: { provider: 'zai', model: 'glm-4.6' },
    messages: list,
  };
}

/** The event log an older install wrote from the first `count` messages. */
function storedEvents(foreignId, count) {
  const built = buildEvents(transcript(foreignId, messages().slice(0, count)), { id: `session-${foreignId}`, createdAt: 1_700_000_000_000, cwd: 'D:\\work' });
  return built.events;
}

/** A Host stub with the stored DSH log. */
function hostWith(events) {
  return {
    get(name) {
      if (name === 'sessionQuery') return { async readSession() { return { session: { cwd: 'D:\\work' }, events }; } };
      return undefined;
    },
  };
}

/** An adapter stub returning the current origin. */
function adapterWith(list) {
  return { async readSession() { return transcript('ignored', list); } };
}

/** Seed one ledger row the way a predecessor install left it (no watermark). */
async function seedRow(foreignId, sessionId) {
  await recordImport({
    source: 'zcode-cli',
    foreignId,
    sessionId,
    title: 'Watermark session',
    cwd: 'D:\\work',
    eventCount: 10,
    turnCount: 3,
    verified: true,
  });
  return findImport('zcode-cli', foreignId);
}

test('normalization drops tool calls, tool results and the imported system head', () => {
  const withTools = [
    { role: 'user', text: 'run it' },
    { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool-call', id: 'c1', name: 'Read', arguments: '{}' }] },
    { role: 'tool', callId: 'c1', text: 'output' },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  const source = normalizeSourceMessages(withTools);
  assert.deepEqual(source.entries.map((entry) => entry.role), ['user', 'assistant', 'assistant'], 'tool messages are not comparable');
  assert.deepEqual(source.rawEnds, [1, 2, 4], 'a tool message is skipped but still counted in the raw index');

  const built = buildEvents(transcript('norm', withTools), { id: 'session-norm', createdAt: 1, cwd: 'D:\\work' });
  const copy = normalizeSessionEvents(built.events);
  assert.deepEqual(copy, source.entries, 'the same history normalizes identically on both sides');
  assert.equal(commonPrefixLength(copy, source.entries), 3);
});

test('an ideal prefix is repaired: the watermark is written and an update becomes possible', async () => {
  const foreignId = 'repair-ideal';
  const entry = await seedRow(foreignId, 'session-repair-ideal');
  const copyEvents = storedEvents(foreignId, 4);
  const current = messages(); // origin was appended after the import
  const result = await repairLedgerWatermark(hostWith(copyEvents), entry, { adapter: adapterWith(current) });
  assert.equal(result.status, 'repaired');
  assert.equal(result.matchedMessages, 4);
  assert.equal(result.copiedMessages, 4);
  assert.equal(result.sourceMessages, 6);
  assert.equal(result.foreignMessageCount, 4, 'the watermark is the raw source index of the matched prefix');

  const repaired = findImport('zcode-cli', foreignId);
  assert.equal(repaired.foreignMessageCount, 4);
  assert.match(repaired.foreignPrefixHash, /^[0-9a-f]{16}$/u);
  // The updater appends exactly what came after the watermark.
  assert.equal(current.length - repaired.foreignMessageCount, 2);
});

test('an unchanged origin equals the copy and is repaired too (update reports up-to-date)', async () => {
  const foreignId = 'repair-equal';
  const entry = await seedRow(foreignId, 'session-repair-equal');
  const current = messages();
  const result = await repairLedgerWatermark(hostWith(storedEvents(foreignId, 6)), entry, { adapter: adapterWith(current) });
  assert.equal(result.status, 'repaired');
  assert.equal(result.foreignMessageCount, 6);
  assert.equal(current.length - findImport('zcode-cli', foreignId).foreignMessageCount, 0);
});

test('a rewritten opening stays diverged and writes nothing', async () => {
  const foreignId = 'repair-diverged';
  const entry = await seedRow(foreignId, 'session-repair-diverged');
  const rewritten = messages();
  rewritten[1] = { role: 'assistant', content: [{ type: 'text', text: 'a different answer' }] };
  const result = await repairLedgerWatermark(hostWith(storedEvents(foreignId, 4)), entry, { adapter: adapterWith(rewritten) });
  assert.equal(result.status, 'diverged');
  assert.equal(result.matchedMessages, 1, 'the user prompt matches, the answer does not');
  assert.match(result.reason, /не совпадает|переписан/u);
  const untouched = findImport('zcode-cli', foreignId);
  assert.equal(untouched.foreignMessageCount, 0, 'a divergence must never be repaired silently');
  assert.equal(untouched.foreignPrefixHash, '');
});

test('a copy whose source ended earlier (subagent appendix) is still a proven prefix', async () => {
  const foreignId = 'repair-appendix';
  const entry = await seedRow(foreignId, 'session-repair-appendix');
  const base = messages().slice(0, 4);
  const withAppendix = [
    ...base,
    { role: 'user', text: '[subagent transcript 1: Explore repo — child-1 — выполнялся внутри этой сессии, ниже его содержимое как контекст]' },
    { role: 'assistant', content: [{ type: 'text', text: 'child answer' }] },
  ];
  const copyEvents = buildEvents(transcript(foreignId, withAppendix), { id: 'session-appendix', createdAt: 1, cwd: 'D:\\work' }).events;
  const result = await repairLedgerWatermark(hostWith(copyEvents), entry, { adapter: adapterWith(base) });
  assert.equal(result.status, 'repaired', 'the appendix follows the source prefix and must not count as a divergence');
  assert.equal(result.foreignMessageCount, 4);
});

test('an unreadable copy or an unsupported source fails honestly', async () => {
  const foreignId = 'repair-unreadable';
  const entry = await seedRow(foreignId, 'session-repair-unreadable');
  const empty = await repairLedgerWatermark(hostWith([]), entry, { adapter: adapterWith(messages()) });
  assert.equal(empty.status, 'failed');
  assert.match(empty.reason, /журнал событий пуст/u);

  const unsupported = await repairLedgerWatermark(hostWith(storedEvents(foreignId, 4)), { ...entry, source: 'no-such-source' });
  assert.equal(unsupported.status, 'failed');
  assert.match(unsupported.reason, /не поддерживается/u);
});

test('a batch repairs every row without a watermark and summarises the outcome', async () => {
  const withWatermark = 'repair-already';
  await recordImport({
    source: 'zcode-cli',
    foreignId: withWatermark,
    sessionId: 'session-repair-already',
    title: 'Already stamped',
    cwd: 'D:\\work',
    foreignMessageCount: 2,
    foreignPrefixHash: 'aaaaaaaaaaaaaaaa',
  });
  const adapters = { 'zcode-cli': adapterWith(messages()) };
  const result = await repairWatermarks(
    { get: (name) => (name === 'sessionQuery' ? { async readSession() { return { session: {}, events: [] }; } } : undefined) },
    {},
    { adapters },
  );
  assert.ok(result.summary.requested >= 2);
  assert.ok(result.summary.failed >= 1, 'unreadable copies are counted, not hidden');
  assert.equal(result.items.some((item) => item.sessionId === 'session-repair-already'), false, 'a stamped row is not touched');
});
