/**
 * CONTRACT.md §3 — `dnd`: do not disturb.
 *
 * Guard: while a session is in dnd its mode is lowered to `silent`, so the message is recorded in
 * the inbox without waking the session. It is a downgrade, never a drop: the text must still be
 * readable with peer_inbox afterwards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './support/mock-ctx.mjs'

/** Two peers in one project. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  return { harness, a, b }
}

test('dnd is declared, shown on the board, and can be switched off', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_intent', { dnd: true, text: 'в фокусе, не будить' }, b)
  await harness.settle()

  const board = await harness.board()
  const node = board.nodes.find((entry) => entry.id === b.id)
  assert.equal(node.dnd, true, 'the node carries dnd')
  assert.ok(harness.boardFor(a).includes('в фокусе'), 'the intent is still visible')

  await harness.callTool('peer_intent', { dnd: false }, b)
  await harness.settle()
  assert.equal((await harness.board()).nodes.find((entry) => entry.id === b.id).dnd, false, 'dnd can be switched off')
})

test('a queue message to a dnd peer is downgraded to silent, not delivered as a wake-up', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_intent', { dnd: true }, b)

  const sent = await harness.callTool('peer_send', { to: 'bb2222', message: 'аудит готов?' }, a)
  assert.equal(b.sent.length, 0, 'the peer is not woken')
  assert.equal(b.injected.length, 1, 'the message is injected for the next turn instead')
  assert.equal(sent.delivery, 'silent', `the delivery is reported as silent: ${JSON.stringify(sent)}`)

  const inbox = await harness.callTool('peer_inbox', {}, b)
  assert.ok(inbox.messages.some((message) => message.text.includes('аудит готов?')), 'the message is not lost')
})

test('a steer message to a dnd peer is also lowered to silent', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_intent', { dnd: true }, b)
  const sent = await harness.callTool('peer_send', { to: 'bb2222', message: 'срочно', mode: 'steer' }, a)
  assert.equal(b.sent.length, 0, 'no steer into the running turn either')
  assert.equal(sent.delivery, 'silent')
})

test('a silent message does not count as a wake-up but is still in the sender outbox', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_intent', { dnd: true }, b)
  await harness.callTool('peer_send', { to: 'bb2222', message: 'тихо' }, a)

  const outbox = await harness.callTool('peer_inbox', {}, a)
  assert.equal(outbox.messages.length, 1)
  assert.equal(outbox.messages[0].text, 'тихо')
})

test('after dnd is off, delivery wakes the peer again', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_intent', { dnd: true }, b)
  await harness.callTool('peer_send', { to: 'bb2222', message: 'первое' }, a)
  await harness.callTool('peer_intent', { dnd: false }, b)
  const sent = await harness.callTool('peer_send', { to: 'bb2222', message: 'второе' }, a)

  assert.equal(sent.delivery, 'live')
  assert.equal(b.sent.length, 1)
  assert.ok(b.sent[0].message.content[0].text.includes('второе'))
})
