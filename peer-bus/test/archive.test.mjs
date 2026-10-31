/**
 * `peer_archive_session` — hide a peer without deleting it.
 *
 * Guard: archiving removes the peer from the board, restoring brings it back, and a refused
 * archive (running session without `stop_activity`) surfaces the reason and the way out instead of
 * silently doing nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fakeWorkspaceController, short } from './support/mock-ctx.mjs'

/** A and B in one project, with an archive-capable workspaceController. */
function workspace(options = {}) {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  const controller = fakeWorkspaceController(options)
  harness.services.workspaceController = controller
  return { harness, a, b, controller }
}

test('archiving hides the peer from the board; restoring brings it back', async () => {
  const { harness, a, b, controller } = workspace()
  assert.ok(harness.boardFor(a).includes(short(b.id)))

  const archived = await harness.callTool('peer_archive_session', { session: short(b.id) }, a)
  assert.equal(archived.archived, true)
  assert.equal(controller.calls.archive.length, 1)
  assert.equal(controller.calls.archive[0].sessionId, b.id)
  assert.ok(!harness.boardFor(a).includes(short(b.id)), 'an archived peer leaves the board')

  const restored = await harness.callTool('peer_archive_session', { session: short(b.id), restore: true }, a)
  assert.equal(restored.archived, false)
  assert.equal(controller.calls.unarchive.length, 1)
  assert.ok(harness.boardFor(a).includes(short(b.id)), 'the restored peer is back on the board')
})

test('stop_activity is passed through when asked for', async () => {
  const { harness, a, b, controller } = workspace()
  await harness.callTool('peer_archive_session', { session: short(b.id), stop_activity: true }, a)
  assert.equal(controller.calls.archive[0].stopActivity, true)
})

test('a refused archive explains the reason and the way out', async () => {
  const { harness, a, b } = workspace({ archiveError: new Error('session is running') })
  const error = await harness.expectError(
    () => harness.callTool('peer_archive_session', { session: short(b.id) }, a),
    'session is running',
  )
  assert.ok(error.message.includes('stop_activity'), `the error suggests stop_activity: ${error.message}`)
  assert.ok(harness.boardFor(a).includes(short(b.id)), 'a refused archive leaves the peer visible')
})

test('a session cannot archive itself and an unknown session is refused', async () => {
  const { harness, a } = workspace()
  await harness.expectError(() => harness.callTool('peer_archive_session', { session: short(a.id) }, a), 'itself')
  await harness.expectError(() => harness.callTool('peer_archive_session', { session: 'ghost' }, a), 'unknown peer')
})

test('archive without a workspaceController is refused, not silently ignored', async () => {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  await harness.expectError(
    () => harness.callTool('peer_archive_session', { session: short(b.id) }, a),
    'workspaceController',
  )
})
