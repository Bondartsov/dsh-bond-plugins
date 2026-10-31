/**
 * Unit tests for the Host half's full-restart route (mocks only, no live Host).
 *
 * Run: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { handleRestart, planRestart } from '../index.js'

/** A fake `ServerResponse` that records what the handler answered. */
function fakeResponse() {
  const captured = { status: 0, body: '', headers: {} }
  return {
    captured,
    setHeader(name, value) {
      captured.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers) {
      captured.status = status
      captured.headers = { ...captured.headers, ...(headers ?? {}) }
      return this
    },
    end(body) {
      captured.body = body ?? ''
      captured.json = captured.body === '' ? undefined : JSON.parse(captured.body)
    },
  }
}

/** A fake request whose body is served from a string. */
function fakeRequest(method, body, headers = { [HEADER_FOR_TESTS]: '1' }) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
}

const HEADER_FOR_TESTS = 'x-dsh-reload'

/** A fake plugin context with the services these routes read. */
function fakeContext({ agents = [], sessions = [], hmr } = {}) {
  const calls = { flush: [], cancel: [] }
  const services = {
    agents: { list: () => agents },
    sessions: {
      list: () => sessions,
      flush: async (session) => {
        calls.flush.push(session.id)
        return true
      },
    },
    hmr,
  }
  return {
    calls,
    get: (name) => services[name],
  }
}

/** Facts of a Desktop Host: the parent is the Electron application itself. */
const DESKTOP_FACTS = {
  pid: 111,
  ppid: 222,
  execPath: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
  argv: ['app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js', 'runtime'],
  cwd: 'C:\\Users\\tester\\.dsh\\profiles\\desktop',
  electron: '44.7.0',
}

/** Test seams: the plan is computed for DESKTOP_FACTS and nothing is launched. */
function desktopDeps(overrides = {}) {
  const launched = []
  return {
    launched,
    deps: {
      facts: DESKTOP_FACTS,
      image: () => ({ alive: true, image: 'DeepSeek Harness.exe' }),
      launch: (plan) => launched.push(plan),
      schedule: () => {},
      exit: () => {},
      ...overrides,
    },
  }
}

test('409 while an agent runs and force is not set, and nothing is flushed', async () => {
  const ctx = fakeContext({
    agents: [
      { id: 'agent-running', status: 'running', cancel: (cause) => ctx.calls.cancel.push(cause) },
      { id: 'agent-idle', status: 'idle' },
    ],
    sessions: [{ id: 's1' }, { id: 's2' }],
  })
  const response = fakeResponse()
  const { deps } = desktopDeps()

  await handleRestart(ctx, fakeRequest('POST', {}), response, deps)

  assert.equal(response.captured.status, 409)
  assert.equal(response.captured.json.reason, 'agents-running')
  assert.deepEqual(response.captured.json.running, ['agent-running'])
  assert.match(response.captured.json.hint, /force: true/u)
  assert.deepEqual(ctx.calls.flush, [], 'a refused restart must not flush anything')
  assert.deepEqual(ctx.calls.cancel, [], 'a refused restart must not cancel anything')
})

test('force: true cancels running turns, flushes every live session and answers 202', async () => {
  const running = {
    id: 'agent-running',
    status: 'running',
    cancel: (cause) => ctx.calls.cancel.push(cause),
  }
  const ctx = fakeContext({ agents: [running], sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] })
  const response = fakeResponse()
  const { deps } = desktopDeps()

  await handleRestart(ctx, fakeRequest('POST', { force: true }), response, deps)

  assert.deepEqual(ctx.calls.cancel, [{ kind: 'user' }], 'the running turn is cancelled as a user action')
  assert.deepEqual(ctx.calls.flush, ['s1', 's2', 's3'], 'every live session is flushed')
  assert.equal(response.captured.status, 202)
  assert.equal(response.captured.json.restarting, true)
  assert.equal(response.captured.json.pid, DESKTOP_FACTS.pid)
  assert.equal(response.captured.json.flushed, 3)
})

test('dryRun describes the plan and neither flushes nor launches', async () => {
  const ctx = fakeContext({ sessions: [{ id: 's1' }] })
  const response = fakeResponse()
  const { deps, launched } = desktopDeps()

  await handleRestart(ctx, fakeRequest('POST', { dryRun: true }), response, deps)

  assert.equal(response.captured.status, 200)
  assert.equal(response.captured.json.dryRun, true)
  assert.equal(response.captured.json.mode, 'desktop')
  assert.equal(response.captured.json.wouldFlush, 1)
  assert.match(response.captured.json.script, /taskkill \/F \/T \/PID 222/u)
  assert.match(response.captured.json.script, /tree gone/u)
  assert.match(response.captured.json.script, /taskkill \/F \/PID 111/u, 'the Host pid is swept too, so the port is free')
  assert.match(response.captured.json.script, /host pid 111 gone/u)
  assert.match(response.captured.json.script, /start dispatched/u)
  assert.match(response.captured.json.script, /start "" "C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness\.exe"/u)
  assert.deepEqual(response.captured.json.launchers, ['wmic', 'schtasks', 'explorer', 'spawn-inside-tree'])
  assert.deepEqual(ctx.calls.flush, [], 'a dry run has no side effects')
  assert.deepEqual(launched, [], 'a dry run launches nothing')
})

test('a request without the guard header is refused', async () => {
  const ctx = fakeContext()
  const response = fakeResponse()
  const { deps } = desktopDeps()

  await handleRestart(ctx, fakeRequest('POST', {}, {}), response, deps)

  assert.equal(response.captured.status, 403)
})

test('the desktop plan refuses to kill a parent that is not the application', () => {
  const plan = planRestart({ ...DESKTOP_FACTS, parentImage: 'explorer.exe' })

  assert.equal(plan.ok, false)
  assert.match(plan.error, /refusing to kill/u)
})

test('a CLI Host gets a wait-then-start helper instead of a kill', () => {
  const plan = planRestart({
    pid: 4242,
    ppid: 1,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    argv: ['C:\\dsh\\bin.js', 'web'],
    electron: undefined,
    parentImage: '',
  })

  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'cli')
  assert.doesNotMatch(plan.script, /taskkill/u)
  assert.match(plan.script, /PID eq 4242/u)
  assert.match(plan.script, /start "" "C:\\Program Files\\nodejs\\node\.exe" "C:\\dsh\\bin\.js" "web"/u)
})
