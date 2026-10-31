/**
 * The model-facing board (runtime-context block): who is visible to whom.
 *
 * Guard: two sessions see each other only when they share a project; subagents and sessions from
 * another workspace never appear, and a session never lists itself. That filtering is what keeps
 * one agent from addressing a session it cannot coordinate with.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, short } from './support/mock-ctx.mjs'

/** A workspace with two peers in one project, one foreign session and one subagent. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\PROJECT\\')
  const other = harness.addAgent('session-cccc3333', 'C:\\elsewhere')
  const child = harness.addAgent('session-child999', 'C:\\project', { header: { origin: 'subagent' } })
  return { harness, a, b, other, child }
}

test('the board shows same-project peers, hides foreign workspaces and subagents', () => {
  const { harness, a, b, other, child } = workspace()
  const board = harness.boardFor(a)
  assert.ok(board.includes(short(b.id)), 'a peer in the same workspace is listed')
  assert.ok(!board.includes(short(other.id)), 'a session from another workspace is hidden')
  assert.ok(!board.includes(short(child.id)), 'a delegated subagent is hidden')
  assert.ok(
    !board.split('\n').some((line) => line.startsWith(`- ${short(a.id)}`)),
    'the asking session does not list itself',
  )
})

test('workspace comparison is case-insensitive and ignores a trailing separator', () => {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const sibling = harness.addAgent('session-bbbb2222', 'c:\\PROJECT\\')
  const board = harness.boardFor(a)
  assert.ok(board.includes(short(sibling.id)), 'the same directory spelled differently is still one workspace')
})

test('subagents get no board at all', () => {
  const { harness, child } = workspace()
  assert.equal(harness.boardFor(child), '')
})

test('a workspace without peers renders no board (zero prompt tokens)', () => {
  const harness = createHarness()
  const solo = harness.addAgent('session-solo777', 'C:\\project')
  assert.equal(harness.boardFor(solo), '')
  harness.addAgent('session-other888', 'C:\\project')
  assert.notEqual(harness.boardFor(solo), '')
})

test('the board carries the peer last request, status and current tool', () => {
  const { harness, a, b } = workspace()
  harness.emit('session/event', b.session, {
    type: 'user/message',
    time: Date.now(),
    data: { content: [{ type: 'text', text: 'прогоняю гейты, потом солью PR' }] },
  })
  harness.emit('session/event', b.session, { type: 'tool/call', time: Date.now(), data: { name: 'pwsh' } })
  harness.emit('agent/status', { agent: b, status: 'running' })

  const board = harness.boardFor(a)
  assert.ok(board.includes('прогоняю гейты'), 'the last request is shown')
  assert.ok(board.includes('running'), 'the live status is shown')
  assert.ok(board.includes('pwsh'), 'the current tool is shown')
})

test('the board caps its listing and points at peer_sessions beyond the cap', () => {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  for (let index = 0; index < 9; index++) harness.addAgent(`session-peer${String(index).padStart(4, '0')}`, 'C:\\project')
  const board = harness.boardFor(a)
  assert.ok(board.includes('peer_sessions'), 'overflow tells the model where to get the rest')
})
