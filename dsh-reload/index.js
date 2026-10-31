/**
 * Reload — Host half.
 *
 * Two operations, both reachable only from this page:
 *
 * 1. `POST /dsh-reload/reload` — re-apply the profile without restarting the
 *    application. The heavy lifting is `ctx.hmr.reconcileProfile()`: it
 *    recomposes the profile from its manifest and patch files, replaces running
 *    plugins whose loaded files below the profile directory or its linked
 *    package targets changed on disk, stops their Loader entries, starts them
 *    again on the current files and imports the entries whose import had
 *    failed. That is the work a plugin author repeats by hand when editing
 *    `index.js` of a plugin under development.
 * 2. `POST /dsh-reload/restart` — leave the process and come back in a new one.
 *    Needed when the change is cached per process and no reconcile can refresh
 *    it: `@deepseek-ai/dsh-client-modules` remembers a package's verdict "not a
 *    client package" for the whole Host lifetime, so a `dsh.client` section
 *    added to an installed package only reaches `window.__DSH_BOOT__` after a
 *    new process.
 * 3. `GET /dsh-reload/status` — read-only facts about this Host process (pid,
 *    parent pid, executable, Electron version), which is how "the pid changed"
 *    is checked from outside.
 *
 * The Client half (`client.js`) calls these routes from the sidebar's More menu
 * and reloads the page afterwards.
 *
 * Why a web route and not a Host Remote method: a plain-JS bundle can register
 * an HTTP route through `ctx.webServer` without the Typert `@Remote` code
 * generation, and the page reaches it at the same origin both in the Web GUI
 * (`http://127.0.0.1:<port>/...`) and in the Desktop shell, whose `dsh-app://`
 * protocol forwards unknown paths to the Host listener.
 *
 * Why the restart is orchestrated by a helper script: this Host is a child
 * process of the Electron shell (`ELECTRON_RUN_AS_NODE=1`), and `require(
 * 'electron')` fails there, so `app.relaunch()` is out of reach. The helper
 * kills the application tree and starts the executable again; the Host itself
 * only prepares the plan, so nothing depends on the dying process surviving.
 */

import { createRequire } from 'node:module'
import { spawn as spawnChild } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export const name = 'dsh-reload'

/**
 * Load only once the browser HTTP carrier exists.
 *
 * Registering the routes from `ctx.get('webServer')` alone is not enough on a
 * cold start: the plugin rows load before that service is published, the lookup
 * answers `undefined` and the routes are never registered — the page then gets
 * 404 from a Host that otherwise runs fine. Declaring the dependency makes the
 * Loader hold this plugin until the service is available.
 */
export const inject = ['webServer']

/** Exact path the Client half POSTs to for a profile reconcile. */
const ROUTE = '/dsh-reload/reload'

/** Exact path the Client half POSTs to for a full process restart. */
const RESTART_ROUTE = '/dsh-reload/restart'

/** Read-only diagnostics route (GET): which process this Host runs in. */
const STATUS_ROUTE = '/dsh-reload/status'

/**
 * Custom request header the Client half sends and every mutating route demands.
 *
 * It keeps the routes out of reach for a random web page: a cross-origin
 * `fetch` with a custom header triggers a CORS preflight, which these routes
 * never answer, while the same-origin page sends it without one.
 */
const HEADER = 'x-dsh-reload'

/** Pause between the 202 answer and the helper taking over, so the page paints. */
const RESTART_DELAY_MS = 600

/** Where the helper writes its own trace, one line per step. */
const HELPER_LOG = join(tmpdir(), 'dsh-reload-restart.log')

/** JSON response with no caching. */
function reply(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Facts about the process this Host runs in, for the status route and for the
 * restart plan. `require('electron')` is probed because a Host launched by the
 * Desktop shell runs the Electron binary in Node mode, where that module may
 * hand back a path instead of the `app` API.
 * @returns {object} plain JSON.
 */
export function processFacts() {
  let electronModule = 'not-probed'
  try {
    const load = createRequire(import.meta.url)
    const value = load('electron')
    electronModule = value !== null && typeof value === 'object'
      ? `object(${Object.keys(value).slice(0, 6).join(',')})`
      : `${typeof value}:${String(value).slice(0, 80)}`
  } catch (error) {
    electronModule = `error:${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
  }
  return {
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    electron: process.versions.electron ?? null,
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    electronModule,
    profile: process.env.DSH_PROFILE ?? null,
    startedAt: new Date(Math.round(Date.now() - process.uptime() * 1000)).toISOString(),
  }
}

/**
 * Read a small JSON request body. A missing or malformed body is an empty
 * object, because every field of these requests is optional.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {Promise<object>} the parsed body.
 */
export async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8192) return {}
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * Agents that currently run a turn.
 * @param {object} ctx - the plugin context.
 * @returns {object[]} live agents whose status is `running`.
 */
export function runningAgents(ctx) {
  const registry = ctx.get('agents')
  if (registry === undefined || typeof registry.list !== 'function') return []
  const found = []
  for (const agent of registry.list()) {
    let status
    try {
      status = agent?.status
    } catch {
      status = undefined
    }
    if (status === 'running') found.push(agent)
  }
  return found
}

/**
 * Ask one agent to stop its current turn. A cancel authority that is missing or
 * rejects is reported, never fatal: the helper kills the process anyway, but a
 * cancelled turn ends its session log cleanly instead of mid-step.
 * @param {object} agent - the running agent.
 * @returns {string} `cancelled`, or the failure text.
 */
function cancelAgent(agent) {
  try {
    if (typeof agent.cancel === 'function') {
      agent.cancel({ kind: 'user' })
      return 'cancelled'
    }
    if (typeof agent.interrupt === 'function') {
      agent.interrupt({ kind: 'user' })
      return 'cancelled'
    }
    return 'no-cancel-authority'
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Flush every live session's buffered events to durable storage.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<{flushed: number, failed: string[]}>} how many sessions became durable.
 */
export async function flushLiveSessions(ctx) {
  const store = ctx.get('sessions')
  if (store === undefined || typeof store.list !== 'function' || typeof store.flush !== 'function') {
    return { flushed: 0, failed: ['the session store is unavailable'] }
  }
  const failed = []
  let flushed = 0
  for (const session of store.list()) {
    try {
      await store.flush(session)
      flushed += 1
    } catch (error) {
      failed.push(`${String(session?.id ?? '?')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { flushed, failed }
}

/**
 * Whether a pid currently exists, and which executable it runs.
 * @param {number} pid - the process to look up.
 * @returns {{alive: boolean, image: string}} the lookup result.
 */
export function processImage(pid) {
  try {
    const output = execFileSync('tasklist', ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    })
    const match = /^"([^"]+)"/u.exec(output.trim())
    if (match === null) return { alive: false, image: '' }
    return { alive: true, image: match[1] }
  } catch {
    return { alive: false, image: '' }
  }
}

/**
 * Compose the restart plan without performing it.
 *
 * Desktop: the Host's parent is the Electron main process (`appPid`), so the
 * helper kills that tree and starts the executable again — `app.relaunch()` is
 * unreachable from a Node-mode child.
 * CLI (`dsh web`): there is no shell above the Host, so the helper waits for
 * this pid to disappear (a normal exit frees the port) and starts the same
 * command again. A pinned port keeps the URL; otherwise the new process picks
 * its own.
 * @param {object} facts - {@link processFacts} plus the verified parent image.
 * @returns {{ok: true, mode: string, scriptPath: string, script: string} | {ok: false, error: string}}
 */
export function planRestart(facts) {
  const stamp = String(facts.pid)
  const scriptPath = join(tmpdir(), `dsh-reload-restart-${stamp}.cmd`)
  const log = HELPER_LOG
  const desktop = typeof facts.electron === 'string' && facts.electron !== ''
  const lines = [
    '@echo off',
    'setlocal',
    `>>"${log}" echo [%DATE% %TIME%] helper start old_host_pid=${stamp} target=${desktop ? 'desktop' : 'cli'}`,
  ]
  if (desktop) {
    const appPid = Number(facts.ppid)
    if (!Number.isSafeInteger(appPid) || appPid <= 0) {
      return { ok: false, error: 'the Host has no parent process, so the shell cannot be restarted' }
    }
    const expected = basename(facts.execPath).toLowerCase()
    const actual = String(facts.parentImage ?? '').toLowerCase()
    if (actual !== expected) {
      return {
        ok: false,
        error: `parent pid ${String(appPid)} runs "${facts.parentImage ?? 'unknown'}", not the ${expected} application; refusing to kill it`,
      }
    }
    // `timeout` refuses to wait when stdin is not a console, and the helper is
    // spawned with `stdio: 'ignore'`: a loopback ping is the delay that works
    // from a fully detached process.
    lines.push(
      'ping -n 3 127.0.0.1 >nul',
      `>>"${log}" echo [%DATE% %TIME%] killing app tree ${String(appPid)}`,
      `taskkill /F /T /PID ${String(appPid)} >>"${log}" 2>&1`,
      'set alive=1',
      `for /l %%i in (1,1,20) do (`,
      `  tasklist /FI "PID eq ${String(appPid)}" /FO CSV /NH | find "${String(appPid)}" >nul || (set alive=0 & goto :proceed)`,
      '  ping -n 2 127.0.0.1 >nul',
      ')',
      ':proceed',
      'if "%alive%"=="1" (',
      `  >>"${log}" echo [%DATE% %TIME%] app ${String(appPid)} survived the kill; not starting a second instance`,
      '  exit /b 1',
      ')',
      `>>"${log}" echo [%DATE% %TIME%] tree gone`,
      // Belt and braces for the port: the tree kill already took the Host, but an
      // orphaned Host would keep the listener bound and the new instance would
      // refuse to start, so its own pid is checked and killed explicitly.
      `taskkill /F /PID ${stamp} >>"${log}" 2>&1`,
      'set hostAlive=1',
      `for /l %%i in (1,1,10) do (`,
      `  tasklist /FI "PID eq ${stamp}" /FO CSV /NH | find "${stamp}" >nul || (set hostAlive=0 & goto :hostGone)`,
      '  ping -n 2 127.0.0.1 >nul',
      ')',
      ':hostGone',
      'if "%hostAlive%"=="1" (',
      `  >>"${log}" echo [%DATE% %TIME%] host pid ${stamp} survived the kill; the port is still bound, not starting a second instance`,
      '  exit /b 1',
      ')',
      `>>"${log}" echo [%DATE% %TIME%] host pid ${stamp} gone`,
      'ping -n 2 127.0.0.1 >nul',
      'cd /d "%USERPROFILE%"',
      `>>"${log}" echo [%DATE% %TIME%] starting app "${facts.execPath}"`,
      `start "" "${facts.execPath}"`,
      `>>"${log}" echo [%DATE% %TIME%] start dispatched`,
    )
  } else {
    // Wait for this Host to exit on its own, then start the same command again.
    const argv = facts.argv.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(' ')
    lines.push(
      `for /l %%i in (1,1,30) do (`,
      `  tasklist /FI "PID eq ${stamp}" /FO CSV /NH | find "${stamp}" >nul || goto :proceed`,
      '  ping -n 2 127.0.0.1 >nul',
      ')',
      ':proceed',
      `>>"${log}" echo [%DATE% %TIME%] starting "${facts.execPath}" ${argv}`,
      `start "" "${facts.execPath}" ${argv}`,
    )
  }
  lines.push('exit /b 0', '')
  return { ok: true, mode: desktop ? 'desktop' : 'cli', scriptPath, script: lines.join('\r\n') }
}

/**
 * Leave the process and come back in a new one.
 * @param {object} ctx - the plugin context.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @param {import('node:http').ServerResponse} response - the response to own.
 * @param {object} deps - seams for tests: `facts`, `launch`, `exit`, `schedule`, `image`.
 */
export async function handleRestart(ctx, request, response, deps = {}) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    reply(response, 405, { ok: false, error: 'POST only' })
    return
  }
  if (request.headers[HEADER] !== '1') {
    reply(response, 403, { ok: false, error: `missing ${HEADER}: 1 header` })
    return
  }

  const body = await readJsonBody(request)
  const force = body.force === true
  const dryRun = body.dryRun === true

  const busy = runningAgents(ctx)
  // A dry run only describes the plan, so a running agent cannot block it — and
  // the description is exactly what tells the caller force would be required.
  if (busy.length > 0 && !force && !dryRun) {
    reply(response, 409, {
      ok: false,
      reason: 'agents-running',
      running: busy.map((agent) => String(agent?.id ?? '?')),
      hint: 'Сейчас идёт ход агента. Повторите с force: true — активные ходы будут отменены, а логи сессий сольются на диск.',
    })
    return
  }

  const facts = deps.facts ?? processFacts()
  const image = deps.image ?? processImage
  const parent = facts.electron != null ? image(Number(facts.ppid)) : { alive: false, image: '' }
  const plan = planRestart({ ...facts, parentImage: parent.image })
  if (!plan.ok) {
    reply(response, 503, { ok: false, error: plan.error })
    return
  }

  if (dryRun) {
    reply(response, 200, {
      ok: true,
      dryRun: true,
      mode: plan.mode,
      scriptPath: plan.scriptPath,
      script: plan.script,
      // The helper must outlive the tree it kills; these are tried in order.
      launchers: ['wmic', 'schtasks', 'explorer', 'spawn-inside-tree'],
      running: busy.map((agent) => String(agent?.id ?? '?')),
      wouldFlush: (() => {
        const store = ctx.get('sessions')
        return store !== undefined && typeof store.list === 'function' ? store.list().length : 0
      })(),
    })
    return
  }

  const cancelled = busy.map((agent) => ({ id: String(agent?.id ?? '?'), outcome: cancelAgent(agent) }))
  const flush = await flushLiveSessions(ctx)

  reply(response, 202, {
    ok: true,
    restarting: true,
    mode: plan.mode,
    pid: facts.pid,
    delayMs: RESTART_DELAY_MS,
    cancelled,
    flushed: flush.flushed,
    flushFailed: flush.failed,
  })

  const launch = deps.launch ?? launchHelper
  const schedule = deps.schedule ?? ((delay, operation) => setTimeout(operation, delay))
  schedule(RESTART_DELAY_MS, () => {
    try {
      launch(plan)
    } catch (error) {
      console.error('[dsh-reload] restart helper could not start:', error)
    }
    if (plan.mode === 'cli') {
      // Nothing above the Host will reap it: leave by ourselves once the helper
      // holds its wait loop.
      const exit = deps.exit ?? ((code) => process.exit(code))
      setTimeout(() => exit(0), 400)
    }
  })
}

/**
 * Start the helper so that it survives the very tree kill it performs.
 *
 * The helper kills the application tree, and this Host is inside that tree — a
 * plain `spawn(..., { detached: true })` is still a CHILD of the Host, so
 * `taskkill /F /T` takes the helper down with everything else (measured: the
 * helper logged the kill and never reached `start`, which is exactly why the
 * application did not come back). These launchers create the helper outside the
 * tree and were verified on the live machine — each one kept running after the
 * tree that started it was killed:
 *
 * 1. `wmic process call create` — the parent becomes `wmiprvse.exe`, and the
 *    created process keeps the caller's environment and session (checked: the
 *    child sees the user's %LOCALAPPDATA% and runs in session 1, so the window
 *    appears on the desktop).
 * 2. `schtasks /create` + `/run` — the Task Scheduler service owns it.
 * 3. `explorer.exe <script>` — Explorer owns it.
 * 4. A detached child of this Host, the last resort: it does NOT survive a tree
 *    kill, so it is logged as such and only used when the three above are absent.
 * @param {{scriptPath: string, script: string, pid: number}} plan - the restart plan.
 * @returns {string} the launcher that was used.
 */
function launchHelper(plan) {
  mkdirSync(tmpdir(), { recursive: true })
  writeFileSync(plan.scriptPath, plan.script, 'utf8')
  const command = `cmd.exe /c call "${plan.scriptPath}"`
  const failures = []
  const trace = (method) => {
    try {
      appendFileSync(HELPER_LOG, `[${new Date().toLocaleString('ru-RU')}] host ${String(process.pid)} launching helper via ${method}\r\n`, 'utf8')
    } catch {
      /* the log is diagnostic only */
    }
    return method
  }
  const options = { windowsHide: true, timeout: 20000, encoding: 'utf8' }

  // 1) WMI: `ReturnValue = 0` is the success signal; a missing wmic throws ENOENT.
  try {
    const output = String(execFileSync('wmic', ['process', 'call', 'create', command], options))
    if (/ReturnValue\s*=\s*0/u.test(output)) return trace('wmic')
    failures.push(`wmic: ReturnValue is not 0 (${output.trim().slice(0, 120)})`)
  } catch (error) {
    failures.push(`wmic: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  // 2) Task Scheduler.
  const taskName = `dsh-reload-restart-${String(plan.pid)}`
  try {
    execFileSync('schtasks', ['/create', '/tn', taskName, '/tr', command, '/sc', 'once', '/st', '00:00', '/f'], options)
    execFileSync('schtasks', ['/run', '/tn', taskName], options)
    return trace('schtasks')
  } catch (error) {
    failures.push(`schtasks: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  // 3) Explorer.
  try {
    const child = spawnChild('explorer.exe', [plan.scriptPath], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return trace('explorer')
  } catch (error) {
    failures.push(`explorer: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  // 4) Last resort: dies with the tree, so the application will not come back.
  const child = spawnChild('cmd.exe', ['/c', plan.scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: tmpdir(),
  })
  child.unref()
  console.error('[dsh-reload] no out-of-tree launcher worked:', failures.join('; '))
  return trace('spawn-inside-tree')
}

/**
 * Answer one reload request.
 * @param {object} ctx - the plugin context.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @param {import('node:http').ServerResponse} response - the response to own.
 */
async function handleReload(ctx, request, response) {
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    reply(response, 405, { ok: false, error: 'POST only' })
    return
  }
  if (request.headers[HEADER] !== '1') {
    reply(response, 403, { ok: false, error: `missing ${HEADER}: 1 header` })
    return
  }

  const hmr = ctx.get('hmr')
  if (hmr === undefined || typeof hmr.reconcileProfile !== 'function') {
    reply(response, 200, { ok: false, reason: 'no-hmr', error: 'the Host has no hot-reload service, so only the page can be reloaded' })
    return
  }

  try {
    // `reconcileProfile` is a caller-owned mutation: it must be serialized with
    // every automatic reload path, or it throws instead of racing one.
    const value = await hmr.runExclusive(() => hmr.reconcileProfile())
    reply(response, 200, {
      ok: true,
      // Modules that still only load after a full Host restart.
      pending: Array.isArray(value?.pending) ? value.pending : [],
      warnings: Array.isArray(value?.warnings) ? value.warnings : [],
      restartReason: value?.restartReason ?? null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[dsh-reload] reconcile failed:', error)
    reply(response, 200, { ok: false, error: message })
  }
}

/**
 * Register the three routes on the browser HTTP carrier.
 *
 * `webServer` is a declared dependency ({@link inject}), so it is present here
 * even on a cold start; the guard stays as a defensive check.
 * @param {object} ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const server = ctx.webServer ?? ctx.get('webServer')
    if (server === undefined || typeof server.register !== 'function') {
      console.error('[dsh-reload] webServer is unavailable; reload and restart routes are not registered')
      return () => {}
    }
    const disposers = [
      server.register({
        kind: 'exact',
        path: ROUTE,
        handler: (request, response) => handleReload(ctx, request, response),
      }),
      server.register({
        kind: 'exact',
        path: RESTART_ROUTE,
        handler: (request, response) => handleRestart(ctx, request, response),
      }),
      server.register({
        kind: 'exact',
        path: STATUS_ROUTE,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            response.setHeader('allow', 'GET')
            reply(response, 405, { ok: false, error: 'GET only' })
            return
          }
          reply(response, 200, { ok: true, process: processFacts() })
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-reload: reload, restart and status routes')
}
