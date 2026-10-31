/**
 * CONTRACT.md §2 — actions from the UI.
 *
 * Guard: `POST /peer-bus/master` assigns the role and returns the whole new board; the route is
 * same-origin only (a foreign `sec-fetch-site` is 403) and a POST must be JSON. These checks are
 * the CSRF boundary between a browser tab and the Host.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './support/mock-ctx.mjs'
import { assertBoardSchema } from './support/board-schema.mjs'

/** Two peers in one project. */
function workspace() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  return { harness, a, b }
}

/** POST JSON to the master route. */
function postMaster(harness, body, headers = {}) {
  return harness.request('/peer-bus/master', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

test('POST /peer-bus/master assigns the role and returns the whole v2 board', async () => {
  const { harness, a } = workspace()
  const response = await postMaster(harness, { sessionId: a.id })

  assert.equal(response.status, 200)
  const board = response.json()
  assertBoardSchema(board, 'POST /peer-bus/master response')
  assert.equal(board.nodes.find((node) => node.id === a.id).master, true)
  assert.ok(board.projects.some((project) => project.master === a.id))
})

test('assigning a new master demotes the previous one in one call', async () => {
  const { harness, a, b } = workspace()
  await postMaster(harness, { sessionId: a.id })
  const response = await postMaster(harness, { sessionId: b.id })
  const board = response.json()

  assert.equal(board.nodes.find((node) => node.id === b.id).master, true, 'the new master holds the role')
  assert.equal(board.nodes.find((node) => node.id === a.id).master, false, 'the old master is demoted')
  assert.equal(board.nodes.filter((node) => node.master === true).length, 1, 'only one master exists')
})

test('a missing sessionId is 400', async () => {
  const { harness } = workspace()
  const response = await postMaster(harness, {})
  assert.equal(response.status, 400)
})

test('an unknown session is 404', async () => {
  const { harness } = workspace()
  const response = await postMaster(harness, { sessionId: 'session-nobody00' })
  assert.equal(response.status, 404)
})

test('a foreign sec-fetch-site is rejected with 403 on both routes', async () => {
  const { harness } = workspace()
  const post = await postMaster(harness, { sessionId: 'session-aaaa1111' }, { 'sec-fetch-site': 'cross-site' })
  assert.equal(post.status, 403, 'a cross-site POST is refused')

  const get = await harness.request('/peer-bus/board', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(get.status, 403, 'a cross-site GET is refused too')
})

test('same-origin and absent sec-fetch-site are both accepted', async () => {
  const { harness, a, b } = workspace()
  const sameOriginPost = await postMaster(harness, { sessionId: a.id }, { 'sec-fetch-site': 'same-origin' })
  assert.equal(sameOriginPost.status, 200)

  const noHeaderPost = await postMaster(harness, { sessionId: b.id })
  assert.equal(noHeaderPost.status, 200)

  const get = await harness.request('/peer-bus/board', { method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } })
  assert.equal(get.status, 200)
  assert.equal(get.headers['cache-control'], 'no-store')
})

test('a POST without content-type: application/json is refused', async () => {
  const { harness, a } = workspace()
  const response = await harness.request('/peer-bus/master', {
    method: 'POST',
    body: { sessionId: a.id },
    headers: { 'content-type': 'text/plain' },
  })
  assert.ok(response.status >= 400 && response.status < 500, `a non-JSON POST is refused (got ${response.status})`)
  assert.ok(!response.headers['content-type']?.includes('application/json') || response.status !== 200)
})

test('a foreign origin header is not enough to pass: sec-fetch-site wins', async () => {
  const { harness, a } = workspace()
  const response = await postMaster(harness, { sessionId: a.id }, {
    origin: 'https://evil.example',
    'sec-fetch-site': 'cross-site',
  })
  assert.equal(response.status, 403)
})
