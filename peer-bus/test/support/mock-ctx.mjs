/**
 * Reusable Cordis-context mock for the Peer Bus plugin.
 *
 * Every test file runs in its own `node --test` process, and each `createHarness()` call applies
 * the plugin to a *fresh* context: plugin state lives inside `apply()`, so one harness can never
 * leak peers, labels or the master role into another one.
 *
 * What the mock provides (CONTRACT.md §6):
 * - `tools` — register + an `execute` wrapper that runs the Harness lossless-JSON check on every
 *   result (see `./json-safety.mjs`);
 * - `systemPrompt` — `context()` / `getContextOrder()` with the assembled board blocks;
 * - `agents` — `list()` / `get()` over a live-agent registry plus a factory (`addAgent`);
 * - `webServer` — `register()` interception and a fake req/res so routes can be called offline;
 * - `sessionController` / `workspaceController` — recording fakes;
 * - `workingDirectory`, `on` / `effect` / `get`, and an event emitter (`emit`).
 *
 * The durable state file is redirected into a per-harness temporary profile directory, so a test
 * run never reads or writes the real `~/.dsh/.peer-bus-state.json`.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../../index.js'
import { assertLosslessJson } from './json-safety.mjs'

/** Root of all temporary profile directories created by this process. */
const sandboxRoot = mkdtempSync(join(tmpdir(), 'peer-bus-test-'))
let harnessCounter = 0

/** The published plugin identity — asserted by `identity.test.mjs`. */
export { apply, inject, name }

/** The six-character handle the plugin uses in every model-facing text. */
export const short = (id) => String(id).slice(-6)

/** Deep-clone through JSON, so a test can keep a snapshot without aliasing plugin state. */
export const snapshot = (value) => JSON.parse(JSON.stringify(value))

/**
 * A live agent record shaped like the real Host's: `id`, `session.header` and the two delivery
 * methods. Messages land in `sent`, so a test asserts what the peer actually received.
 * @param {string} id - session id.
 * @param {string} cwd - session directory.
 * @param {{header?: object, status?: string}} [extra] - overrides.
 * @returns {object} the fake agent.
 */
export function makeAgent(id, cwd, extra = {}) {
  return {
    id,
    session: { header: { id, cwd, ...(extra.header ?? {}) } },
    status: extra.status ?? 'idle',
    /** Wake-ups: these run another turn of the agent. */
    sent: [],
    /** Quiet deliveries (`inject`): read on the next turn, never a wake-up. */
    injected: [],
    followup(message) {
      this.sent.push({ mode: 'followup', message })
    },
    steer(message) {
      this.sent.push({ mode: 'steer', message })
    },
    inject(message) {
      this.injected.push({ mode: 'inject', message })
    },
  }
}

/**
 * A recording `sessionController` fake. `create` hands out deterministic ids; `prompt` records the
 * body that would be queued into a cold session.
 * @param {{createIds?: string[], listItems?: object[], createError?: Error}} [options] - overrides.
 * @returns {object} the fake controller, with `calls` arrays for assertions.
 */
export function fakeSessionController(options = {}) {
  const calls = { create: [], rename: [], prompt: [], list: [], resume: [], inspect: [] }
  const createIds = [...(options.createIds ?? [])]
  let created = 0
  const controller = {
    calls,
    async create(request) {
      calls.create.push(request)
      created += 1
      if (options.createError) throw options.createError
      const sessionId = createIds.shift() ?? `session-created${String(created).padStart(4, '0')}`
      return { sessionId }
    },
    async rename(request) {
      calls.rename.push(request)
      return { title: request.title, seq: calls.rename.length }
    },
    async prompt(request) {
      calls.prompt.push(request)
      return { accepted: true }
    },
    async list(query, signal) {
      calls.list.push({ query, signal })
      return { items: options.listItems ?? [] }
    },
  }
  return controller
}

/**
 * A recording `workspaceController` fake for archive/restore and sidebar pins.
 * @param {{archiveError?: Error}} [options] - overrides.
 * @returns {object} the fake controller, with `calls` arrays for assertions.
 */
export function fakeWorkspaceController(options = {}) {
  const calls = { archive: [], unarchive: [], pin: [], unpin: [] }
  return {
    calls,
    async archiveSession(request) {
      calls.archive.push(request)
      if (options.archiveError) throw options.archiveError
      return { archivedSessionIds: [request.sessionId] }
    },
    async unarchiveSession(request) {
      calls.unarchive.push(request)
      return { archivedSessionIds: [request.sessionId] }
    },
    async pinSession(request) {
      calls.pin.push(request)
      return { pinnedSessionIds: [request.sessionId] }
    },
    async unpinSession(request) {
      calls.unpin.push(request)
      return { unpinnedSessionIds: [request.sessionId] }
    },
  }
}

/** Lower-case every header key once, so route code can read `request.headers['content-type']`. */
function normalizeHeaders(headers = {}) {
  /** @type {Record<string, string>} */
  const result = {}
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return result
}

/**
 * Apply the plugin to a fresh mock context.
 * @param {{defaultDirectory?: string, webServer?: boolean, profileDir?: string}} [options] - harness options.
 *   `profileDir` reuses a profile directory (to simulate a Host restart reading the state file).
 * @returns {object} harness: context, captured tools/routes/context blocks, agent factory and helpers.
 */
export function createHarness(options = {}) {
  harnessCounter += 1
  const profileDir = options.profileDir ?? join(sandboxRoot, `h${harnessCounter}`, 'profile')
  mkdirSync(profileDir, { recursive: true })

  /** @type {Map<string, object>} tool name → definition (execute already wrapped). */
  const tools = new Map()
  /** @type {Map<string, Function[]>} event name → handlers. */
  const listeners = new Map()
  /** @type {object[]} every registered systemPrompt context block. */
  const contexts = []
  /** @type {Map<string, object>} live agent id → agent. */
  const liveAgents = new Map()
  /** @type {object[]} every route a webServer service was asked to register. */
  const routes = []
  /** @type {Record<string, any>} services returned by `ctx.get()`. */
  const services = {
    workingDirectory: { defaultDirectory: options.defaultDirectory ?? 'C:\\project' },
  }

  if (options.webServer !== false) {
    services.webServer = {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    }
  }

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get(serviceName) {
      return services[serviceName]
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {
        const bucket = listeners.get(event) ?? []
        const index = bucket.indexOf(handler)
        if (index >= 0) bucket.splice(index, 1)
      }
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    agents: {
      list: () => [...liveAgents.values()],
      get: (id) => liveAgents.get(id),
    },
    systemPrompt: {
      getContextOrder: (section) => (section === 'TEAM_IDENTITY' ? 125 : 100),
      context(entry) {
        contexts.push(entry)
        return () => {
          const index = contexts.indexOf(entry)
          if (index >= 0) contexts.splice(index, 1)
        }
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }

  // Point persistence at the isolated profile before `apply()` reads or writes the state file.
  pinProfile()
  apply(ctx)

  /**
   * Point persistence at this harness before letting the plugin act.
   *
   * The env var is deliberately NOT restored afterwards. The plugin resolves its state file inside
   * every `saveState()`, and a Host event (`agent/created`, `agent/disposed`, a heartbeat) fires
   * outside any tool call, so restoring the caller's profile between calls let a test write harness
   * state into the real `~/.dsh/profiles/<profile>/.peer-bus-state.json`. That happened on
   * 31.10.2026: a `node --test` run started from a DSH session inherits `DSH_PROFILE_DIR`, and the
   * live board then showed mock sessions. Each harness therefore pins its own temporary directory,
   * and every entry point that can reach `saveState()` pins again.
   */
  function pinProfile() {
    process.env.DSH_PROFILE_DIR = profileDir
  }

  // Every tool result is checked the way the Harness checks it: lossless JSON, at any depth.
  for (const definition of tools.values()) {
    const execute = definition.execute
    if (typeof execute !== 'function') continue
    definition.execute = async (...callArgs) => {
      pinProfile()
      const result = await execute(...callArgs)
      return assertLosslessJson(result, `tool ${definition.name}`)
    }
  }

  /** Fire one Host event the way Cordis would. */
  const emit = (event, ...payload) => {
    pinProfile()
    for (const handler of listeners.get(event) ?? []) handler(...payload)
  }

  /** Register a live agent and announce it like the Host does on `agent/created`. */
  function addAgent(id, cwd, extra = {}) {
    pinProfile()
    const agent = makeAgent(id, cwd, extra)
    liveAgents.set(id, agent)
    emit('agent/created', { agent })
    return agent
  }

  /** Mark an agent disposed: it leaves `agents.get()` and the plugin sees `agent/disposed`. */
  function disposeAgent(agentOrId) {
    pinProfile()
    const agent = typeof agentOrId === 'string' ? liveAgents.get(agentOrId) : agentOrId
    if (agent === undefined) return undefined
    emit('agent/disposed', { agent })
    liveAgents.delete(agent.id)
    return agent
  }

  /** The `exec` object a tool receives from the Harness. */
  const execFor = (agent, extra = {}) => ({ agent, signal: extra.signal })

  /**
   * Call one registered tool, asserting existence and lossless JSON.
   * @param {string} toolName - registered tool name.
   * @param {object} args - tool arguments.
   * @param {object} agent - the calling agent.
   * @param {{signal?: AbortSignal}} [extra] - execution overrides.
   * @returns {Promise<any>} the tool result.
   */
  async function callTool(toolName, args, agent, extra = {}) {
    const definition = tools.get(toolName)
    if (definition === undefined) {
      throw new Error(`tool "${toolName}" is not registered; registered tools: ${[...tools.keys()].join(', ')}`)
    }
    return definition.execute(args ?? {}, execFor(agent, extra))
  }

  /** Assert a tool is registered (a guard, not a skip: a missing tool is a contract break). */
  function requireTool(toolName) {
    if (!tools.has(toolName)) {
      throw new Error(`CONTRACT: tool "${toolName}" must be registered; registered: ${[...tools.keys()].join(', ')}`)
    }
    return tools.get(toolName)
  }

  /** Assert a contract error: `Error` whose message starts with the documented `<CODE>:` prefix. */
  async function expectError(promiseFactory, code) {
    try {
      const value = await promiseFactory()
      throw new Error(`CONTRACT: expected ${code}, but the call succeeded: ${JSON.stringify(value).slice(0, 300)}`)
    } catch (error) {
      if (error instanceof Error && /^CONTRACT: expected/.test(error.message)) throw error
      const message = error instanceof Error ? error.message : String(error)
      const expected = new RegExp(`^${code}:`)
      if (!expected.test(message) && !message.includes(code)) {
        throw new Error(`CONTRACT: expected error ${code}, got: ${message}`)
      }
      return error
    }
  }

  /** The systemPrompt block with the given name, failing loudly when it is absent. */
  function contextBlock(blockName = 'peer-bus:board') {
    const block = contexts.find((entry) => entry.name === blockName)
    if (block === undefined) {
      throw new Error(`CONTRACT: context block "${blockName}" is not registered; got: ${contexts.map((entry) => entry.name).join(', ')}`)
    }
    return block
  }

  /** The assembled board text for one agent. */
  function boardFor(agent) {
    const block = contextBlock()
    return typeof block.text === 'function' ? block.text({ agent }) : String(block.text ?? '')
  }

  /** Find the registered route serving a URL (exact match, then prefix match). */
  function routeFor(url) {
    const exact = routes.find((route) => route.path === url)
    if (exact !== undefined) return exact
    const prefix = routes.find((route) => route.path !== undefined && url.startsWith(route.path))
    if (prefix !== undefined) return prefix
    throw new Error(`no web route registered for ${url}; registered: ${routes.map((route) => route.path).join(', ')}`)
  }

  /**
   * Call a registered web route with a fake request/response pair.
   * @param {string} url - request path.
   * @param {{method?: string, headers?: object, body?: string|object}} [requestOptions] - request shape.
   * @returns {Promise<{status: number, headers: Record<string, string>, body: string, json: () => any}>} the response.
   */
  async function request(url, requestOptions = {}) {
    pinProfile()
    const route = routeFor(url)
    const method = requestOptions.method ?? 'GET'
    const payload =
      requestOptions.body === undefined
        ? undefined
        : typeof requestOptions.body === 'string'
          ? requestOptions.body
          : JSON.stringify(requestOptions.body)
    const headers = normalizeHeaders(requestOptions.headers)
    if (payload !== undefined && headers['content-type'] === undefined && typeof requestOptions.body !== 'string') {
      headers['content-type'] = 'application/json'
    }
    if (headers['sec-fetch-site'] === undefined && requestOptions.secFetchSite !== undefined) {
      headers['sec-fetch-site'] = requestOptions.secFetchSite
    }

    const response = {
      statusCode: 200,
      headers: /** @type {Record<string, string>} */ ({}),
      body: '',
      writeHead(status, extraHeaders = {}) {
        this.statusCode = status
        Object.assign(this.headers, normalizeHeaders(extraHeaders))
        return this
      },
      setHeader(key, value) {
        this.headers[String(key).toLowerCase()] = String(value)
      },
      getHeader(key) {
        return this.headers[String(key).toLowerCase()]
      },
      removeHeader(key) {
        delete this.headers[String(key).toLowerCase()]
      },
      write(chunk) {
        this.body += String(chunk)
      },
      end(chunk) {
        if (chunk !== undefined) this.body += String(chunk)
      },
      on() {},
      once() {},
      emit() {},
    }

    const fakeRequest = {
      method,
      url,
      headers,
      httpVersion: '1.1',
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        if (payload !== undefined) yield Buffer.from(payload)
      },
      on(event, handler) {
        if (event === 'data' && payload !== undefined && typeof handler === 'function') handler(Buffer.from(payload))
        if (event === 'end' && typeof handler === 'function') queueMicrotask(() => handler())
        return this
      },
      once(event, handler) {
        return this.on(event, handler)
      },
      setEncoding() {},
    }

    try {
      const returned = route.handler(fakeRequest, response)
      if (returned !== undefined && typeof returned.then === 'function') await returned
    } catch (error) {
      return {
        status: 500,
        headers: response.headers,
        body: error instanceof Error ? error.message : String(error),
        json() {
          return JSON.parse(this.body)
        },
      }
    }

    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.body,
      json() {
        return JSON.parse(this.body)
      },
    }
  }

  /**
   * Read the board the way the browser half does: `GET /peer-bus/board`.
   * @returns {Promise<any>} the parsed board JSON.
   */
  async function board() {
    const response = await request('/peer-bus/board', { method: 'GET' })
    if (response.status !== 200) {
      throw new Error(`GET /peer-bus/board returned ${response.status}: ${response.body}`)
    }
    try {
      return response.json()
    } catch (error) {
      throw new Error(`GET /peer-bus/board did not return JSON: ${response.body.slice(0, 300)} (${error.message})`)
    }
  }

  return {
    ctx,
    name,
    inject,
    tools,
    contexts,
    listeners,
    liveAgents,
    routes,
    services,
    profileDir,
    emit,
    addAgent,
    disposeAgent,
    makeAgent,
    execFor,
    callTool,
    requireTool,
    expectError,
    contextBlock,
    boardFor,
    board,
    routeFor,
    request,
    /** Let pending `void loadState()` / `void saveState()` microtasks and timers settle. */
    async settle(ms = 20) {
      pinProfile()
      await new Promise((resolve) => setTimeout(resolve, ms))
    },
    /** Point persistence at this harness; called by every entry point that can reach `saveState`. */
    pinProfile,
    toolNames() {
      return [...tools.keys()]
    },
  }
}
