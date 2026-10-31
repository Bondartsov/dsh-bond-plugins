/**
 * CONTRACT.md §3 `peer_claim` / `peer_release` — one resource, one holder.
 *
 * Guard (the most important one in the feature): a resource is never handed to two sessions at
 * the same time, a foreign release cannot steal it, and an expired claim frees itself so a crash
 * cannot block a merge forever.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHarness } from './support/mock-ctx.mjs'
import { assertBoardSchema } from './support/board-schema.mjs'

/** Two peers in one project. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  return { harness, a, b }
}

/** The v2 board read through the real route. */
async function boardOf(harness) {
  const board = await harness.board()
  assertBoardSchema(board, 'GET /peer-bus/board')
  return board
}

/** The claim for a resource on the board, if any. */
const claimOf = (board, resource) => board.claims.find((claim) => claim.resource === resource)

test('a claim is taken, reported and visible on the board', async () => {
  const { harness, a } = workspace()
  await harness.callTool('peer_claim', { resource: 'merge:main', note: 'мержу PR #42' }, a)

  const board = await boardOf(harness)
  const claim = claimOf(board, 'merge:main')
  assert.ok(claim !== undefined, 'the claimed resource appears on the board')
  assert.equal(claim.holder, a.id)
  assert.equal(typeof claim.holderName, 'string')
  assert.ok(claim.holderName.length > 0, 'the holder is named for humans')
  assert.equal(typeof claim.since, 'number')
  assert.ok(claim.expiresAt > claim.since, 'the claim has a future expiry')
  assert.ok(claim.note.includes('мержу PR #42'), 'the note is carried')

  const node = board.nodes.find((entry) => entry.id === a.id)
  assert.ok(node.claims.includes('merge:main'), 'the node lists the resources it holds')
})

test('a second holder is refused with CLAIM_HELD naming the holder', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_claim', { resource: 'merge:main' }, a)
  const error = await harness.expectError(
    () => harness.callTool('peer_claim', { resource: 'merge:main' }, b),
    'CLAIM_HELD',
  )
  assert.ok(error.message.includes('aa1111') || error.message.includes(a.id), `the error names the holder: ${error.message}`)

  const board = await boardOf(harness)
  assert.equal(board.claims.filter((claim) => claim.resource === 'merge:main').length, 1, 'still exactly one holder')
})

test('release frees the resource for the next holder; a foreign release is refused', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_claim', { resource: 'deploy:staging' }, a)

  // B must not be able to steal the claim by "releasing" it.
  await harness.expectError(() => harness.callTool('peer_release', { resource: 'deploy:staging' }, b), 'NOT_OWNER')
  assert.ok(claimOf(await boardOf(harness), 'deploy:staging') !== undefined, 'the foreign release changed nothing')

  await harness.callTool('peer_release', { resource: 'deploy:staging' }, a)
  const board = await boardOf(harness)
  assert.equal(claimOf(board, 'deploy:staging'), undefined, 'the released resource is gone from the board')

  await harness.callTool('peer_claim', { resource: 'deploy:staging' }, b)
  const after = await boardOf(harness)
  assert.equal(claimOf(after, 'deploy:staging').holder, b.id, 'the freed resource goes to the next holder')
})

test('releasing a resource nobody holds uses CLAIM_NOT_HELD', async () => {
  const { harness, a } = workspace()
  await harness.expectError(() => harness.callTool('peer_release', { resource: 'never:held' }, a), 'CLAIM_NOT_HELD')
})

test('an expired claim frees itself without anyone releasing it', async () => {
  const { harness, a, b } = workspace()
  await harness.callTool('peer_claim', { resource: 'merge:main', ttl_seconds: 1 }, a)
  assert.ok(claimOf(await boardOf(harness), 'merge:main') !== undefined, 'the claim is live at first')

  // Wait past the TTL, then a competitor claims without any release call.
  const deadline = Date.now() + 5_000
  let taken = false
  while (Date.now() < deadline && !taken) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      await harness.callTool('peer_claim', { resource: 'merge:main' }, b)
      taken = true
    } catch {
      /* still held by the un-expired claim */
    }
  }
  assert.ok(taken, 'the stale claim released itself and the resource changed hands')
  const board = await boardOf(harness)
  assert.equal(board.claims.filter((claim) => claim.resource === 'merge:main').length, 1)
  assert.equal(claimOf(board, 'merge:main').holder, b.id)
})

test('an expired claim disappears from the board by itself', async () => {
  const { harness, a } = workspace()
  await harness.callTool('peer_claim', { resource: 'merge:main', ttl_seconds: 1 }, a)
  assert.ok(claimOf(await boardOf(harness), 'merge:main') !== undefined, 'the claim is advertised at first')

  // No release, no competitor: the board itself must stop advertising a claim whose TTL has passed.
  const deadline = Date.now() + 5_000
  let gone = false
  while (Date.now() < deadline && !gone) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    gone = claimOf(await boardOf(harness), 'merge:main') === undefined
  }
  assert.ok(gone, 'the board stopped advertising the expired claim without anyone touching it')
})

test('the default TTL is 900s and the maximum is 86400s', async () => {
  const { harness, a } = workspace()
  const before = Date.now()
  await harness.callTool('peer_claim', { resource: 'merge:default-ttl' }, a)
  const defaultClaim = claimOf(await boardOf(harness), 'merge:default-ttl')
  const defaultTtl = Math.round((defaultClaim.expiresAt - before) / 1000)
  assert.ok(Math.abs(defaultTtl - 900) <= 3, `the default TTL is 900s (got ${defaultTtl})`)

  // Above the cap the contract is violated either by clamping or by refusing; both are safe, a
  // claim longer than 24 h is not. This host refuses with BAD_ARGUMENT.
  const tooLong = harness.callTool('peer_claim', { resource: 'merge:max-ttl', ttl_seconds: 10_000_000 }, a)
  const settled = await Promise.allSettled([tooLong])
  const outcome = settled[0]
  if (outcome.status === 'rejected') {
    assert.match(outcome.reason.message, /BAD_ARGUMENT|86400/, `an over-long TTL is refused: ${outcome.reason.message}`)
  } else {
    const maxClaim = claimOf(await boardOf(harness), 'merge:max-ttl')
    const maxTtl = Math.round((maxClaim.expiresAt - before) / 1000)
    assert.ok(maxTtl <= 86_400 + 3, `the TTL is capped at 86400s (got ${maxTtl})`)
  }

  await harness.callTool('peer_claim', { resource: 'merge:exact-max-ttl', ttl_seconds: 86_400 }, a)
  const exact = claimOf(await boardOf(harness), 'merge:exact-max-ttl')
  assert.ok(Math.round((exact.expiresAt - before) / 1000) <= 86_400 + 3, 'the documented maximum is accepted')
})

test('a resource is a bounded string; an empty or oversized one is a BAD_ARGUMENT', async () => {
  const { harness, a } = workspace()
  await harness.expectError(() => harness.callTool('peer_claim', { resource: '' }, a), 'BAD_ARGUMENT')
  await harness.expectError(() => harness.callTool('peer_claim', { resource: 'x'.repeat(65) }, a), 'BAD_ARGUMENT')
})

test('the same resource name in two projects never blocks either holder', async () => {
  const harness = createHarness()
  const alpha = harness.addAgent('session-alpha001', 'C:\\alpha')
  const beta = harness.addAgent('session-beta002', 'C:\\beta')

  const claimedAlpha = await harness.callTool('peer_claim', { resource: 'merge:main' }, alpha)
  const claimedBeta = await harness.callTool('peer_claim', { resource: 'merge:main' }, beta)
  assert.equal(typeof claimedAlpha.project, 'string', 'the claim result names its project')
  assert.equal(typeof claimedBeta.project, 'string')

  const board = await boardOf(harness)
  const claims = board.claims.filter((claim) => claim.resource === 'merge:main')
  assert.equal(claims.length, 2, 'two projects hold "merge:main" independently')
  assert.equal(new Set(claims.map((claim) => claim.project)).size, 2, 'the two claims belong to different projects')
  assert.ok(claims.every((claim) => claim.projectName !== ''), 'each claim is labelled with a project name')

  // Each node lists only the claims of its own project.
  const alphaNode = board.nodes.find((node) => node.id === alpha.id)
  const betaNode = board.nodes.find((node) => node.id === beta.id)
  assert.deepEqual(alphaNode.claims, ['merge:main'])
  assert.deepEqual(betaNode.claims, ['merge:main'])

  // Releasing in one project does not free the resource in the other.
  await harness.callTool('peer_release', { resource: 'merge:main' }, beta)
  const after = await boardOf(harness)
  const remaining = after.claims.filter((claim) => claim.resource === 'merge:main')
  assert.equal(remaining.length, 1, 'the other project still holds its claim')
  assert.equal(remaining[0].holder, alpha.id)
})

test('a legacy claim without a project in the state file is ignored and blocks nothing', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'peer-bus-legacy-claim-'))
  const profileDir = join(sandbox, 'profile')
  mkdirSync(profileDir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(profileDir, '.peer-bus-state.json'),
    JSON.stringify({
      version: 2,
      master: null,
      // A v1-shaped claim: it has no project, so it cannot be attributed to any project.
      claims: [{ resource: 'merge:main', holder: 'session-legacy01', since: now - 1_000, expiresAt: now + 600_000, note: '' }],
    }),
    'utf8',
  )

  const harness = createHarness({ profileDir })
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  harness.addAgent('session-bbbb2222', 'C:\\project')
  await harness.settle(100)

  const board = await boardOf(harness)
  assert.ok(
    !board.claims.some((claim) => claim.resource === 'merge:main'),
    'a claim without a project is not guessed into some project and not shown on the board',
  )

  // And it must not block a real claim either.
  await harness.callTool('peer_claim', { resource: 'merge:main' }, a)
  const after = await boardOf(harness)
  const claims = after.claims.filter((claim) => claim.resource === 'merge:main')
  assert.equal(claims.length, 1)
  assert.equal(claims[0].holder, a.id, 'the live session holds the resource, not the legacy record')
})
