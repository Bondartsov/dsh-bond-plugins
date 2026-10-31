/**
 * `peer_new_session` — spawning a fresh session with a self-contained brief.
 *
 * Guard: the spawn budget (5 per rolling hour) cannot be exceeded by a runaway agent, and a spawn
 * inherits the caller workspace unless an explicit `cwd` is given.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fakeSessionController, short } from './support/mock-ctx.mjs'

/** A single caller with a working sessionController. */
function spawner() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const controller = fakeSessionController({ createIds: ['session-newsession42'] })
  harness.services.sessionController = controller
  return { harness, a, controller }
}

test('peer_new_session creates a session in the caller workspace and delivers the brief', async () => {
  const { harness, a, controller } = spawner()
  const nova = await harness.callTool('peer_new_session', { task: 'исправь краш на старте', title: 'Fix startup crash' }, a)

  assert.equal(nova.short, short('session-newsession42'))
  assert.equal(typeof nova.session, 'string')
  assert.equal(typeof nova.status, 'string')
  assert.ok(nova.text.includes(short('session-newsession42')))
  assert.equal(controller.calls.create[0].cwd, 'C:\\project', 'the new session lands in the caller workspace')
  assert.equal(controller.calls.rename[0].title, 'Fix startup crash', 'the requested title is applied')
  assert.ok(
    controller.calls.prompt[0].content[0].text.includes(short(a.id)),
    'the brief tells the new session whom to report to',
  )
})

test('an explicit cwd and agent preset are passed through', async () => {
  const { harness, a, controller } = spawner()
  await harness.callTool(
    'peer_new_session',
    { task: 'аудит', cwd: 'C:\\other', agent_preset: 'audit' },
    a,
  )
  assert.equal(controller.calls.create[0].cwd, 'C:\\other')
  assert.equal(controller.calls.create[0].agentPreset, 'audit')
})

test('the spawn budget stops the sixth session in a rolling hour', async () => {
  const { harness, a, controller } = spawner()
  for (let index = 0; index < 5; index++) {
    await harness.callTool('peer_new_session', { task: `задача ${index}` }, a)
  }
  assert.equal(controller.calls.create.length, 5, 'five sessions fit in the budget')

  const error = await harness.expectError(
    () => harness.callTool('peer_new_session', { task: 'ещё одна' }, a),
    'budget',
  )
  assert.ok(/peer_archive_session|peer_send/.test(error.message), 'the error suggests a way out')
  assert.equal(controller.calls.create.length, 5, 'the refused spawn never reaches the controller')
})

test('an empty task brief is refused before any budget is spent', async () => {
  const { harness, a, controller } = spawner()
  await harness.expectError(() => harness.callTool('peer_new_session', { task: '   ' }, a), 'non-empty')
  assert.equal(controller.calls.create.length, 0)
})

test('a deployment without sessionController refuses to spawn', async () => {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  await harness.expectError(() => harness.callTool('peer_new_session', { task: 'что-нибудь' }, a), 'sessionController')
})

test('a spawn whose controller fails does not report a phantom session', async () => {
  const { harness, a } = spawner()
  harness.services.sessionController = fakeSessionController({ createError: new Error('workspace is read-only') })
  const error = await harness.expectError(
    () => harness.callTool('peer_new_session', { task: 'работа' }, a),
    'read-only',
  )
  assert.ok(error.message.length > 0)
})
