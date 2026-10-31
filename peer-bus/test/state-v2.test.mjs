/**
 * CONTRACT.md §4 — the durable side-state file.
 *
 * Guard: state written by one Host lifetime is read back by the next one (master role, claims,
 * threads, dnd, spawn edges), the file is JSON with `version: 2`, and unknown fields are ignored
 * instead of crashing the load.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from './support/mock-ctx.mjs'

/** The documented state file path inside a harness profile. */
const stateFile = (harness) => join(harness.profileDir, '.peer-bus-state.json')

/**
 * Read the state file as JSON. The write is serialized and atomic (`writeFile` + `rename`), so a
 * slow machine can still be a few milliseconds behind `settle()`; poll briefly instead of racing.
 */
async function readState(harness) {
  const deadline = Date.now() + 2000
  let last
  for (;;) {
    try {
      return JSON.parse(readFileSync(stateFile(harness), 'utf8'))
    } catch (error) {
      last = error
      if (Date.now() > deadline) throw last
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

test('the state file is version 2 and carries the documented keys', async () => {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  await harness.callTool('peer_intent', { master: true, label: 'main', text: 'гоню гейты', dnd: true }, a)
  await harness.callTool('peer_claim', { resource: 'merge:main', note: 'PR' }, a)
  await harness.callTool('peer_send', { to: 'bb2222', message: 'готов?', kind: 'question' }, a)
  await harness.settle(100)

  const state = await readState(harness)
  assert.equal(state.version, 2)
  for (const key of ['master', 'parents', 'labels', 'intents', 'dnd', 'claims', 'threads', 'spawned']) {
    assert.ok(Object.hasOwn(state, key), `state.${key} is present`)
  }
  assert.equal(state.master.id, a.id)
  assert.equal(state.labels[a.id], 'main')
  assert.ok(Array.isArray(state.claims) && state.claims.some((claim) => claim.resource === 'merge:main'))
  const persistedClaim = state.claims.find((claim) => claim.resource === 'merge:main')
  assert.equal(typeof persistedClaim.project, 'string', 'a persisted claim names its project (§1 project scope)')
  assert.ok(persistedClaim.project !== '', 'the project root is not empty')
  assert.ok(Array.isArray(state.threads) && state.threads.length === 1)
  assert.ok(Array.isArray(state.dnd) && state.dnd.includes(a.id))
})

test('a restart restores the master role, claims and threads from disk', async () => {
  const first = createHarness()
  const a = first.addAgent('session-aaaa1111', 'C:\\project')
  first.addAgent('session-bbbb2222', 'C:\\project')
  await first.callTool('peer_intent', { master: true, label: 'main' }, a)
  await first.callTool('peer_claim', { resource: 'merge:main' }, a)
  await first.callTool('peer_send', { to: 'bb2222', message: 'вопрос', kind: 'question' }, a)
  await first.settle(100)

  // A second Host lifetime over the same profile directory.
  const second = createHarness({ profileDir: first.profileDir })
  const a2 = second.addAgent('session-aaaa1111', 'C:\\project')
  const b2 = second.addAgent('session-bbbb2222', 'C:\\project')
  await second.settle(100)

  assert.ok(second.boardFor(b2).includes('[master]'), 'the master role survived the restart')
  assert.ok(second.boardFor(b2).includes('main'), 'the declared name survived the restart')

  const board = await second.board()
  assert.ok(board.claims.some((claim) => claim.resource === 'merge:main' && claim.holder === a.id), 'the claim survived')
  assert.equal(board.threads.length, 1, 'the thread survived')
  assert.equal(a2.id, a.id)
})

test('unknown fields in the state file are ignored, not fatal', async () => {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  await harness.callTool('peer_intent', { master: true }, a)
  await harness.settle(100)

  const state = await readState(harness)
  state.futureField = { arbitrary: [1, 2, 3] }
  state.version = 2
  writeFileSync(stateFile(harness), JSON.stringify(state), 'utf8')

  const second = createHarness({ profileDir: harness.profileDir })
  const a2 = second.addAgent('session-aaaa1111', 'C:\\project')
  const b2 = second.addAgent('session-bbbb2222', 'C:\\project')
  await second.settle(100)
  assert.ok(second.boardFor(b2).includes('[master]'), 'the known fields still load')
  assert.equal(a2.id, a.id)
})

test('a corrupt state file is not fatal either', async () => {
  const harness = createHarness()
  writeFileSync(stateFile(harness), '{ this is not json', 'utf8')
  const second = createHarness({ profileDir: harness.profileDir })
  const a = second.addAgent('session-aaaa1111', 'C:\\project')
  second.addAgent('session-bbbb2222', 'C:\\project')
  await second.settle(50)
  assert.ok(harness.boardFor(a).length >= 0)
  const board = await second.board()
  assert.equal(board.version, 2)
})

