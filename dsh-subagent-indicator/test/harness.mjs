/**
 * Test-obvyazka for the client half of @local/dsh-subagent-indicator.
 *
 * No jsdom and no real React are installed on this host, so the harness is
 * deliberately small and explicit:
 *   - a minimal DOM (elements, dataset, a style-tag container, documentElement);
 *   - a minimal React (createElement + useRef/useState/useMemo/useEffect);
 *   - a window.__ModuleLoader__ shim that captures the bundle exactly the way
 *     the DSH web client does, so client.js runs unmodified;
 *   - a fake client context that records effects, dictionaries and slot seats.
 */
import fs from "node:fs";
import vm from "node:vm";

/** Minimal style declaration object. */
class FakeStyle {
  constructor() {
    this.props = Object.create(null);
  }
  setProperty(name, value) {
    this.props[name] = value;
  }
  getPropertyValue(name) {
    return this.props[name];
  }
}

/** Minimal element: dataset, style, children, removal. */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.dataset = Object.create(null);
    this.style = new FakeStyle();
    this.children = [];
    this.parent = null;
    this.textContent = "";
  }
  getAttribute(name) {
    if (typeof name !== "string") return null;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      return Object.prototype.hasOwnProperty.call(this.dataset, key) ? this.dataset[key] : null;
    }
    return null;
  }
  setAttribute(name, value) {
    if (typeof name === "string" && name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = String(value);
    }
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
}

/**
 * @returns document/window pair good enough for the plugin.
 */
export function createDom() {
  const head = new FakeElement("head");
  const documentElement = new FakeElement("html");
  const document = {
    head,
    documentElement,
    createElement: (tagName) => new FakeElement(tagName),
    querySelector(selector) {
      // Only the one attribute selector the plugin uses: tag[attr="value"].
      const match = /^([a-z0-9]+)\[([a-z0-9-]+)="(.*)"\]$/i.exec(selector);
      if (match === null) return null;
      const [, tagName, attribute, value] = match;
      const hit = head.children.find(
        (child) =>
          child.tagName === tagName.toUpperCase() && child.getAttribute(attribute) === value,
      );
      return hit === undefined ? null : hit;
    },
  };
  const storage = new Map();
  const window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    /** Filled in by loadClient(). */
    __ModuleLoader__: undefined,
  };
  return { document, window, head, documentElement, storage };
}

/**
 * Mini React: createElement plus the four hooks the bundle uses.
 * @returns render/unmount helpers over one fresh hook store.
 */
export function createMiniReact() {
  const store = { hooks: [], index: 0, effects: [], renders: 0 };

  const React = {
    createElement(type, props, ...children) {
      const next = { ...(props ?? {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return { type, props: next };
    },
    useRef(initial) {
      const index = store.index++;
      if (store.hooks[index] === undefined) store.hooks[index] = { kind: "ref", value: { current: initial } };
      return store.hooks[index].value;
    },
    useState(initial) {
      const index = store.index++;
      if (store.hooks[index] === undefined) {
        store.hooks[index] = { kind: "state", value: typeof initial === "function" ? initial() : initial };
      }
      const slot = store.hooks[index];
      const set = (value) => {
        slot.value = typeof value === "function" ? value(slot.value) : value;
      };
      return [slot.value, set];
    },
    useMemo(factory) {
      return factory();
    },
    useEffect(effect, deps) {
      const index = store.index++;
      const previous = store.hooks[index];
      const sameDeps =
        previous !== undefined &&
        Array.isArray(deps) &&
        Array.isArray(previous.deps) &&
        deps.length === previous.deps.length &&
        deps.every((item, position) => item === previous.deps[position]);
      if (sameDeps) return undefined;
      store.hooks[index] = { kind: "effect", deps, cleanup: previous?.cleanup };
      store.effects.push({ index, effect });
      return undefined;
    },
  };

  function render(component, props) {
    store.index = 0;
    store.effects = [];
    const output = component(props);
    store.renders += 1;
    for (const { index, effect } of store.effects) {
      const slot = store.hooks[index];
      if (slot !== undefined && typeof slot.cleanup === "function") slot.cleanup();
      const cleanup = effect();
      if (slot !== undefined) slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
    return output;
  }

  function unmount() {
    for (const slot of store.hooks) {
      if (slot !== undefined && typeof slot.cleanup === "function") slot.cleanup();
    }
    store.hooks = [];
  }

  return { React, render, unmount, store };
}

/**
 * Run client.js under a window.__ModuleLoader__ shim and build the bundle.
 * @param options.file - absolute path to client.js.
 * @param options.dom - the createDom() result.
 * @param options.miniReact - the createMiniReact() result (supplies "react").
 * @returns whatever the factory returned (inject, apply, __test).
 */
export function loadClient({ file, dom, miniReact }) {
  const registry = new Map();
  dom.window.__ModuleLoader__ = {
    load(definition) {
      registry.set(definition.id, definition);
    },
  };
  const sandbox = {
    window: dom.window,
    document: dom.document,
    console,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  const definition = registry.get("@local/dsh-subagent-indicator");
  if (definition === undefined) throw new Error("bundle never called window.__ModuleLoader__.load");
  const requireShim = (name) => {
    if (name === "react") return miniReact.React;
    throw new Error("unexpected require(" + name + ")");
  };
  return { module: definition.factory(requireShim), definition, registry };
}

/**
 * Fake client root context: records effects, dictionaries and slot seats.
 * @returns the context plus its recordings.
 */
export function createClientContext() {
  const recorded = { effects: [], locales: [], seats: [], injectedSlots: [] };
  const ctx = {
    effect(factory, label) {
      recorded.effects.push({ label, cleanup: factory() });
    },
    locale: {
      register(namespace, dictionaries) {
        recorded.locales.push({ namespace, dictionaries });
        return () => {};
      },
    },
    slots: {
      register(spec, component) {
        return { spec, component };
      },
      inject(name, generator) {
        recorded.injectedSlots.push(name);
        for (const seat of generator()) {
          seat.name = seat.spec?.name;
          recorded.seats.push(seat);
        }
      },
    },
  };
  return { ctx, recorded };
}

/** Build the Sessions selectors the header passes to a slot component. */
export function makeSessionsHooks({ sessionId, catalog }) {
  const state = {
    projectionsBySession: { [sessionId]: { state: "ready", values: { subagentCatalog: catalog } } },
    byId: {},
  };
  return {
    useSessions: (selector) => selector(state),
    useSessionStatus: (selector) => selector(new Map()),
    state,
  };
}

export { FakeElement };
