/**
 * The master role: one coordinator per workspace, reachable as `peer_send({ to: "master" })`.
 *
 * Guards: exactly one master per project, claiming pins the session in the sidebar, a new claim
 * demotes the old one, releasing never unpins (pins belong to the user), and a delegated subagent
 * can never hold the role.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fakeWorkspaceController, short } from './support/mock-ctx.mjs'

/** A, B in one project; a subagent of A. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\PROJECT\\')
  const child = harness.addAgent('session-child999', 'C:\\project', { header: { origin: 'subagent' } })
  const workspaceController = fakeWorkspaceController()
  harness.services.workspaceController = workspaceController
  return { harness, a, b, child, workspaceController }
}

test('claiming the master role marks the board and pins the session', async () => {
  const { harness, a, b, workspaceController } = workspace()
  await harness.callTool('peer_intent', { master: true, label: 'coordinator', text: 'координирую мержи' }, b)
  await harness.settle()

  assert.ok(harness.boardFor(a).includes('[master]'), 'the board marks the master session')
  assert.deepEqual(workspaceController.calls.pin.map((call) => call.sessionId), [b.id], 'claiming pins the session')
})

test('the master pseudo-target resolves to the master peer', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_intent', { master: true, label: 'coordinator' }, b)
  const sent = await harness.callTool('peer_send', { to: 'master', message: 'отчёт: гейты зелёные' }, a)
  assert.equal(sent.delivery, 'live')
  assert.equal(sent.to, short(b.id), 'the pseudo-target resolves to the master handle')
})

test('peer_send({ to: "master" }) without a master fails with a hint', async () => {
  const { harness, a } = workspace()
  const error = await harness.expectError(
    () => harness.callTool('peer_send', { to: 'master', message: 'ты тут?' }, a),
    'master',
  )
  assert.ok(error.message.includes('peer_intent'), `the error tells how to fix it: ${error.message}`)
})

test('only one master per project: a fresh claim demotes the previous holder', async () => {
  const { harness, a, b, workspaceController } = workspace()
  await harness.callTool('peer_intent', { master: true, label: 'coordinator' }, b)
  await harness.callTool('peer_intent', { master: true }, a)
  await harness.settle()

  assert.equal(workspaceController.calls.unpin.length, 0, 'demoting never unpins: a pin may belong to the user')
  const boardForB = harness.boardFor(b)
  assert.ok(boardForB.includes('[master]'), 'the board still shows exactly one master mark')
  assert.ok(!boardForB.includes('coordinator · [master]'), 'the demoted peer no longer holds the role')

  const viewForA = await harness.callTool('peer_sessions', {}, a)
  assert.equal(viewForA.peers.find((peer) => peer.id === b.id).role, 'worker', 'the demoted peer is a worker')
})

test('a delegated subagent cannot hold the master role', async () => {
  const { harness, child } = workspace()
  const error = await harness.expectError(
    () => harness.callTool('peer_intent', { master: true }, child),
    'subagent',
  )
  assert.ok(/master/i.test(error.message))
})

test('releasing the master role clears it without unpinning', async () => {
  const { harness, a, b, workspaceController } = workspace()
  await harness.callTool('peer_intent', { master: true }, b)
  await harness.callTool('peer_intent', { master: false }, b)
  await harness.settle()

  assert.equal(workspaceController.calls.unpin.length, 0)
  assert.ok(!harness.boardFor(a).includes('[master]'), 'the role is gone from the board')
  const view = await harness.callTool('peer_sessions', {}, a)
  assert.equal(view.peers[0].role, 'worker')
})

test('a subagent receives no board and is never a master target', async () => {
  const { harness, child } = workspace()
  await harness.callTool('peer_intent', { master: true, label: 'main' }, harness.liveAgents.get('session-aaaa1111'))
  assert.equal(harness.boardFor(child), '')
})
