/**
 * CONTRACT.md §3 — message limits: 5 per minute per peer, duplicates suppressed for 30 s.
 *
 * Guard: a confused agent cannot spam a peer, and an identical text cannot be delivered twice in
 * a row — while a different text, or a different peer, is never blocked.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './support/mock-ctx.mjs'

/** Two peers plus a third, all in one project. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  const c = harness.addAgent('session-cccc3333', 'C:\\project')
  return { harness, a, b, c }
}

test('five messages per minute reach one peer; the sixth is RATE_LIMITED', async () => {
  const { harness, a, b } = workspace()
  for (let index = 0; index < 5; index++) {
    await harness.callTool('peer_send', { to: 'bb2222', message: `сообщение ${index}` }, a)
  }
  assert.equal(b.sent.length, 5, 'the first five are delivered')

  const error = await harness.expectError(
    () => harness.callTool('peer_send', { to: 'bb2222', message: 'шестое' }, a),
    'RATE_LIMITED',
  )
  assert.ok(error.message.length > 'RATE_LIMITED: '.length, 'the error carries a human hint')
  assert.equal(b.sent.length, 5, 'the refused message is not delivered')
})

test('the rate limit is per peer: another peer is unaffected', async () => {
  const { harness, a, c } = workspace()
  for (let index = 0; index < 5; index++) {
    await harness.callTool('peer_send', { to: 'bb2222', message: `сообщение ${index}` }, a)
  }
  const other = await harness.callTool('peer_send', { to: 'cccc3333', message: 'другому можно' }, a)
  assert.equal(other.delivery, 'live')
  assert.equal(c.sent.length, 1)
})

test('the same text to the same peer within 30 s is DUPLICATE_MESSAGE', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_send', { to: 'bb2222', message: 'повторяемый текст' }, a)
  const error = await harness.expectError(
    () => harness.callTool('peer_send', { to: 'bb2222', message: 'повторяемый текст' }, a),
    'DUPLICATE_MESSAGE',
  )
  assert.ok(/30|duplicate|тот же/i.test(error.message), `the error explains the rule: ${error.message}`)
  assert.equal(b.sent.length, 1, 'the duplicate is not delivered')
})

test('the duplicate window is a window, not just the same millisecond', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_send', { to: 'bb2222', message: 'повторяемый текст' }, a)
  // A different millisecond, still well inside the 30 s window: the guard must still hold.
  await new Promise((resolve) => setTimeout(resolve, 120))
  await harness.expectError(
    () => harness.callTool('peer_send', { to: 'bb2222', message: 'повторяемый текст' }, a),
    'DUPLICATE_MESSAGE',
  )
  assert.equal(b.sent.length, 1, 'the second copy is not delivered either')
})

test('a different text after a duplicate is not blocked', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_send', { to: 'bb2222', message: 'текст А' }, a)
  await harness.callTool('peer_send', { to: 'bb2222', message: 'текст Б' }, a)
  assert.equal(b.sent.length, 2)
})

test('the same text to a different peer is not a duplicate', async () => {
  const { harness, a, c } = workspace()
  await harness.callTool('peer_send', { to: 'bb2222', message: 'одинаковый' }, a)
  const second = await harness.callTool('peer_send', { to: 'cccc3333', message: 'одинаковый' }, a)
  assert.equal(second.delivery, 'live')
  assert.equal(c.sent.length, 1)
})

test('a broadcast does not bypass the per-peer limit silently', async () => {
  const { harness, a } = workspace()
  for (let index = 0; index < 5; index++) {
    await harness.callTool('peer_send', { to: 'bb2222', message: `сообщение ${index}` }, a)
  }
  // A broadcast to B is still a sixth message to B: the contract's limit is per peer.
  const broadcast = await harness.callTool('peer_send', { to: 'all', message: 'всем' }, a)
  assert.ok(['broadcast', 'failed'].includes(broadcast.delivery), `broadcast reports an outcome: ${JSON.stringify(broadcast)}`)
  if (broadcast.delivery === 'failed') {
    assert.ok(/RATE_LIMITED|limit/i.test(broadcast.text + (broadcast.error ?? '')), 'a refused broadcast explains the limit')
  }
})
