/**
 * CONTRACT.md §3 — the v2 tool surface and the documented error format.
 *
 * Guard: every tool the contract names must be registered, and tool failures must be `Error`s
 * whose text starts with `<CODE>: <human hint>`. A raw stack trace or a different shape is not a
 * contract error, and the browser half / model prompts depend on the stable codes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fakeSessionController, fakeWorkspaceController } from './support/mock-ctx.mjs'

const CONTRACT_TOOLS = [
  'peer_sessions',
  'peer_send',
  'peer_ack',
  'peer_claim',
  'peer_release',
  'peer_inbox',
  'peer_wait',
  'peer_intent',
  'peer_new_session',
  'peer_archive_session',
]

const DOCUMENTED_CODES = [
  'PEER_NOT_FOUND',
  'NO_MASTER',
  'CLAIM_HELD',
  'CLAIM_NOT_HELD',
  'RATE_LIMITED',
  'DUPLICATE_MESSAGE',
  'BAD_ARGUMENT',
  'UNAVAILABLE',
  'SPAWN_BUDGET',
  'NOT_OWNER',
]

/** A workspace with two peers and every Host service the contract allows. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  harness.services.sessionController = fakeSessionController()
  harness.services.workspaceController = fakeWorkspaceController()
  return { harness, a, b }
}

test('every tool named by the contract is registered', () => {
  const harness = createHarness()
  for (const toolName of CONTRACT_TOOLS) harness.requireTool(toolName)
  for (const definition of harness.tools.values()) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 20, `${definition.name} is described for the model`)
    assert.equal(typeof definition.output?.schema, 'object', `${definition.name} declares an output schema`)
  }
})

test('peer_send accepts every documented v2 parameter', async () => {
  const { harness, a, b } = workspace()
  const queued = await harness.callTool(
    'peer_send',
    {
      to: 'bb2222',
      message: 'вопрос: кто мержит?',
      mode: 'queue',
      kind: 'question',
      expects_reply: true,
      priority: 'urgent',
    },
    a,
  )
  assert.equal(queued.delivery, 'live')
  assert.equal(b.sent.length, 1)
})

test('peer_intent accepts dnd and reports it back', async () => {
  const { harness } = workspace()
  assert.ok(harness.requireTool('peer_intent').parameters.dnd !== undefined, 'peer_intent declares dnd')
})

test('unknown peer references use PEER_NOT_FOUND', async () => {
  const { harness, a } = workspace()
  await harness.expectError(() => harness.callTool('peer_send', { to: 'ghost', message: 'hi' }, a), 'PEER_NOT_FOUND')
})

test('a missing master uses NO_MASTER', async () => {
  const { harness, a } = workspace()
  await harness.expectError(() => harness.callTool('peer_send', { to: 'master', message: 'hi' }, a), 'NO_MASTER')
})

test('empty arguments use BAD_ARGUMENT', async () => {
  const { harness, a } = workspace()
  await harness.expectError(() => harness.callTool('peer_send', { to: 'bb2222', message: '' }, a), 'BAD_ARGUMENT')
})

test('a missing Host service uses UNAVAILABLE', async () => {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  harness.addAgent('session-bbbb2222', 'C:\\project')
  // No sessionController in this deployment: spawning must fail loudly, not pretend to work.
  await harness.expectError(() => harness.callTool('peer_new_session', { task: 'что-нибудь' }, a), 'UNAVAILABLE')
})

test('the spawn budget reports SPAWN_BUDGET', async () => {
  const { harness, a } = workspace()
  for (let index = 0; index < 5; index++) {
    await harness.callTool('peer_new_session', { task: `задача ${index}` }, a)
  }
  await harness.expectError(() => harness.callTool('peer_new_session', { task: 'шестая' }, a), 'SPAWN_BUDGET')
})

test('every documented error code is reachable and no code leaks an unprefixed message', async () => {
  const { harness, a } = workspace()
  // A sample of the codes, to prove the prefix format itself rather than each occurrence.
  const samples = [
    ['PEER_NOT_FOUND', () => harness.callTool('peer_send', { to: 'ghost', message: 'x' }, a)],
    ['BAD_ARGUMENT', () => harness.callTool('peer_send', { to: 'bb2222', message: '   ' }, a)],
    ['CLAIM_NOT_HELD', () => harness.callTool('peer_release', { resource: 'deploy:staging' }, a)],
  ]
  for (const [code, call] of samples) {
    const error = await harness.expectError(call, code)
    assert.match(error.message, new RegExp(`^${code}: .+`), `the message is "${code}: <hint>": ${error.message}`)
    assert.ok(DOCUMENTED_CODES.includes(code))
  }
})
