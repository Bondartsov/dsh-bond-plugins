/**
 * CONTRACT.md §3 — threads: `kind: question|answer`, `ref`, `peer_ack`, `peer_wait(until: "reply")`.
 *
 * Guard: a thread never closes on its own. Only an explicit answer (`answered`) or an explicit
 * `peer_ack` (`closed`) changes its status; silence, delivery and status changes do nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './support/mock-ctx.mjs'
import { assertBoardSchema } from './support/board-schema.mjs'

/** Two peers in one project. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  return { harness, a, b }
}

/** The v2 board, schema-checked. */
async function boardOf(harness) {
  const board = await harness.board()
  assertBoardSchema(board, 'GET /peer-bus/board')
  return board
}

/** The thread with the given id, or a failure. */
function threadOf(board, id) {
  const thread = board.threads.find((entry) => entry.id === id)
  assert.ok(thread !== undefined, `thread ${id} is on the board; got ${board.threads.map((entry) => entry.id).join(', ')}`)
  return thread
}

test('a question without ref opens a thread and reports its id', async () => {
  const { harness, a, b } = workspace()
  const sent = await harness.callTool('peer_send', { to: 'bb2222', message: 'кто мержит первым?', kind: 'question' }, a)

  assert.equal(typeof sent.thread, 'string', 'the result carries the thread id')
  assert.equal(sent.kind, 'question')
  const board = await boardOf(harness)
  const thread = threadOf(board, sent.thread)
  assert.equal(thread.status, 'open')
  assert.equal(thread.from, a.id)
  assert.equal(thread.to, b.id)
  assert.equal(typeof thread.subject, 'string')
  assert.ok(thread.messages >= 1, 'the question counts as a message')
  assert.equal(typeof thread.createdAt, 'number')
  assert.ok(thread.lastAt >= thread.createdAt)
})

test('a thread does not close itself: delivery and status changes leave it open', async () => {
  const { harness, a, b } = workspace()
  const sent = await harness.callTool('peer_send', { to: 'bb2222', message: 'готов?', kind: 'question' }, a)
  harness.emit('agent/status', { agent: b, status: 'running' })
  harness.emit('agent/status', { agent: b, status: 'idle' })
  await harness.callTool('peer_inbox', {}, b)

  assert.equal(threadOf(await boardOf(harness), sent.thread).status, 'open', 'still open until answered')
})

test('an explicit answer moves the thread to answered', async () => {
  const { harness, a, b } = workspace()
  const question = await harness.callTool('peer_send', { to: 'bb2222', message: 'кто мержит первым?', kind: 'question' }, a)
  const answer = await harness.callTool(
    'peer_send',
    { to: 'aa1111', message: 'я мержу вторым', kind: 'answer', ref: question.thread },
    b,
  )

  assert.equal(answer.thread, question.thread, 'the answer lands in the same thread')
  const thread = threadOf(await boardOf(harness), question.thread)
  assert.equal(thread.status, 'answered')
  assert.ok(thread.messages >= 2, 'both messages are counted')
  assert.ok(thread.lastAt >= thread.createdAt)
})

test('peer_ack closes the thread explicitly', async () => {
  const { harness, a, b } = workspace()
  const question = await harness.callTool('peer_send', { to: 'bb2222', message: 'готов?', kind: 'question' }, a)
  await harness.callTool('peer_send', { to: 'aa1111', message: 'да', kind: 'answer', ref: question.thread }, b)

  const acked = await harness.callTool('peer_ack', { thread: question.thread }, a)
  assert.equal(acked.thread, question.thread)
  assert.equal(acked.status, 'closed')
  assert.equal(typeof acked.text, 'string')
  assert.equal(threadOf(await boardOf(harness), question.thread).status, 'closed')
})

test('peer_ack on an unknown thread is PEER_NOT_FOUND', async () => {
  const { harness, a } = workspace()
  await harness.expectError(() => harness.callTool('peer_ack', { thread: 'th-ghost' }, a), 'PEER_NOT_FOUND')
})

test('each question without ref opens its own thread', async () => {
  const { harness, a } = workspace()
  const first = await harness.callTool('peer_send', { to: 'bb2222', message: 'первый вопрос', kind: 'question' }, a)
  const second = await harness.callTool('peer_send', { to: 'bb2222', message: 'второй вопрос', kind: 'question' }, a)
  assert.notEqual(first.thread, second.thread)
  const board = await boardOf(harness)
  assert.ok(board.threads.filter((thread) => thread.status === 'open').length >= 2)
})

test('peer_wait(until: "reply") returns when the thread is answered', async () => {
  const { harness, a, b } = workspace()
  const question = await harness.callTool('peer_send', { to: 'bb2222', message: 'кто мержит?', kind: 'question' }, a)
  setTimeout(() => {
    void harness.callTool('peer_send', { to: 'aa1111', message: 'я', kind: 'answer', ref: question.thread }, b)
  }, 100)

  const waited = await harness.callTool(
    'peer_wait',
    { until: 'reply', ref: question.thread, timeout_seconds: 5 },
    a,
  )
  assert.equal(waited.outcome, 'reply')
  assert.equal(typeof waited.waited_seconds, 'number')
})

test('a chat message opens no thread', async () => {
  const { harness, a } = workspace()
  const sent = await harness.callTool('peer_send', { to: 'bb2222', message: 'просто заметка' }, a)
  assert.equal(sent.kind ?? 'chat', 'chat')
  const board = await boardOf(harness)
  assert.equal(board.threads.length, 0, 'a chat does not create a thread')
})
