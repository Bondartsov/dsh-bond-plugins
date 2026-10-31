/**
 * CONTRACT.md §1 — the v2 board served at `GET /peer-bus/board`.
 *
 * Guard: the payload the browser half renders must satisfy the frozen v2 schema — required fields,
 * types, `cost` null-or-object, unique ids — and the route must stay same-origin, no-store JSON.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './support/mock-ctx.mjs'
import { assertBoardSchema, collectBoardProblems } from './support/board-schema.mjs'

/** A populated workspace: claims, a thread, dnd and a subagent. */
async function populated() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\project')
  const child = harness.addAgent('session-child999', 'C:\\project', { header: { origin: 'subagent' } })
  await harness.callTool('peer_claim', { resource: 'merge:main', note: 'PR #42' }, a)
  await harness.callTool('peer_intent', { dnd: true, intent: undefined, text: 'в фокусе' }, b)
  await harness.callTool('peer_send', { to: 'bb2222', message: 'кто мержит?', kind: 'question' }, a)
  await harness.settle()
  return { harness, a, b, child }
}

test('the board route answers with same-origin, no-store JSON', async () => {
  const harness = createHarness()
  harness.addAgent('session-aaaa1111', 'C:\\project')
  const response = await harness.request('/peer-bus/board', { method: 'GET' })
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'] ?? '', /application\/json/)
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('the v2 board matches the frozen schema', async () => {
  const { harness } = await populated()
  const board = await harness.board()
  assertBoardSchema(board, 'GET /peer-bus/board')
  assert.equal(board.version, 2)
  assert.ok(Array.isArray(board.projects) && board.projects.length >= 1, 'the project list is present')
  assert.ok(board.projects.some((project) => project.root !== ''), 'a project root is reported')
})

test('the board carries the new v2 fields and keeps the old ones', async () => {
  const { harness, a, b } = await populated()
  const board = await harness.board()

  assert.ok(Array.isArray(board.claims) && board.claims.length === 1, 'claims are present')
  assert.ok(Array.isArray(board.threads) && board.threads.length === 1, 'threads are present')
  assert.equal(typeof board.updatedAt, 'number', 'the old updatedAt survives')

  const nodeA = board.nodes.find((node) => node.id === a.id)
  const nodeB = board.nodes.find((node) => node.id === b.id)
  assert.ok(nodeA.claims.includes('merge:main'), 'a node lists its claims')
  assert.equal(nodeB.dnd, true, 'dnd is per node')
  assert.equal(nodeA.role, 'worker')
  assert.ok(nodeA.master === false)
  assert.equal(typeof nodeA.openThreads, 'number', 'openThreads is counted')
  assert.equal(nodeA.openThreads, 1)
  assert.ok(Object.hasOwn(nodeA, 'cost'), 'cost is always present (null when unavailable)')
  assert.ok(nodeA.cost === null || typeof nodeA.cost.total === 'number', 'cost is null or a cost object')
  assert.equal(typeof nodeA.short, 'string')
  assert.equal(typeof nodeA.project, 'string')
  assert.equal(typeof nodeA.status, 'string')
})

test('the master is reflected in both projects[].master and nodes[].master', async () => {
  const { harness, b } = await populated()
  await harness.callTool('peer_intent', { master: true }, b)
  await harness.settle()
  const board = await harness.board()
  assertBoardSchema(board)
  const master = board.nodes.find((node) => node.id === b.id)
  assert.equal(master.master, true)
  assert.equal(master.role, 'master')
  assert.ok(board.projects.some((project) => project.master === b.id), 'the project names its master')
})

test('a subagent node is flagged, an archived peer is not shown at all', async () => {
  const { harness, child, a, b } = await populated()
  const board = await harness.board()
  const childNode = board.nodes.find((node) => node.id === child.id)
  assert.ok(childNode !== undefined, 'a subagent is a node, so the UI can draw the tree')
  assert.equal(childNode.subagent, true)

  harness.services.workspaceController = {
    async archiveSession() {
      return { archivedSessionIds: [b.id] }
    },
  }
  await harness.callTool('peer_archive_session', { session: 'bb2222' }, a)
  const after = await harness.board()
  assert.ok(!after.nodes.some((node) => node.id === b.id), 'an archived peer leaves the board')
  assertBoardSchema(after)
})

test('the schema validator rejects a broken board', () => {
  const valid = {
    version: 2,
    updatedAt: 1,
    projects: [{ root: 'D:\\proj', master: null }],
    claims: [],
    threads: [],
    nodes: [
      {
        id: 'session-1',
        short: 'ssion-1'.slice(-6),
        name: 'main',
        status: 'idle',
        role: 'worker',
        master: false,
        subagent: false,
        dnd: false,
        intent: '',
        last: '',
        parent: null,
        cwd: 'D:\\proj',
        project: 'D:\\proj',
        claims: [],
        openThreads: 0,
        cost: null,
      },
    ],
  }
  assert.deepEqual(collectBoardProblems(valid), [])

  const brokenCases = [
    [{ ...valid, version: 1 }, 'version'],
    [{ ...valid, nodes: undefined }, 'nodes'],
    [{ ...valid, nodes: [{ ...valid.nodes[0], status: 'zombie' }] }, 'status'],
    [{ ...valid, nodes: [{ ...valid.nodes[0], role: 'king' }] }, 'role'],
    [{ ...valid, nodes: [{ ...valid.nodes[0], cost: { total: Number.NaN, currency: 'RUB' } }] }, 'cost'],
    [{ ...valid, nodes: [...valid.nodes, { ...valid.nodes[0] }] }, 'unique'],
    [{ ...valid, claims: [{ resource: 'x', holder: 'h', holderName: 'n', since: 2, expiresAt: 1, note: '' }] }, 'expiresAt'],
    [{ ...valid, threads: [{ id: 't', subject: '', status: 'open', from: 'a', to: null, createdAt: 0, lastAt: 0, messages: -1 }] }, 'messages'],
  ]
  for (const [board, reason] of brokenCases) {
    const problems = collectBoardProblems(board)
    assert.ok(problems.length > 0, `a board with a broken ${reason} is rejected`)
  }
})

test('the board route rejects a non-GET method', async () => {
  const harness = createHarness()
  const response = await harness.request('/peer-bus/board', { method: 'POST', body: {} })
  assert.equal(response.status, 405)
})

test('a project names its master even when that session is cold', async () => {
  const { harness, b } = await populated()
  await harness.callTool('peer_intent', { master: true }, b)
  await harness.settle()
  harness.disposeAgent(b)

  const board = await harness.board()
  assertBoardSchema(board)
  const coldNode = board.nodes.find((node) => node.id === b.id)
  assert.ok(coldNode !== undefined, 'the cold master keeps its row')
  assert.equal(coldNode.master, true)
  assert.equal(coldNode.status, 'closed')
  const project = board.projects.find((entry) => entry.root === coldNode.project)
  assert.equal(project.master, b.id, 'the project header still names the sleeping master')
})
