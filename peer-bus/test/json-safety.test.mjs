/**
 * Lossless-JSON guard: every tool result must survive the Harness tool-output pipeline.
 *
 * The pipeline rejects `undefined`, `NaN`/`Infinity`, functions, symbols, bigints, cycles and
 * non-plain objects at any nesting depth. A tool that leaks one of those does not fail loudly at
 * runtime — it silently loses the whole result — so the rule is enforced here for every tool.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fakeSessionController, fakeWorkspaceController } from './support/mock-ctx.mjs'
import { assertLosslessJson, collectJsonProblems } from './support/json-safety.mjs'

test('the validator itself detects every lossy kind, at any depth', () => {
  assert.deepEqual(collectJsonProblems({ a: 1, b: 'x', c: true, d: null }), [])
  assert.deepEqual(collectJsonProblems([1, 'two', { three: 3 }]), [])

  const cases = [
    [{ a: undefined }, 'undefined'],
    [{ a: Number.NaN }, 'non-finite'],
    [{ a: Infinity }, 'non-finite'],
    [{ a: () => {} }, 'function'],
    [{ a: Symbol('x') }, 'symbol'],
    [{ a: 10n }, 'bigint'],
    [{ a: new Map() }, 'non-plain object'],
    [{ a: new Date() }, 'non-plain object'],
    [{ a: { b: [undefined] } }, 'undefined'],
  ]
  for (const [value, reason] of cases) {
    const problems = collectJsonProblems(value)
    assert.ok(problems.length > 0, `${reason} is rejected`)
    assert.ok(problems.some((problem) => problem.reason.includes(reason)), `reported as ${reason}: ${JSON.stringify(problems)}`)
  }

  const cyclic = {}
  cyclic.self = cyclic
  assert.ok(collectJsonProblems(cyclic).some((problem) => problem.reason === 'cycle'), 'a cycle is rejected')
  assert.throws(() => assertLosslessJson({ a: undefined }, 'demo'), /not lossless JSON/)
})

/** A workspace where every tool can be exercised on a happy path. */
async function readyWorkspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  harness.services.sessionController = fakeSessionController({
    createIds: ['session-new0001', 'session-new0002'],
    listItems: [{ sessionId: 'session-cold0001', cwd: 'C:\\project', status: 'closed' }],
  })
  harness.services.workspaceController = fakeWorkspaceController()
  await harness.callTool('peer_intent', { text: 'гоню гейты', label: 'main' }, b)
  await harness.callTool('peer_send', { to: 'main', message: 'статус?' }, a)
  return { harness, a, b }
}

test('every registered tool declares an output schema and a render function', () => {
  const harness = createHarness()
  for (const definition of harness.tools.values()) {
    assert.equal(typeof definition.output, 'object', `${definition.name} declares output`)
    assert.equal(typeof definition.output.schema, 'object', `${definition.name} declares output.schema`)
    assert.equal(typeof definition.output.render, 'function', `${definition.name} declares output.render`)
    assertLosslessJson(definition.output.schema, `${definition.name} output.schema`)
  }
})

test('every tool result on a happy path is lossless JSON', async () => {
  const { harness, a, b } = await readyWorkspace()
  const calls = [
    ['peer_sessions', {}],
    ['peer_sessions', { include_cold: true }],
    ['peer_send', { to: 'main', message: 'ещё раз' }],
    ['peer_send', { to: 'all', message: 'всем привет' }],
    ['peer_inbox', {}],
    ['peer_intent', { text: 'новый план', master: true }],
    ['peer_wait', { until: 'idle', timeout_seconds: 5 }],
    ['peer_new_session', { task: 'подзадача', title: 'Sub' }],
    ['peer_archive_session', { session: 'bb2222' }],
    ['peer_archive_session', { session: 'bb2222', restore: true }],
  ]
  for (const [toolName, args] of calls) {
    // `callTool` runs the lossless check itself; this test asserts the whole matrix is covered.
    const result = await harness.callTool(toolName, args, a)
    assertLosslessJson(result, `${toolName}(${JSON.stringify(args)})`)
  }
})

test('every tool render() produces only lossless content blocks', async () => {
  const { harness, a } = await readyWorkspace()
  const sample = {
    peer_sessions: await harness.callTool('peer_sessions', {}, a),
    peer_send: await harness.callTool('peer_send', { to: 'main', message: 'render check' }, a),
    peer_inbox: await harness.callTool('peer_inbox', {}, a),
    peer_intent: await harness.callTool('peer_intent', { text: 'render' }, a),
    peer_wait: await harness.callTool('peer_wait', { until: 'idle', timeout_seconds: 5 }, a),
    peer_new_session: await harness.callTool('peer_new_session', { task: 'render' }, a),
    peer_archive_session: await harness.callTool('peer_archive_session', { session: 'main' }, a),
  }
  for (const definition of harness.tools.values()) {
    const value = sample[definition.name]
    if (value === undefined) continue
    const blocks = definition.output.render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${definition.name} renders content blocks`)
    assertLosslessJson(blocks, `${definition.name} render`)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
  }
})

test('every tool refuses a call from no session without leaking a lossy result', async () => {
  const harness = createHarness()
  for (const definition of harness.tools.values()) {
    let failed = false
    try {
      await definition.execute({}, { agent: undefined })
    } catch (error) {
      failed = true
      assert.ok(error instanceof Error, `${definition.name} throws an Error, not a string`)
      assert.ok(error.message.length > 0, `${definition.name} error explains itself`)
    }
    assert.ok(failed, `${definition.name} refuses a call without an owning session`)
  }
})
