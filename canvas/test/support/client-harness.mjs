/**
 * Offline harness for the browser half (`client.js`).
 *
 * The bundle is a `window.__ModuleLoader__` module: it asks for `react`, calls the Host routes over
 * `fetch`, and draws through the slot registry. This harness provides exactly that — a small
 * hook-aware React, a fake document/window, fake timers the test advances by hand, a scripted Host,
 * and a recording slot registry — so a test renders the real panel and asserts what a person sees.
 *
 * Fake timers matter for two guards: the typewriter (test 20) advances time deterministically, and
 * the lifecycle guard (test 24) asserts that unmounting the tab leaves no scheduled callback.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const bundleSource = readFileSync(join(root, 'client.js'), 'utf8')

/** Distinguishes module instances without touching the file on disk. */
let importCounter = 0

/** The real timers, captured before the fake ones are installed. */
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

/** Flatten `createElement` children: arrays in, `null`/`false` dropped. */
function flattenChildren(list, out = []) {
  for (const item of list) {
    if (item === null || item === undefined || item === false || item === true) continue
    if (Array.isArray(item)) flattenChildren(item, out)
    else out.push(item)
  }
  return out
}

/**
 * The smallest React the panel needs: element factory plus hooks, keyed by component and the id of
 * the entity it renders, so several `Block` instances do not share one hook table.
 * @returns {{React: object, render: Function, setRerender: Function}} the fake React.
 */
function createFakeReact() {
  const instances = new Map()
  let current = null
  let rerender = () => {}

  function useSlot() {
    if (current === null) throw new Error('hook called outside a render')
    const index = current.index
    current.index += 1
    if (current.hooks.length <= index) current.hooks.push({})
    return current.hooks[index]
  }

  function instanceFor(type, props) {
    const id = props?.block?.id ?? props?.comment?.id ?? props?.['data-block-id'] ?? ''
    const key = `${type.name || 'anonymous'}:${id}`
    let state = instances.get(key)
    if (state === undefined) {
      state = { hooks: [], index: 0 }
      instances.set(key, state)
    }
    return state
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: flattenChildren(children) } }
    },
    Fragment: 'Fragment',
    useState(initial) {
      const slot = useSlot()
      if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
          rerender()
        },
      ]
    },
    useRef(initial) {
      const slot = useSlot()
      if (!('ref' in slot)) slot.ref = { current: initial }
      return slot.ref
    },
    useEffect(effect) {
      const slot = useSlot()
      if (slot.ran === true) return undefined
      slot.ran = true
      slot.cleanup = effect()
      return slot.cleanup
    },
    useMemo(factory) {
      const slot = useSlot()
      if (!('value' in slot)) slot.value = factory()
      return slot.value
    },
    useCallback(callback) {
      return callback
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const slot = useSlot()
      if (slot.subscribed !== true) {
        slot.subscribed = true
        slot.unsubscribe = subscribe(() => rerender())
      }
      return getSnapshot()
    },
  }

  /** Render one element tree. Host elements keep their props (including `dangerouslySetInnerHTML`). */
  function render(element) {
    if (element === null || element === undefined || element === false || element === true) return null
    if (typeof element === 'string' || typeof element === 'number') {
      return { type: '#text', props: { text: String(element) }, children: [] }
    }
    if (Array.isArray(element)) return element.map((item) => render(item)).filter((item) => item !== null)
    const { type, props } = element
    if (typeof type === 'function') {
      const previous = current
      const instance = instanceFor(type, props)
      instance.index = 0
      current = instance
      try {
        return render(type(props ?? {}))
      } finally {
        current = previous
      }
    }
    const children = flattenChildren(props?.children ?? []).map((child) => render(child))
    return { type, props: { ...props, children: undefined }, children: children.filter((item) => item !== null) }
  }

  return {
    React,
    render,
    setRerender(fn) {
      rerender = fn
    },
    cleanups() {
      const list = []
      for (const state of instances.values()) for (const hook of state.hooks) if (typeof hook.cleanup === 'function') list.push(hook.cleanup)
      return list
    },
  }
}

/**
 * Load the browser half into a fake page.
 * @param {{document?: object, pending?: object|null, now?: number}} [options] - the initial Host document.
 * @returns {Promise<object>} the harness.
 */
export async function createClientHarness(options = {}) {
  importCounter += 1
  /** The Host state the fake routes answer from. */
  const host = {
    version: 1,
    document:
      options.document ?? {
        schema: 1,
        id: 'doc-1',
        scope: 'global',
        sessionId: null,
        title: 'Документ',
        version: 1,
        nextBlockSeq: 2,
        nextCommentSeq: 1,
        blocks: [{ id: 'b-1', type: 'p', spans: [{ t: 'Первый абзац' }] }],
        comments: [],
        style: { tone: 'нейтральный', person: 'вы', avgSentence: 0, flags: [] },
        updatedAt: '2026-11-06T13:20:00+03:00',
      },
    pending: options.pending ?? null,
    requests: [],
  }
  const timers = new Map()
  let clock = options.now ?? Date.parse('2026-11-06T13:20:00+03:00')
  let nextTimer = 1
  const listeners = new Map()
  const intervalCount = () => [...timers.values()].filter((timer) => timer.repeat === true).length

  const setTimeoutFake = (fn, delay = 0) => {
    const id = nextTimer
    nextTimer += 1
    timers.set(id, { at: clock + Math.max(0, Number(delay) || 0), fn, repeat: null })
    return id
  }
  const setIntervalFake = (fn, delay = 0) => {
    const id = nextTimer
    nextTimer += 1
    timers.set(id, { at: clock + Math.max(1, Number(delay) || 0), fn, repeat: Math.max(1, Number(delay) || 0) })
    return id
  }
  const clearFake = (id) => {
    timers.delete(id)
  }

  globalThis.setTimeout = setTimeoutFake
  globalThis.setInterval = setIntervalFake
  globalThis.clearTimeout = clearFake
  globalThis.clearInterval = clearFake

  const fakeDocument = {
    visibilityState: 'visible',
    createElement() {
      return { dataset: {}, textContent: '', remove() {}, style: {} }
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
    },
    removeEventListener(event, handler) {
      listeners.get(event)?.delete(handler)
    },
    querySelector() {
      return null
    },
  }
  globalThis.document = fakeDocument
  globalThis.window = {
    document: fakeDocument,
    getSelection: () => null,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    __ModuleLoader__: {
      load(loaded) {
        harnessDefinition = loaded
      },
    },
    setTimeout: setTimeoutFake,
    clearTimeout: clearFake,
  }
  let harnessDefinition = null

  /** A JSON response shaped like `fetch` returns. */
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(JSON.stringify(body))
    },
  })

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    host.requests.push({ url, method, headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    if (url === '/canvas/doc' && method === 'GET') {
      return json(200, { version: host.version, document: host.document, readOnly: false, newerSchema: false })
    }
    if (url === '/canvas/doc' && method === 'PUT') {
      const body = JSON.parse(init.body)
      host.document.blocks = host.document.blocks.map((block) => (block.id === body.blockId ? { ...block, spans: body.spans } : block))
      host.version += 1
      host.document.version = host.version
      return json(200, { version: host.version, comments: [] })
    }
    if (url === '/canvas/comment') {
      const body = JSON.parse(init.body)
      if (body.action === 'add') {
        host.document.comments.push({
          id: `c-${host.document.comments.length + 1}`,
          blockId: body.blockId,
          from: body.from,
          to: body.to,
          occurrence: 0,
          quote: 'Первый',
          note: body.note,
          status: 'open',
          reason: null,
          createdAt: '2026-11-06T13:21:00+03:00',
        })
      }
      host.version += 1
      return json(200, { version: host.version })
    }
    if (url === '/canvas/apply/pending') {
      return host.pending === null ? json(204, null) : json(200, host.pending)
    }
    if (url === '/canvas/apply/prepare') return json(200, { batchId: 'batch-1', count: 1 })
    if (url === '/canvas/apply/commit') return json(200, { version: host.version + 1, applied: 1, conflicts: [], batchId: 'batch-1' })
    if (url === '/canvas/apply/discard') return json(200, { restored: true })
    if (url === '/canvas/export') return json(200, { path: 'products/холст.html' })
    if (url === '/canvas/doc/new') return json(200, { version: 1, document: host.document })
    return json(404, { code: 'UNKNOWN', hint: url })
  }

  const consoleWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  try {
    // Evaluate the bundle's source in this process so no module cache is involved.
    const moduleShim = { exports: {} }
    const factory = new Function('window', 'document', 'module', 'exports', bundleSource)
    factory(globalThis.window, fakeDocument, moduleShim, moduleShim.exports)
  } finally {
    console.warn = consoleWarn
  }
  if (harnessDefinition === null || typeof harnessDefinition.factory !== 'function') {
    throw new Error('client.js did not register itself with window.__ModuleLoader__')
  }

  const fake = createFakeReact()
  /** @type {Map<string, Function>} `slot:key` → component. */
  const registered = new Map()
  /** Right-dock tab types the bundle registered. */
  const tabDefinitions = []
  const register = (spec, component) => {
    const key = `${spec.name}:${spec.key ?? spec.id ?? ''}`
    registered.set(key, component)
    return () => registered.delete(key)
  }

  const plugin = harnessDefinition.factory((name) => {
    if (name === 'react') return fake.React
    throw new Error(`client.js required an unexpected module: ${name}`)
  })

  const slots = {
    inject(_name, callback) {
      callback()
      return () => {}
    },
    register,
  }
  const scope = {
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: { bind: () => (key) => key },
    slots,
    sidebarRightTabs: {
      register(definition) {
        tabDefinitions.push(definition)
        return () => {
          const index = tabDefinitions.indexOf(definition)
          if (index >= 0) tabDefinitions.splice(index, 1)
        }
      },
    },
    sidebarRight: { openTab() {} },
  }
  const ctx = {
    effect: scope.effect,
    get: () => undefined,
    locale: { register: () => () => {} },
    slots,
    inject: (_names, callback) => callback(scope),
  }

  /** Props every session-scoped slot receives. */
  const rootProps = {
    t: (key) => key,
    sessionId: 'session-1',
    inputActions: undefined,
  }
  let tree = null

  /** Render (or re-render) the panel. */
  function renderPanel(props = {}) {
    Object.assign(rootProps, props)
    const component = registered.get('sidebar.right.pane.tab:@local/dsh-canvas/panel')
    if (component === undefined) throw new Error('the canvas tab was not registered on the right dock')
    tree = fake.render(fake.React.createElement(component, rootProps))
    return tree
  }

  fake.setRerender(() => {
    if (tree !== null) renderPanel()
  })

  plugin.apply(ctx)
  await settleMicrotasks()

  /**
   * Run pending fake timers up to `milliseconds` ahead.
   * @param {number} milliseconds - how far to advance the clock.
   */
  async function advance(milliseconds) {
    const target = clock + milliseconds
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (due === undefined) break
      const [id, timer] = due
      clock = Math.max(clock, timer.at)
      if (timer.repeat === null) timers.delete(id)
      else timer.at = clock + timer.repeat
      try {
        timer.fn()
      } catch (error) {
        warnings.push(`timer failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await settleMicrotasks()
    }
    clock = target
    await settleMicrotasks()
  }

  /** Let promise callbacks run without touching real time. */
  async function settleMicrotasks() {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
    await new Promise((resolve) => realSetTimeout(resolve, 0))
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
  }

  /** Publish a newer document, the way the Host does while the agent writes. */
  function publish(document) {
    host.version += 1
    document.version = host.version
    host.document = document
  }

  return {
    plugin,
    ctx,
    scope,
    host,
    fake,
    warnings,
    registered,
    tabDefinitions,
    renderPanel,
    publish,
    advance,
    /** Timers still scheduled — the lifecycle guard asserts this reaches zero. */
    timerCount: () => timers.size,
    intervalCount,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    /** Fire a DOM event the way the browser does. */
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    /** Run every effect cleanup, the way unmounting the panel does. */
    unmount() {
      for (const cleanup of fake.cleanups()) {
        try {
          cleanup()
        } catch (error) {
          warnings.push(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
    /** Restore the real timers once the test is done with fake time. */
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
    get tree() {
      return tree
    },
    internals: plugin.__internal,
  }
}

/* ------------------------------------------------------------------ tree helpers */

/** Every rendered node under `tree`, depth first. */
export function walk(tree, out = []) {
  if (tree === null || tree === undefined) return out
  if (Array.isArray(tree)) {
    for (const item of tree) walk(item, out)
    return out
  }
  out.push(tree)
  for (const child of tree.children ?? []) walk(child, out)
  return out
}

/** Whether one node carries the class as a whole token. */
export function hasClass(node, className) {
  const value = node?.props?.className
  return typeof value === 'string' && value.split(/\s+/).includes(className)
}

/** The first node carrying the class. */
export function byClass(tree, className) {
  return walk(tree).find((node) => hasClass(node, className)) ?? null
}

/** Every node carrying the class. */
export function allByClass(tree, className) {
  return walk(tree).filter((node) => hasClass(node, className))
}

/** All visible text, including `dangerouslySetInnerHTML`, with tags stripped. */
export function textOf(tree) {
  const parts = []
  for (const node of walk(tree)) {
    if (node.type === '#text') parts.push(node.props.text)
    const html = node.props?.dangerouslySetInnerHTML?.__html
    if (typeof html === 'string') parts.push(html.replace(/<[^>]+>/g, ''))
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** The text of the first node carrying the class, or `''`. */
export function classText(tree, className) {
  const node = byClass(tree, className)
  return node === null ? '' : textOf(node)
}

/** Read one prop of a node. */
export function propOf(node, name) {
  return node === null || node === undefined ? undefined : node.props?.[name]
}
