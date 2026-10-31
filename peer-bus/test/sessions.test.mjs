/**
 * `peer_sessions` — the discovery surface a model calls before asking a peer anything.
 *
 * Guard: it lists exactly the peers of the caller's project, with stable JSON-only fields
 * (a field that becomes `undefined` breaks the tool-output pipeline), and cold sessions appear
 * only when asked for.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fakeSessionController, short } from './support/mock-ctx.mjs'

/** Two peers in one project, a foreign session, and a subagent. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\PROJECT\\')
  const other = harness.addAgent('session-cccc3333', 'C:\\elsewhere')
  const child = harness.addAgent('session-child999', 'C:\\project', { header: { origin: 'subagent' } })
  return { harness, a, b, other, child }
}

test('peer_sessions lists exactly the same-workspace peers', async () => {
  const { harness, a, b } = workspace()
  harness.emit('agent/status', { agent: b, status: 'running' })

  const view = await harness.callTool('peer_sessions', {}, a)
  assert.equal(view.peers.length, 1, 'one peer in this workspace')
  assert.equal(view.peers[0].short, short(b.id), 'peer handle is the id suffix')
  assert.equal(view.peers[0].status, 'running', 'peer status is reported')
  assert.equal(view.self, short(a.id), 'peer_sessions names the caller')
  assert.equal(typeof view.workspace, 'string', 'the workspace root is reported')
  assert.equal(typeof view.text, 'string')

  const peer = view.peers[0]
  for (const field of ['id', 'short', 'label', 'name', 'role', 'intent', 'last_request', 'last_answer', 'last_tool']) {
    assert.equal(typeof peer[field], 'string', `peer.${field} is a string, never undefined`)
  }
  assert.equal(typeof peer.live, 'boolean')
  assert.equal(typeof peer.idle_seconds, 'number')
  assert.equal(typeof peer.messages_to_you, 'number')
  assert.equal(peer.role, 'worker', 'a plain peer is a worker')
})

test('peer_sessions includes cold sessions only on request', async () => {
  const { harness, a } = workspace()
  harness.services.sessionController = fakeSessionController({
    listItems: [
      { sessionId: 'session-cold0001', cwd: 'C:\\project', status: 'closed' },
      { sessionId: 'session-cold0002', cwd: 'C:\\elsewhere', status: 'closed' },
      { sessionId: 'session-cold0003', cwd: 'C:\\project', origin: 'subagent', status: 'closed' },
    ],
  })

  const warm = await harness.callTool('peer_sessions', {}, a)
  assert.ok(!warm.peers.some((peer) => peer.id === 'session-cold0001'), 'cold sessions stay hidden by default')

  const cold = await harness.callTool('peer_sessions', { include_cold: true }, a)
  const coldPeer = cold.peers.find((peer) => peer.id === 'session-cold0001')
  assert.ok(coldPeer !== undefined, 'a cold session of the same project is listed on request')
  assert.equal(coldPeer.live, false, 'a cold peer is not live')
  assert.ok(!cold.peers.some((peer) => peer.id === 'session-cold0002'), 'a cold session of another project stays hidden')
  assert.ok(!cold.peers.some((peer) => peer.id === 'session-cold0003'), 'a cold subagent stays hidden')
})

test('peer_sessions reports a failed cold listing instead of hiding it', async () => {
  const { harness, a } = workspace()
  harness.services.sessionController = fakeSessionController()
  harness.services.sessionController.list = async () => {
    throw new Error('persistence unavailable')
  }
  const view = await harness.callTool('peer_sessions', { include_cold: true }, a)
  assert.ok(/could not be listed|listing failed|cold/i.test(view.text), `the failure is explained: ${view.text}`)
})

test('a disposed peer is reported as closed, not dropped silently', async () => {
  const { harness, a, b } = workspace()
  harness.disposeAgent(b)
  const view = await harness.callTool('peer_sessions', {}, a)
  assert.equal(view.peers[0].status, 'closed')
  assert.equal(view.peers[0].live, false)
})

test('peer_sessions requires an owning agent session', async () => {
  const { harness } = workspace()
  await harness.expectError(() => harness.callTool('peer_sessions', {}, undefined), 'owning agent')
})
