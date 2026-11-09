/**
 * Host-level harness: the real `apply()` on a mock Cordis context.
 *
 * It gives the plugin exactly the services it declares — `tools`, `systemPrompt`, `webServer`,
 * `agents` — and a throwaway `DSH_PROFILE_DIR`, so a tool call or an HTTP request exercises the
 * same code the desktop Host runs, not a copy of it. Routes get a fake request/response pair, which
 * is how the panel's own calls are asserted offline.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../../index.js'

export { apply, inject, name }

/** Lower-case every header key once, so route code reads `request.headers['if-match']`. */
function normalizeHeaders(headers = {}) {
  const result = {}
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return result
}

/**
 * A live agent record shaped like the Host's, recording what the plugin delivered.
 * @param {string} id - session id.
 * @returns {object} the fake agent.
 */
export function makeAgent(id) {
  return {
    id,
    sent: [],
    injected: [],
    followup(message) {
      this.sent.push({ mode: 'followup', message })
    },
    inject(message) {
      this.injected.push({ mode: 'inject', message })
    },
  }
}

/**
 * Apply the plugin to a fresh mock context.
 * @param {{withWebServer?: boolean}} [options] - whether the carrier exists.
 * @returns {object} the harness.
 */
export function createHost(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'canvas-host-'))
  process.env.DSH_PROFILE_DIR = join(root, 'profile')
  const tools = new Map()
  const routes = []
  const sections = []
  const agents = new Map()
  const resumable = new Set(options.resumable ?? [])
  const disposers = []

  const webServer =
    options.withWebServer === false
      ? undefined
      : {
          register(route) {
            routes.push(route)
            return () => {
              const index = routes.indexOf(route)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        }

  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    get(service) {
      if (service === 'webServer') return webServer
      if (service === 'agents') {
        return {
          get: (id) => agents.get(id),
          // A cold session can be resumed only when the test says so; anything else is NO_SESSION.
          async resume({ sessionId }) {
            if (!resumable.has(sessionId)) throw new Error(`session "${sessionId}" cannot be resumed`)
            if (agents.has(sessionId)) throw new Error(`session "${sessionId}" is already live`)
            const agent = makeAgent(sessionId)
            agents.set(sessionId, agent)
            return { agent }
          },
        }
      }
      if (service === 'workingDirectory') return { defaultDirectory: join(root, 'work') }
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    },
  }

  apply(ctx)

  /** Add a live agent the wake-up path can find. */
  function addAgent(id) {
    const agent = makeAgent(id)
    agents.set(id, agent)
    return agent
  }

  /**
   * Call one registered tool.
   * @param {string} toolName - the tool.
   * @param {object} args - its arguments.
   * @param {{agent?: object}} [exec] - execution context.
   * @returns {Promise<any>} the tool result.
   */
  async function callTool(toolName, args, exec = {}) {
    const definition = tools.get(toolName)
    if (definition === undefined) throw new Error(`tool "${toolName}" is not registered`)
    return definition.execute(args ?? {}, { agent: exec.agent, signal: undefined })
  }

  /**
   * Call one route with a fake request/response pair.
   * @param {string} url - the path.
   * @param {{method?: string, headers?: object, body?: object}} [request] - the request shape.
   * @returns {Promise<{status: number, headers: object, body: string, json: Function}>} the response.
   */
  async function request(url, request = {}) {
    const route = routes.find((entry) => entry.path === url)
    if (route === undefined) throw new Error(`no route for ${url}; registered: ${routes.map((entry) => entry.path).join(', ')}`)
    const method = request.method ?? 'GET'
    const payload = request.body === undefined ? undefined : JSON.stringify(request.body)
    const headers = normalizeHeaders({ ...(request.headers ?? {}) })
    if (payload !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json'

    const response = {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(status, extra = {}) {
        this.statusCode = status
        Object.assign(this.headers, normalizeHeaders(extra))
        return this
      },
      end(chunk) {
        if (chunk !== undefined) this.body += String(chunk)
      },
      on() {},
    }
    const fakeRequest = {
      method,
      url,
      headers,
      on(event, handler) {
        if (event === 'data' && payload !== undefined && typeof handler === 'function') handler(Buffer.from(payload))
        if (event === 'end' && typeof handler === 'function') queueMicrotask(() => handler())
        return this
      },
      once(event, handler) {
        return this.on(event, handler)
      },
    }
    await route.handler(fakeRequest, response)
    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.body,
      json() {
        return JSON.parse(this.body)
      },
    }
  }

  return {
    root,
    ctx,
    tools,
    routes,
    sections,
    agents,
    disposers,
    addAgent,
    callTool,
    request,
    /** Run every disposer, the way unloading the plugin does. */
    unload() {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

/**
 * Run a promise expected to fail with a contract code.
 * @param {Function} factory - the call.
 * @param {string} code - the expected prefix.
 * @returns {Promise<Error>} the caught error.
 */
export async function expectCode(factory, code) {
  try {
    await factory()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.startsWith(`${code}:`)) throw new Error(`expected ${code}, got: ${message}`)
    return error
  }
  throw new Error(`expected ${code}, but the call succeeded`)
}
