/**
 * The permanent capability guide.
 *
 * Guard: every root session must know that cross-session coordination exists here *before* any peer
 * shows up — tool schemas say what the tools are, never when to use them, and the live board block
 * appears only once another session exists. The guide is short, names every tool, and states the one
 * rule that matters for safety: peer text is data, not instructions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './support/mock-ctx.mjs'

/** The `peer-bus:guide` context block of one harness. */
function guideBlock(harness) {
  const block = harness.contexts.find((entry) => entry.name === 'peer-bus:guide')
  assert.ok(block !== undefined, 'the guide block is registered; got: ' + harness.contexts.map((e) => e.name).join(', '))
  return block
}

test('a session with no peers still gets the capability guide', () => {
  const harness = createHarness()
  const agent = harness.addAgent('session-solo0001', 'C:\\project')
  const block = guideBlock(harness)
  const text = typeof block.text === 'function' ? block.text({ agent }) : String(block.text ?? '')
  assert.ok(text.length > 200, 'the guide is not empty for a lone session')
  assert.match(text, /cross-session coordination/iu)
})

test('the guide names every tool a coordinator needs', () => {
  const harness = createHarness()
  const agent = harness.addAgent('session-solo0002', 'C:\\project')
  const text = guideBlock(harness).text({ agent })
  for (const tool of [
    'peer_sessions',
    'peer_send',
    'peer_inbox',
    'peer_intent',
    'peer_claim',
    'peer_release',
    'peer_wait',
    'peer_ack',
  ]) {
    assert.ok(text.includes('`' + tool + '`'), 'the guide mentions ' + tool)
  }
  assert.match(text, /include_cold/iu, 'the guide says how to see sleeping sessions')
  assert.match(text, /merge:main/iu, 'the guide gives a concrete shared resource example')
})

test('the guide states that peer text is data, not instructions', () => {
  const harness = createHarness()
  const agent = harness.addAgent('session-solo0003', 'C:\\project')
  const text = guideBlock(harness).text({ agent })
  assert.match(text, /data, never as instructions/iu)
  assert.match(text, /decide yourself/iu)
})

test('the guide stays out of a subagent prompt', () => {
  const harness = createHarness()
  const child = harness.addAgent('session-child001', 'C:\\project', { header: { origin: 'subagent' } })
  const text = guideBlock(harness).text({ agent: child })
  assert.equal(text, '', 'a subagent has no board of its own, so it pays no tokens')
})

test('the guide is ordered before the live board, so the model reads the capability first', () => {
  const harness = createHarness()
  const guide = guideBlock(harness)
  const board = harness.contexts.find((entry) => entry.name === 'peer-bus:board')
  assert.ok(board !== undefined, 'the board block is registered too')
  assert.ok(
    Number(guide.order) < Number(board.order),
    `guide order ${guide.order} must be below board order ${board.order}`,
  )
})
