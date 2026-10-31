/**
 * Cold sessions on the board — the reader that survives a DSH version change.
 *
 * Guard: after a Host restart nothing is live, so the board must still list the project's sessions
 * by reading them through whichever session source the build offers, in this order:
 * `sessionController.list` (any envelope), `sessionQuery.listSessions`, then the session folders on
 * disk. Break any of the three and the board silently collapses to "masters only".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHarness } from './support/mock-ctx.mjs'

/** A harness whose session services are swapped by the test. */
function harnessWithSessions() {
  const harness = createHarness()
  harness.addAgent('session-live0001', 'C:\\project')
  return harness
}

test('the board lists cold sessions when the controller answers in the `sessions` envelope', async () => {
  const harness = harnessWithSessions()
  harness.services.sessionController = {
    calls: [],
    async list(request, signal) {
      this.calls.push({ request, signal })
      return {
        sessions: [
          { header: { id: 'session-cold0001', cwd: 'C:\\project' }, title: 'Доделка этапа Э2', status: 'closed' },
          { sessionId: 'session-cold0002', cwd: 'C:\\other', running: false },
        ],
      }
    },
  }

  const board = await harness.board()
  const cold = board.nodes.find((node) => node.id === 'session-cold0001')
  assert.ok(cold !== undefined, 'a session from the `sessions` envelope reaches the board')
  assert.equal(cold.status, 'closed', 'a cold session is closed, not dropped')
  assert.equal(cold.title, 'Доделка этапа Э2', 'the title comes from `title` as well as projections')
  assert.equal(cold.cwd, 'C:\\project')
  assert.equal(cold.project, 'C:\\project')
  assert.ok(harness.services.sessionController.calls.length >= 1, 'the controller was actually asked')
})

test('the board falls back to `sessionQuery.listSessions` when no controller lists sessions', async () => {
  const harness = harnessWithSessions()
  harness.services.sessionQuery = {
    async listSessions() {
      return [{ sessionId: 'session-cold0003', cwd: 'C:\\project', title: 'RAG-качество' }]
    },
  }

  const board = await harness.board()
  const cold = board.nodes.find((node) => node.id === 'session-cold0003')
  assert.ok(cold !== undefined, 'a bare array from sessionQuery is understood')
  assert.equal(cold.title, 'RAG-качество')
  assert.equal(cold.status, 'closed')
})

test('the board reads the session folders when no service can list sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'peer-bus-facts-'))
  const profile = join(root, 'home', '.dsh', 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  const projectFolder = '--D-Projects-Smart_Comply_Core--'
  mkdirSync(join(root, 'home', '.dsh', 'sessions', projectFolder, 'session-cold0004'), { recursive: true })
  writeFileSync(join(root, 'home', '.dsh', 'sessions', projectFolder, 'session-cold0004', 'session.v4.jsonl.zstd'), '')

  const harness = createHarness({ profileDir: profile })
  harness.addAgent('session-live0002', 'D:\\Projects\\Smart_Comply_Core')

  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  try {
    const board = await harness.board()
    const cold = board.nodes.find((node) => node.id === 'session-cold0004')
    assert.ok(cold !== undefined, 'a session folder is read when no service answers')
    assert.equal(cold.cwd, 'D:\\Projects\\Smart_Comply_Core', 'the project folder decodes back to its path')
    assert.equal(cold.status, 'closed')
    assert.ok(
      board.projects.some((project) => project.root === 'D:\\Projects\\Smart_Comply_Core'),
      'the project itself appears even without a live session',
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

test('the board never invents a project out of an unrelated folder name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'peer-bus-facts-'))
  const profile = join(root, 'home', '.dsh', 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  mkdirSync(join(root, 'home', '.dsh', 'sessions', 'not-an-encoded-name', 'session-cold0005'), { recursive: true })

  const harness = createHarness({ profileDir: profile })
  harness.addAgent('session-live0003', 'C:\\project')

  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = profile
  try {
    const board = await harness.board()
    assert.ok(!board.nodes.some((node) => node.id === 'session-cold0005'), 'a folder that is not an encoded path is ignored')
    assert.ok(!board.projects.some((project) => project.root.includes('not-an-encoded-name')))
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

test('the diagnostics route names the reader that produced the list', async () => {
  const harness = harnessWithSessions()
  harness.services.sessionController = {
    async list() {
      return { items: [{ sessionId: 'session-cold0006', cwd: 'C:\\project', projections: { values: { title: 'Э3' } } }] }
    },
  }

  const response = await harness.request('/peer-bus/debug/sessions', { method: 'GET' })
  assert.equal(response.status, 200)
  const body = response.json()
  assert.equal(body.source, 'sessionController')
  assert.equal(body.count, 1)
  assert.equal(body.sample[0].sessionId, 'session-cold0006')
  assert.equal(body.sample[0].title, 'Э3')
  assert.equal(body.sample[0].cwd, 'C:\\project')
})

test('the diagnostics route rejects a cross-site read and a non-GET method', async () => {
  const harness = harnessWithSessions()
  const crossSite = await harness.request('/peer-bus/debug/sessions', { method: 'GET', secFetchSite: 'cross-site' })
  assert.equal(crossSite.status, 403)
  const post = await harness.request('/peer-bus/debug/sessions', { method: 'POST', body: {} })
  assert.equal(post.status, 405)
})
