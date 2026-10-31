/**
 * Offline harness for the browser half (`client.js`).
 *
 * The bundle is a `window.__ModuleLoader__` module with no DOM dependency of its own: it asks for
 * `react`, reads the board over `window.fetch`, and draws through the slot registry. This harness
 * gives it exactly that much — a tiny hook-aware React, a fake localStorage, a scripted fetch and
 * a recording slot registry — so a test can render the real right-dock board and assert what a
 * person would see, instead of grepping the source for a string.
 *
 * Every call imports `client.js` under a fresh cache-busting URL, so one test file can check
 * "nothing stored" and "already stored" without leaking module state between cases.
 *
 * Scope: the board tab is the surface under test. Other components are rendered only as children
 * of it, so the per-component hook table is keyed by component function and a component must not
 * need two independent hook instances in one tree (the board tab is rendered once).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** Distinguishes module instances without touching the file on disk. */
let importCounter = 0

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
 * The smallest React the client bundle needs: element factory plus hooks. A state change
 * re-renders the whole root, which is what `useSyncExternalStore` and `useState` rely on.
 * @returns {{React: object, render: Function, setRerender: Function}} the fake React and its renderer.
 */
function createFakeReact() {
  /** @type {Map<Function, {hooks: object[], index: number}>} component → its hook slots. */
  const instances = new Map()
  let current = null
  let rerender = () => {}

  /** The hook slot at the current position of the component being rendered. */
  function useSlot() {
    if (current === null) throw new Error('hook called outside a render')
    const index = current.index
    current.index += 1
    if (current.hooks.length <= index) current.hooks.push({})
    return current.hooks[index]
  }

  function instanceFor(type) {
    let state = instances.get(type)
    if (state === undefined) {
      state = { hooks: [], index: 0 }
      instances.set(type, state)
    }
    return state
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: flattenChildren(children) } }
    },
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
    useReducer(reducer, initial) {
      const slot = useSlot()
      if (!('value' in slot)) slot.value = initial
      return [
        slot.value,
        (action) => {
          slot.value = reducer(slot.value, action)
          rerender()
        },
      ]
    },
    useEffect(effect) {
      const slot = useSlot()
      if (slot.ran === true) return undefined
      slot.ran = true
      slot.cleanup = effect()
      return slot.cleanup
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const slot = useSlot()
      if (slot.subscribed !== true) {
        slot.subscribed = true
        slot.unsubscribe = subscribe(() => rerender())
      }
      return getSnapshot()
    },
    useRef(initial) {
      const slot = useSlot()
      if (!('ref' in slot)) slot.ref = { current: initial }
      return slot.ref
    },
    useMemo(factory) {
      const slot = useSlot()
      if (!('value' in slot)) slot.value = factory()
      return slot.value
    },
    useCallback(callback) {
      return callback
    },
  }

  /** Render one element tree. Host elements become `{ type, props, children }`; text is `#text`. */
  function render(element) {
    if (element === null || element === undefined || element === false || element === true) return null
    if (typeof element === 'string' || typeof element === 'number') {
      return { type: '#text', props: { text: String(element) }, children: [] }
    }
    if (Array.isArray(element)) {
      return element.map((item) => render(item)).filter((item) => item !== null)
    }
    const { type, props } = element
    if (typeof type === 'function') {
      const previous = current
      const instance = instanceFor(type)
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
  }
}

/** A localStorage stand-in over a Map; missing keys return `null` like the real one. */
function createStorage(seed = {}) {
  const values = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]))
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => {
      values.set(key, String(value))
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
}

/**
 * Load the browser half into a fake page and apply it, so the board tab is registered and the
 * board has been read once.
 * @param {{board?: object, storage?: Record<string, string>}} [options] - the board the fake Host
 *   answers with, and the keys the fake localStorage starts with.
 * @returns {Promise<object>} the harness: `renderBoard()`, the tree helpers, `storage`, `apply`.
 */
export async function createClientHarness(options = {}) {
  importCounter += 1
  const storage = createStorage(options.storage)
  /** Board payload the fake route answers with; a test can replace it. */
  let boardPayload = options.board ?? { version: 2, nodes: [], claims: [], threads: [], projects: [] }
  const warnings = []

  /** @type {{factory: Function} | null} */
  let definition = null

  globalThis.localStorage = storage
  globalThis.document = {
    visibilityState: 'visible',
    createElement() {
      const tag = {
        dataset: {},
        textContent: '',
        remove() {},
      }
      return tag
    },
    head: {
      appendChild() {},
    },
  }
  globalThis.window = {
    localStorage: storage,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse(JSON.stringify(boardPayload)),
    }),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: {
      load(loaded) {
        definition = loaded
      },
    },
  }

  const consoleWarn = console.warn
  console.warn = (...args) => {
    warnings.push(args.map((value) => String(value)).join(' '))
  }
  try {
    await import(`../../client.js?harness=${importCounter}`)
  } finally {
    console.warn = consoleWarn
  }
  if (definition === null || typeof definition.factory !== 'function') {
    throw new Error('client.js did not register itself with window.__ModuleLoader__')
  }

  const fake = createFakeReact()
  /** @type {Map<string, Function>} `slot:name` (or `slot:name:key`) → component. */
  const registered = new Map()
  const register = (spec, component) => {
    registered.set(`${spec.name}:${spec.key ?? spec.id ?? ''}`, component)
    return () => registered.delete(`${spec.name}:${spec.key ?? spec.id ?? ''}`)
  }

  const plugin = definition.factory((name) => {
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
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab() {} },
  }
  const ctx = {
    effect: scope.effect,
    get: () => undefined,
    locale: { register: () => () => {} },
    slots,
    inject: (_names, callback) => callback(scope),
  }

  const rootProps = { t: (key) => key }
  let tree = null

  /** Render (or re-render) the board tab and return its tree. */
  function renderBoard(props = {}) {
    Object.assign(rootProps, props)
    const component = registered.get('sidebar.right.pane.tab:@local/dsh-peer-bus/board')
    if (component === undefined) throw new Error('the board tab was not registered on the right dock')
    tree = fake.render(fake.React.createElement(component, rootProps))
    return tree
  }

  fake.setRerender(() => {
    if (tree !== null) renderBoard()
  })

  plugin.apply(ctx)
  // Let the first board read settle before the first render.
  await new Promise((resolve) => setTimeout(resolve, 25))

  /** Replace the board the fake route answers with, then read it again like the poll would. */
  async function publishBoard(next) {
    boardPayload = next
    await new Promise((resolve) => setTimeout(resolve, 25))
    return renderBoard()
  }

  return {
    plugin,
    ctx,
    scope,
    storage,
    warnings,
    registered,
    renderBoard,
    publishBoard,
    rerender: () => renderBoard(),
    get tree() {
      return tree
    },
  }
}

/* ------------------------------------------------------------------ tree helpers */

/** Every rendered node under `tree`, depth first, including text nodes. */
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

/** Whether one rendered node carries the CSS class as a whole token. */
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

/** All text of a subtree, joined with single spaces. */
export function textOf(tree) {
  return walk(tree)
    .filter((node) => node.type === '#text')
    .map((node) => node.props.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The text of the first node carrying the class, or `''`. */
export function classText(tree, className) {
  const node = byClass(tree, className)
  return node === null ? '' : textOf(node)
}

/** Read one attribute of a node (the React prop name, e.g. `checked`, `data-hidden`, `title`). */
export function propOf(node, name) {
  return node === null ? undefined : node?.props?.[name]
}
