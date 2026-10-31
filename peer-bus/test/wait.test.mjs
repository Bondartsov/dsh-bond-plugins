/**
 * `peer_wait` — wait for a peer instead of polling it with questions.
 *
 * Guard: it never blocks longer than the timeout (an abort or a deadline always returns
 * `timeout`), and it returns as soon as the watched condition holds.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, short } from './support/mock-ctx.mjs'

/** A and B in one project. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  return { harness, a, b }
}

test('peer_wait returns idle for an idle peer immediately', async () => {
  const { harness, a, b } = workspace()
  const started = Date.now()
  const result = await harness.callTool('peer_wait', { peer: short(b.id), until: 'idle', timeout_seconds: 5 }, a)
  assert.equal(result.outcome, 'idle')
  assert.equal(typeof result.waited_seconds, 'number')
  assert.equal(typeof result.text, 'string')
  assert.ok(Date.now() - started < 2_000, 'an idle peer is reported without a needless wait')
})

test('peer_wait resolves when a running peer becomes idle', async () => {
  const { harness, a, b } = workspace()
  harness.emit('agent/status', { agent: b, status: 'running' })
  setTimeout(() => harness.emit('agent/status', { agent: b, status: 'idle' }), 300)

  const result = await harness.callTool('peer_wait', { peer: short(b.id), until: 'idle', timeout_seconds: 5 }, a)
  assert.equal(result.outcome, 'idle')
})

test('peer_wait returns message when a peer message arrives', async () => {
  const { harness, a, b } = workspace()
  const waiting = harness.callTool('peer_wait', { peer: short(b.id), until: 'message', timeout_seconds: 5 }, a)
  setTimeout(() => {
    void harness.callTool('peer_send', { to: short(a.id), message: 'готово, мержу' }, b)
  }, 100)

  const result = await waiting
  assert.equal(result.outcome, 'message')
})

test('peer_wait never hangs: an aborted wait returns timeout', async () => {
  const { harness, a, b } = workspace()
  harness.emit('agent/status', { agent: b, status: 'running' })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 700)

  const result = await harness.callTool(
    'peer_wait',
    { peer: short(b.id), until: 'idle', timeout_seconds: 30 },
    a,
    { signal: controller.signal },
  )
  assert.equal(result.outcome, 'timeout')
  assert.ok(result.waited_seconds < 30, 'the wait stopped early instead of running the full timeout')
  assert.ok(/not idle|peer_sessions|assume/i.test(result.text), `the timeout text warns against assuming: ${result.text}`)
})

test('peer_wait refuses an unknown peer', async () => {
  const { harness, a } = workspace()
  await harness.expectError(() => harness.callTool('peer_wait', { peer: 'ghost', timeout_seconds: 5 }, a), 'no peer')
})
