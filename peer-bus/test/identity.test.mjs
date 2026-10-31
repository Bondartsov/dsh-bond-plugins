/**
 * Plugin identity and the registration surface the Host depends on.
 *
 * These are guards, not smoke tests: the plugin name, the injected service list, the
 * runtime-context block and the board route are the seams another half of the product is wired to.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, name, inject, short } from './support/mock-ctx.mjs'

test('plugin exports its identity', () => {
  assert.equal(name, 'peer-bus')
  // `webServer` is declared on purpose: the Loader publishes it before activation, which is what
  // keeps the board route registered on a cold start (a one-shot ctx.get used to miss it).
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'agents', 'webServer'])
})

test('the Host-visible tool surface of v1 is registered', () => {
  const harness = createHarness()
  const required = [
    'peer_sessions',
    'peer_send',
    'peer_inbox',
    'peer_intent',
    'peer_wait',
    'peer_new_session',
    'peer_archive_session',
  ]
  for (const toolName of required) harness.requireTool(toolName)

  for (const definition of harness.tools.values()) {
    assert.equal(typeof definition.description, 'string', `${definition.name} has a description`)
    assert.ok(definition.description.length > 20, `${definition.name} description is model-facing`)
    assert.equal(typeof definition.execute, 'function', `${definition.name} has execute()`)
    assert.equal(typeof definition.parameters, 'object', `${definition.name} declares parameters`)
  }
})

test('the always-on board context block is registered once, as a per-assembly function', () => {
  const harness = createHarness()
  const boardBlocks = harness.contexts.filter((entry) => entry.name === 'peer-bus:board')
  assert.equal(boardBlocks.length, 1, 'exactly one board context block')
  const block = boardBlocks[0]
  assert.equal(typeof block.text, 'function', 'board text is computed per assembly')
  assert.equal(typeof block.order, 'number', 'board block declares a prompt order')
  assert.ok(block.order > 0)
  // A block that is not stable for one agent would churn the prompt cache.
  const agent = harness.addAgent('session-aaaa1111', 'C:\\project')
  harness.addAgent('session-bbbb2222', 'C:\\PROJECT\\')
  assert.equal(harness.boardFor(agent), harness.boardFor(agent))
})

test('the board web route is registered on the webServer service', () => {
  const harness = createHarness()
  assert.ok(harness.routes.length >= 1, 'at least one route is registered')
  const board = harness.routes.find((route) => String(route.path).includes('/peer-bus/board'))
  assert.ok(board !== undefined, `a /peer-bus/board route exists; got ${harness.routes.map((route) => route.path).join(', ')}`)
  assert.equal(typeof board.handler, 'function')
})

test('a deployment without a webServer still loads (the route is optional)', () => {
  const harness = createHarness({ webServer: false })
  assert.equal(harness.routes.length, 0)
  const agent = harness.addAgent('session-aaaa1111', 'C:\\project')
  harness.addAgent('session-bbbb2222', 'C:\\project')
  assert.ok(harness.boardFor(agent).includes(short('session-bbbb2222')))
})
