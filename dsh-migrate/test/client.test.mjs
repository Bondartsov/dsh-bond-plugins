/**
 * Client smoke test: the browser half really renders.
 *
 * The bundle is executed the way the web shell executes it — `window.__ModuleLoader__.load`
 * captures the factory, the factory asks for `react`, `apply(ctx)` registers slots — and
 * then the registered page is rendered with a minimal hooks runtime against stub
 * route answers. It pins the merged contract: one page with two tabs, the tab
 * choice persisted in localStorage, a Refresh that really re-requests the tree
 * and moves the «Обновлено» stamp, cascading checkboxes, and the owner-requested
 * ≥16 px chevron in a ≥24×24 target on both tabs.
 *
 * It does not try to test real layout; CSS rules are asserted as text.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const RU_STAMP = /Обновлено: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}/u;

/** One project with two sessions; the second one is already imported. */
function sessionsTree(projectName, marker) {
  const cwd = 'C:\\work\\' + projectName;
  return {
    projects: [
      {
        path: cwd,
        name: projectName,
        sources: ['codex'],
        sessionCount: 2,
        importedCount: 1,
        subagentCount: 0,
        updatedAt: 1_700_000_000_000,
        truncated: false,
        hiddenCount: 0,
        sessions: [
          {
            source: 'codex',
            id: 's1-' + marker,
            title: 'Первая сессия ' + marker,
            cwd,
            updatedAt: 1_700_000_000_000,
            sizeBytes: 10,
            path: cwd + '\\s1.jsonl',
            importedSessionId: '',
            parentId: '',
            child: false,
            childKind: '',
          },
          {
            source: 'codex',
            id: 's2-' + marker,
            title: 'Вторая сессия',
            cwd,
            updatedAt: 1_600_000_000_000,
            sizeBytes: 20,
            path: cwd + '\\s2.jsonl',
            importedSessionId: 'dsh-session-1',
            parentId: '',
            child: false,
            childKind: '',
          },
        ],
      },
    ],
    totals: { projects: 1, sessions: 2, subagents: 0, imported: 1, sources: 1 },
    includeChildren: false,
    sources: [{ id: 'codex', label: 'Codex', available: true, total: 2, reason: '' }],
    generatedAt: 1_700_000_000_000,
    cached: false,
  };
}

/** A minimal assets tree: one source, skills + MCP + secrets groups. */
function assetsTree() {
  const item = (type, name, overrides) => ({
    id: `${type}:claude-code:${name}`,
    type,
    source: 'claude-code',
    name,
    status: 'new',
    selectable: true,
    note: '',
    target: 'C:\\Users\\owner\\.dsh\\skills\\' + name,
    path: 'C:\\Users\\owner\\.claude\\skills\\' + name,
    description: 'описание',
    ...overrides,
  });
  return {
    generatedAt: 1_700_000_000_000,
    generatedAtText: '01.01.2024 00:00:00',
    sources: [
      {
        id: 'claude-code',
        label: 'Claude Code',
        path: 'C:\\Users\\owner\\.claude',
        counts: { total: 3, new: 2, exists: 1, update: 0, available: 0, duplicate: 0, invalid: 0, selectable: 2 },
        types: [
          { type: 'skills', label: 'Скилы', counts: { total: 2, new: 1, exists: 1 }, items: [item('skills', 'alpha'), item('skills', 'beta', { status: 'exists', selectable: false, target: 'C:\\Users\\owner\\.dsh\\skills\\beta' })] },
          { type: 'mcp', label: 'MCP-серверы', counts: { total: 1, new: 1 }, items: [item('mcp', 'ctx', { target: 'C:\\Users\\owner\\.dsh\\profiles\\desktop\\cordis.patch.yml', transport: 'stdio', command: 'npx', needsEnv: [] })] },
          { type: 'secrets', label: 'Секреты', counts: { total: 1, new: 1 }, items: [item('secrets', 'OPENAI_API_KEY', { target: 'Окружение пользователя', originPath: 'C:\\Users\\owner\\.claude\\settings.json', valueLength: 51, masked: '••••••', server: '' })] },
        ],
      },
    ],
    totals: { total: 4, selectable: 3, byType: { skills: 2, mcp: 1, secrets: 1, plugins: 0, instructions: 0 }, new: 2, update: 0, exists: 1, available: 0, duplicate: 0, invalid: 0, set: 0, empty: 0, conflict: 0 },
    targets: {
      skills: 'C:\\Users\\owner\\.dsh\\skills',
      profilePatch: 'C:\\Users\\owner\\.dsh\\profiles\\desktop\\cordis.patch.yml',
      instructions: 'C:\\Users\\owner\\.dsh\\dsh-migrate\\instructions',
      environment: 'Переменные окружения пользователя Windows (User scope)',
      userEnvCount: 12,
    },
    policy: { secrets: 'Значения секретов не показываются и не логируются.' },
    secrets: { skippedNonSecret: 0 },
  };
}

/** Load the bundle with a stubbed loader, a mini React and a scripted `fetch`. */
async function loadClientModule(options = {}) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

  // A minimal React: elements are plain objects; every function component gets
  // its own hook store keyed by its occurrence in the render, so switching tabs
  // cannot shift one component's hooks into another's slots.
  const React = {};
  const hookStores = new Map();
  const occurrence = new Map();
  let activeStore = null;
  let cursor = 0;
  let dirty = false;
  let effectsAllowed = false;

  const storeOf = () => activeStore;
  React.createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } });
  React.useState = (initial) => {
    const store = storeOf();
    const index = cursor;
    cursor += 1;
    if (!(index in store.slots)) store.slots[index] = typeof initial === 'function' ? initial() : initial;
    const setter = (value) => {
      store.slots[index] = typeof value === 'function' ? value(store.slots[index]) : value;
      dirty = true;
    };
    return [store.slots[index], setter];
  };
  React.useRef = () => {
    const store = storeOf();
    const index = cursor;
    cursor += 1;
    if (!(index in store.refs)) store.refs[index] = { current: null };
    return store.refs[index];
  };
  React.useMemo = (factory) => factory();
  React.useCallback = (factory) => factory;
  React.useEffect = (callback) => {
    const store = storeOf();
    const index = cursor;
    cursor += 1;
    if (!effectsAllowed || store.ran.has(index)) return;
    store.ran.add(index);
    try {
      callback();
    } catch (error) {
      console.warn('[client-test] effect threw:', error?.message ?? error);
    }
  };

  /** Every fetch the bundle made, in order. */
  const fetches = [];
  const storage = new Map();
  /**
   * Controllable timers for the run poller: the test decides when the next poll
   * fires, so a progress sequence is deterministic instead of wall-clock bound.
   */
  const pendingTimers = [];
  const fakeSetTimeout = (callback) => {
    pendingTimers.push(callback);
    return pendingTimers.length;
  };
  const flushTimers = async (limit = 10) => {
    for (let round = 0; round < limit && pendingTimers.length > 0; round += 1) {
      const batch = pendingTimers.splice(0, pendingTimers.length);
      for (const callback of batch) {
        try {
          callback();
        } catch (error) {
          console.warn('[client-test] timer threw:', error?.message ?? error);
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const answerFor = (path) => {
    const stub = options.routes?.[path];
    if (typeof stub === 'function') return stub(fetches.filter((url) => String(url).split('?')[0] === path).length);
    return stub;
  };

  const captured = { factory: null, style: null, registered: new Map(), dictionaries: new Map() };
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        captured.id = id;
        captured.factory = factory;
      },
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    fetch: async (url) => {
      fetches.push(String(url));
      if (options.pending === true) return new Promise(() => {});
      const path = String(url).split('?')[0];
      const answer = answerFor(path);
      if (answer === undefined) return { ok: false, status: 404, json: async () => ({ error: `no stub for ${path}` }) };
      return { ok: true, status: 200, json: async () => answer };
    },
  };
  globalThis.document = {
    createElement: () => ({
      dataset: {},
      textContent: '',
      remove() {},
    }),
    head: {
      appendChild: (tag) => {
        captured.style = tag.textContent;
      },
    },
  };

  const { runInNewContext } = await import('node:vm');
  const useFakeTimers = options.timers === true;
  runInNewContext(source, {
    window: globalThis.window,
    document: globalThis.document,
    console,
    URLSearchParams: globalThis.URLSearchParams,
    setTimeout: useFakeTimers === true ? fakeSetTimeout : globalThis.setTimeout,
    clearTimeout: useFakeTimers === true ? () => {} : globalThis.clearTimeout,
  });
  assert.equal(captured.id, '@local/dsh-migrate');
  assert.equal(typeof captured.factory, 'function');

  const module = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require: ${name}`);
  });
  assert.deepEqual([...module.inject], ['slots', 'locale'], 'the client half needs the slot registry and copy');

  const ctx = {
    get: () => undefined,
    inject: (_names, callback) => callback(scope),
    effect: (callback) => {
      callback();
      return () => {};
    },
    locale: {
      register: (namespace, dictionaries) => {
        captured.dictionaries.set(namespace, dictionaries);
        return () => {};
      },
      bind: (namespace) => (key) => captured.dictionaries.get(namespace)?.ru?.[key] ?? key,
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (descriptor, component) => {
        captured.registered.set(descriptor.name, { descriptor, component });
        return () => {};
      },
    },
  };
  const scope = {
    ...ctx,
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab: () => {} },
  };
  module.apply(ctx);

  /** The interactive nodes of the last render pass. */
  let lastNodes = [];

  /** Walk one element tree, calling function components and collecting DOM-ish nodes. */
  function renderNode(node, depth = 0) {
    if (node === null || node === undefined || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map((child) => renderNode(child, depth)).join('');
    if (typeof node.type === 'function') {
      assert.ok(depth < 60, 'render recursion is too deep — a component probably renders itself');
      // Every component instance gets its own hook store, keyed by its occurrence
      // in this pass: switching tabs must not move one panel's hooks into another's slots.
      const name = node.type.name || 'anonymous';
      const occurrenceIndex = occurrence.get(name) ?? 0;
      occurrence.set(name, occurrenceIndex + 1);
      const key = `${name}#${occurrenceIndex}`;
      let store = hookStores.get(key);
      if (store === undefined) {
        store = { slots: [], refs: [], ran: new Set() };
        hookStores.set(key, store);
      }
      const previousStore = activeStore;
      const previousCursor = cursor;
      activeStore = store;
      cursor = 0;
      let output;
      try {
        output = node.type({ ...(node.props ?? {}) });
      } catch (error) {
        activeStore = previousStore;
        cursor = previousCursor;
        assert.fail(`component ${name} threw: ${error?.message ?? error}`);
      }
      activeStore = previousStore;
      cursor = previousCursor;
      return renderNode(output, depth + 1);
    }
    const props = node.props ?? {};
    if (typeof props.onClick === 'function' || typeof props.onChange === 'function') lastNodes.push(node);
    const inner = renderNode(props.children, depth + 1);
    const attributes = [];
    if (typeof props.className === 'string') attributes.push(`class="${props.className}"`);
    if (typeof props.type === 'string' && (node.type === 'button' || node.type === 'input')) attributes.push(`type="${props.type}"`);
    if (node.type === 'svg') {
      if (props.width !== undefined) attributes.push(`width="${props.width}"`);
      if (props.height !== undefined) attributes.push(`height="${props.height}"`);
    }
    if (typeof props.title === 'string') attributes.push(`title="${props.title.replace(/"/gu, '&quot;')}"`);
    if (props.role === 'tablist') attributes.push('role="tablist"');
    // Every data-* marker the components use for testing/render contracts.
    for (const [name, value] of Object.entries(props)) {
      if (name.startsWith('data-') && (typeof value === 'string' || typeof value === 'number')) attributes.push(`${name}="${value}"`);
    }
    if (props.checked === true) attributes.push('checked');
    if (props.disabled === true) attributes.push('disabled');
    if ((node.type === 'input' || node.type === 'textarea') && typeof props.value === 'string' && props.value !== '') attributes.push(`value="${props.value.replace(/"/gu, '&quot;')}"`);
    if (inner === '' && ['input', 'br', 'img', 'path', 'rect'].includes(node.type)) return `<${node.type} ${attributes.join(' ')}>`;
    return `<${node.type} ${attributes.join(' ')}>${inner}</${node.type}>`;
  }

  /** Render one component; `runEffects` lets a freshly mounted tree load its data. */
  async function render(component, props, renderOptions = {}) {
    effectsAllowed = renderOptions.runEffects !== false;
    occurrence.clear();
    lastNodes = [];
    dirty = false;
    let markup = renderNode(React.createElement(component, props ?? {}));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    if (dirty) {
      effectsAllowed = false;
      occurrence.clear();
      lastNodes = [];
      dirty = false;
      markup = renderNode(React.createElement(component, props ?? {}));
    }
    return markup;
  }

  /** Find a rendered interactive node and invoke one of its handlers. */
  async function invoke(predicate, handler, argument) {
    const node = lastNodes.find((candidate) => predicate(candidate.props ?? {}));
    assert.ok(node !== undefined, 'the interactive element must be rendered');
    await node.props[handler](argument);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return node;
  }

  return { captured, React, render, invoke, fetches, storage, flushTimers };
}

/** Mount the page slot component with its dictionaries bound to Russian. */
async function mountPage(client) {
  const component = client.captured.registered.get('main').component;
  return await client.render(component, {});
}

test('the bundle registers four surfaces and all three copy namespaces', async () => {
  const client = await loadClientModule();
  const names = [...client.captured.registered.keys()].sort();
  assert.deepEqual(names, ['conversation.session.header.utilities', 'main', 'sidebar.panellist', 'sidebar.right.pane.tab'].sort());
  assert.deepEqual([...client.captured.dictionaries.keys()].sort(), ['migrateAssetsUI', 'migrateSessionsUI', 'migrateUI']);
  assert.match(client.captured.dictionaries.get('migrateUI').ru['panel.title'], /Миграция/u);
  assert.equal(client.captured.dictionaries.get('migrateSessionsUI').ru['panel.label'], 'Сессии');
  assert.equal(client.captured.dictionaries.get('migrateAssetsUI').ru['panel.label'], 'Ассеты');
});

test('the page renders one shell with two tabs and nothing selected by default', async () => {
  const client = await loadClientModule({ routes: { '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one') } });
  const markup = await mountPage(client);

  assert.match(markup, /data-dsh-migrate="page"/u);
  assert.match(markup, /Миграция из других агентов/u, 'the page title must be there');
  assert.match(markup, /role="tablist"/u);
  assert.match(markup, /data-tab="sessions"[^>]*data-active="1"/u, 'the sessions tab is active by default');
  assert.match(markup, /data-tab="assets"[^>]*data-active="0"/u);
  assert.match(markup, /Сессии/u);
  assert.match(markup, /Ассеты/u);

  // The sessions tab body is the working tree of the predecessor plugin.
  assert.match(markup, /demo/u);
  assert.match(markup, /Первая сессия one/u);
  assert.match(markup, /Импортировать проект \(1\)/u, 'the project action counts only not-yet-imported sessions');
  assert.match(markup, /Выбрать все видимые/u);
  assert.match(markup, /Субагентные: скрыты/u);
  assert.match(markup, /Контекст субагентных/u);
  assert.doesNotMatch(markup, /checked/u, 'nothing is ticked by default');
  assert.doesNotMatch(markup, /undefined/u, 'a rendered value resolved to `undefined`');
});

test('cascading checkboxes: a project tick selects exactly its importable sessions', async () => {
  const client = await loadClientModule({ routes: { '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one') } });
  await mountPage(client);
  // The project tri-state checkbox carries the «выбрано n из m» title.
  await client.invoke((props) => props.type === 'checkbox' && String(props.title ?? '').startsWith('выбрано 0 из 1'), 'onChange', { target: { checked: true } });
  const selected = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });
  assert.match(selected, /Выбрано сессий: 1/u, 'checking the folder selects its one importable session');
  assert.match(selected, /Импортировать выбранное \(1\)/u);
  assert.match(selected, /checked/u, 'the project checkbox is now checked');
  // Unchecking the folder clears the cascade again.
  await client.invoke((props) => props.type === 'checkbox' && String(props.title ?? '').startsWith('выбрано 1 из 1'), 'onChange', { target: { checked: false } });
  const cleared = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });
  assert.doesNotMatch(cleared, /checked/u);
});

test('Refresh re-requests the tree and moves the «Обновлено» stamp (RF format)', async () => {
  const client = await loadClientModule({
    routes: {
      '/dsh-migrate/sessions/tree': (count) => sessionsTree(count <= 1 ? 'before' : 'after', String(count)),
    },
  });
  const first = await mountPage(client);
  assert.match(first, /before/u);
  assert.match(first, RU_STAMP, 'the stamp is shown right after the first load');
  const firstStamp = first.match(RU_STAMP)[0];
  const fetchesAfterMount = client.fetches.filter((url) => url.startsWith('/dsh-migrate/sessions/tree')).length;
  assert.equal(fetchesAfterMount, 1, 'the page loads the tree once on mount');
  assert.doesNotMatch(client.fetches[0], /fresh=1/u, 'the first read may use the Host cache');

  // Wait a second so the stamp can visibly change.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await client.invoke((props) => props['data-action'] === 'refresh', 'onClick');
  const refreshed = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });

  const treeFetches = client.fetches.filter((url) => url.startsWith('/dsh-migrate/sessions/tree'));
  assert.equal(treeFetches.length, 2, 'Refresh must actually re-request the tree');
  assert.match(treeFetches[1], /fresh=1/u, 'Refresh must bypass the Host tree cache');
  assert.match(refreshed, /after/u, 'the new tree replaces the old one');
  assert.doesNotMatch(refreshed, /before/u);
  const refreshedStamp = refreshed.match(RU_STAMP)[0];
  assert.notEqual(refreshedStamp, firstStamp, 'the stamp is updated after a refresh');
  assert.doesNotMatch(refreshed, /Обновление…/u, 'the spinner is gone once the request settled');
});

test('both tabs show the large expand arrows: 16 px chevron in a 24×24 target', async () => {
  const client = await loadClientModule({
    routes: {
      '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one'),
      '/dsh-migrate/assets/tree': assetsTree(),
    },
  });
  const sessionsMarkup = await mountPage(client);
  assert.match(sessionsMarkup, /class="dshMigrate_caret"/u, 'the sessions tree renders the shared caret');
  assert.match(sessionsMarkup, /class="dshMigrate_caret"[^>]*data-open="1"/u, 'the first project folder starts expanded');
  assert.match(sessionsMarkup, /<svg width="16" height="16"/u, 'the chevron icon is 16 px');

  // The stylesheet carries the target size and the token-based colours.
  const css = client.captured.style;
  assert.match(css, /\.dshMigrate_caret \{[^}]*width:24px/u);
  assert.match(css, /\.dshMigrate_caret \{[^}]*min-width:24px/u);
  assert.match(css, /\.dshMigrate_caret \{[^}]*color:var\(--dsw-alias-label-secondary\)/u);
  assert.match(css, /\.dshMigrate_caret:hover[^{]*\{[^}]*color:var\(--dsw-alias-label-primary\)/u);
  assert.match(css, /\.dshMigrate_caret svg \{[^}]*width:16px/u);
  assert.doesNotMatch(css, /--text-secondary|--border-default|--surface-raised/u, 'only --dsw-alias-* theme tokens are allowed');

  // The assets tab uses the very same component and CSS.
  await client.invoke((props) => props['data-tab'] === 'assets', 'onClick');
  const assetsMarkup = await client.render(client.captured.registered.get('main').component, {});
  assert.match(assetsMarkup, /class="dshMigrate_caret"/u, 'the assets tree renders the shared caret');
  assert.match(assetsMarkup, /<svg width="16" height="16"/u);
  assert.match(assetsMarkup, /data-open="1"/u, 'source cards and type groups start expanded');
});

test('switching to the assets tab renders the assets tree, persists the choice and keeps the stamp', async () => {
  const client = await loadClientModule({
    routes: {
      '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one'),
      '/dsh-migrate/assets/tree': assetsTree(),
    },
  });
  await mountPage(client);
  await client.invoke((props) => props['data-tab'] === 'assets', 'onClick');
  const assetsMarkup = await client.render(client.captured.registered.get('main').component, {}, { runEffects: true });

  assert.match(assetsMarkup, /data-active-tab="assets"/u);
  assert.match(assetsMarkup, /Claude Code/u);
  assert.match(assetsMarkup, /Скилы/u);
  assert.match(assetsMarkup, /MCP-серверы/u);
  assert.match(assetsMarkup, /Секреты/u);
  assert.match(assetsMarkup, /Импортировать выбранное \(0\)/u, 'nothing is selected by default');
  assert.match(assetsMarkup, /Просмотр YAML/u);
  assert.match(assetsMarkup, /симв\./u, 'a secret row shows only the value length');
  assert.match(assetsMarkup, /•{2,}/u, 'a secret row shows a mask instead of the value');
  assert.match(assetsMarkup, RU_STAMP, 'the assets tab also stamps its last load');
  assert.equal(client.storage.get('dsh-migrate.tab'), 'assets', 'the active tab is remembered in localStorage');
});

test('assets cascade: a source tick selects its importable items', async () => {
  const client = await loadClientModule({
    routes: {
      '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one'),
      '/dsh-migrate/assets/tree': assetsTree(),
    },
  });
  await mountPage(client);
  await client.invoke((props) => props['data-tab'] === 'assets', 'onClick');
  await client.render(client.captured.registered.get('main').component, {}, { runEffects: true });

  // The source card checkbox says how many importable rows it holds.
  await client.invoke((props) => props.type === 'checkbox' && String(props.title ?? '') === 'к импорту: 3', 'onChange', { target: { checked: true } });
  const selected = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });
  assert.match(selected, /Выбрано: 3/u, 'the source cascade selected all three importable rows');
  assert.match(selected, /Импортировать выбранное \(3\)/u);
});

test('the right-dock tab renders the same two tabs in a narrow column', async () => {
  const client = await loadClientModule({ routes: { '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one') } });
  const tab = client.captured.registered.get('sidebar.right.pane.tab').component;
  assert.equal(typeof tab, 'function');
  const markup = await client.render(tab, {});
  assert.match(markup, /data-dsh-migrate="tab"/u);
  assert.match(markup, /role="tablist"/u);
  assert.match(markup, /data-tab="sessions"/u);
  assert.match(markup, /data-tab="assets"/u);
  assert.match(markup, /demo/u);
  assert.doesNotMatch(markup, /undefined/u);
});

test('the loading state renders a spinner and the busy label', async () => {
  const client = await loadClientModule({ pending: true });
  const markup = await mountPage(client);
  assert.match(markup, /Обновление…/u, 'Refresh shows its busy label while scanning');
  assert.match(markup, /class="dshMigrate_spinner"/u);
  assert.match(markup, /disabled/u, 'Refresh is disabled while a scan is in flight');
  assert.match(markup, /Сканирую проекты…/u);
});

test('the mandatory environment confirmation is still in the bundle', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /data-confirm': 'environment'/u);
  assert.match(source, /secrets\.confirmOk/u);
  assert.match(source, /pendingConfirm/u);
  assert.match(source, /overwriteSecrets/u);
  assert.match(source, /перезаписать уже заданные/u);
});

/* ------------------------------------------------- progress and re-import */

/** The initial run answer a POST returns before any work is done. */
function startRunAnswer(kind, runId, items) {
  return {
    runId,
    statusRoute: '/dsh-migrate/sessions/run-status',
    pollMs: 400,
    run: {
      id: runId,
      kind,
      status: 'running',
      stage: 'queued',
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      finishedAt: 0,
      total: items.length,
      done: 0,
      percent: 0,
      items: items.map((item, index) => ({ index, source: 'codex', id: item.id, title: item.title ?? '', path: '', status: 'pending', stage: 'queued', writeDone: 0, writeTotal: 0, messages: 0, turns: 0, events: 0, warnings: [], error: '' })),
      summary: { imported: 0, reimported: 0, already: 0, skipped: 0, failed: 0 },
      projects: [],
      hint: { needed: false, text: '', refreshWorked: null },
    },
  };
}

test('the import progress bar shows stages, «i из N», the event counter and the per-session log', async () => {
  const started = startRunAnswer('import', 'run-7', [{ id: 's1' }, { id: 's2' }]);
  const running = JSON.parse(JSON.stringify(started.run));
  running.percent = 45;
  running.stage = 'writing';
  running.items[0] = { ...running.items[0], status: 'running', stage: 'writing', title: 'Первая сессия one', messages: 30, events: 200, writeDone: 100, writeTotal: 200 };
  const client = await loadClientModule({
    timers: true,
    routes: {
      '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one'),
      '/dsh-migrate/sessions/run': started,
      '/dsh-migrate/sessions/run-status': (count) => ({ pollMs: 400, run: count <= 1 ? running : null }),
    },
  });
  await mountPage(client);
  await client.invoke((props) => props.type === 'button' && String(props.title ?? '').startsWith('Импортировать проект'), 'onClick');
  const markup = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });

  assert.match(markup, /class="dshMigrate_progress"/u, 'the progress panel must appear');
  assert.match(markup, /data-run-status="running"/u);
  assert.match(markup, /45%/u, 'the overall percent must be visible');
  assert.match(markup, /Сейчас: запись событий/u, 'the current stage must be named');
  assert.match(markup, /записано событий: 100 из 200/u, 'the event counter must move');
  assert.match(markup, /Первая сессия one/u, 'the log line must carry the session name');
  assert.match(markup, /сообщений: 30/u, 'the log line must carry the message count');
  assert.match(markup, /0 из 2/u, 'the «i из N» counter counts finished sessions');

  // Let the poller fire once more: the Host now reports the settled run.
  const done = JSON.parse(JSON.stringify(running));
  done.status = 'done';
  done.stage = 'done';
  done.percent = 100;
  done.done = 2;
  done.summary = { imported: 2, reimported: 0, already: 0, skipped: 0, failed: 0 };
  done.projects = [{ path: 'C:\\work\\demo', title: 'demo', imported: 2 }];
  done.hint = { needed: true, text: '', refreshWorked: false };
  done.items = done.items.map((item, index) => ({ ...item, status: 'done', stage: 'done', title: index === 0 ? 'Первая сессия one' : 'Вторая сессия', turns: index === 0 ? 4 : 2 }));
  client.captured.routes = { done };
  // Swap the poll answer through the route stub: it is read again on the next poll.
  const answers = [running, done];
  let calls = 0;
  // Re-load a client whose status route serves the sequence.
  const second = await loadClientModule({
    timers: true,
    routes: {
      '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one'),
      '/dsh-migrate/sessions/run': started,
      '/dsh-migrate/sessions/run-status': () => ({ pollMs: 400, run: answers[calls++] ?? done }),
    },
  });
  await mountPage(second);
  await second.invoke((props) => props.type === 'button' && String(props.title ?? '').startsWith('Импортировать проект'), 'onClick');
  await second.flushTimers();
  const settled = await second.render(second.captured.registered.get('main').component, {}, { runEffects: false });
  assert.match(settled, /data-run-status="done"/u);
  assert.match(settled, /Импорт завершён/u);
  assert.match(settled, /Импортировано: 2/u);
  assert.match(settled, /в проект demo импортировано 2 сессий/u, 'the per-project counter must be visible');
  assert.match(settled, /перезагрузки плагинов/u, 'the desktop reload hint must be there');
  assert.doesNotMatch(settled, /F5|обновите страниц/u, 'no browser-page advice is allowed');
  assert.ok(second.fetches.some((url) => url.startsWith('/dsh-migrate/sessions/run-status')), 'the panel polls the Host');
  assert.ok(second.fetches.some((url) => url.startsWith('/dsh-migrate/sessions/run')), 'the panel starts a Host run');
});

test('needs-reimport becomes a human explanation with a working «Переимпортировать» button', async () => {
  const started = startRunAnswer('reimport', 'run-9', [{ id: 's2' }]);
  const done = JSON.parse(JSON.stringify(started.run));
  done.status = 'done';
  done.stage = 'done';
  done.percent = 100;
  done.done = 1;
  done.summary = { imported: 0, reimported: 1, already: 0, skipped: 0, failed: 0 };
  done.projects = [{ path: 'C:\\work\\demo', title: 'demo', imported: 1 }];
  done.hint = { needed: true, text: '', refreshWorked: false };
  done.items[0] = {
    ...done.items[0],
    status: 'done',
    stage: 'done',
    title: 'Вторая сессия',
    turns: 6,
    mode: 'copy',
    sessionId: 'session-new-copy',
    previousSessionId: 'dsh-session-1',
    archived: true,
  };
  const client = await loadClientModule({
    timers: true,
    routes: {
      '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one'),
      '/dsh-migrate/sessions/update': { status: 'needs-reimport', addedMessages: 0, addedTurns: 0, verified: false, action: 'reimport', reason: 'no-watermark', message: '', warnings: [] },
      '/dsh-migrate/sessions/repair-watermark': {
        items: [{ sessionId: 'dsh-session-1', status: 'diverged', matchedMessages: 1, copiedMessages: 18, sourceMessages: 20, foreignMessageCount: 0, reason: 'источник переписан' }],
        summary: { requested: 1, repaired: 0, diverged: 1, failed: 0 },
      },
      '/dsh-migrate/sessions/reimport': started,
      '/dsh-migrate/sessions/run-status': () => ({ pollMs: 400, run: done }),
    },
  });
  await mountPage(client);
  await client.invoke((props) => props['data-action'] === 'update', 'onClick');
  const issueMarkup = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });
  assert.match(issueMarkup, /data-issue="needs-reimport"/u, 'the dead end is rendered as an inline issue');
  assert.match(issueMarkup, /Дописать только новое нельзя/u, 'the explanation is human, not a red status word');
  assert.match(issueMarkup, /data-action="repair-watermark"/u, 'the non-destructive repair is the primary action');
  assert.match(issueMarkup, /Восстановить отметку/u);
  assert.match(issueMarkup, /data-action="ask-reimport"/u);
  assert.match(issueMarkup, /Переимпортировать/u, 'the new-copy action is on the same row');
  assert.ok(client.fetches.some((url) => url.startsWith('/dsh-migrate/sessions/repair-watermark')), 'Update first tries to prove the watermark');

  await client.invoke((props) => props['data-action'] === 'ask-reimport', 'onClick');
  const confirmMarkup = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });
  assert.match(confirmMarkup, /data-confirm="reimport"/u, 'the copy action always asks first');
  assert.match(confirmMarkup, /Будет создана НОВАЯ копия/u, 'the confirmation explains that nothing is deleted');
  assert.match(confirmMarkup, /Да, переимпортировать/u);

  await client.invoke((props) => props['data-action'] === 'reimport-confirm', 'onClick');
  const finalMarkup = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });
  assert.match(finalMarkup, /переимпортировано: 1/u, 'the settled re-import reports its result');
  assert.match(finalMarkup, /Создана новая копия session-new-copy/u, 'the owner sees the new copy id');
  assert.match(finalMarkup, /старая копия архивирована/u, 'and what happened to the old one');
  assert.ok(client.fetches.some((url) => url.startsWith('/dsh-migrate/sessions/reimport')), 'the button posts a re-import');
  assert.ok(client.fetches.some((url) => url.startsWith('/dsh-migrate/sessions/run-status')), 'the re-import is followed live');
});

test('Update proves an inherited watermark and retries itself without deleting anything', async () => {
  let updateCalls = 0;
  const client = await loadClientModule({
    routes: {
      '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one'),
      '/dsh-migrate/sessions/update': () => {
        updateCalls += 1;
        return updateCalls <= 1
          ? { status: 'needs-reimport', addedMessages: 0, addedTurns: 0, verified: false, action: 'reimport', reason: 'no-watermark', message: '', warnings: [] }
          : { status: 'updated', addedMessages: 2, addedTurns: 1, verified: true, warnings: [] };
      },
      '/dsh-migrate/sessions/repair-watermark': {
        items: [{ sessionId: 'dsh-session-1', status: 'repaired', matchedMessages: 18, copiedMessages: 18, sourceMessages: 20, foreignMessageCount: 18, reason: '' }],
        summary: { requested: 1, repaired: 1, diverged: 0, failed: 0 },
      },
    },
  });
  await mountPage(client);
  await client.invoke((props) => props['data-action'] === 'update', 'onClick');
  const markup = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });
  assert.equal(updateCalls, 2, 'the update is retried after the proof');
  assert.ok(client.fetches.some((url) => url.startsWith('/dsh-migrate/sessions/repair-watermark')));
  assert.match(markup, /Отметка восстановлена, дописано сообщений: 2/u, 'the owner sees the repaired result');
  assert.doesNotMatch(markup, /data-issue=/u, 'no dead end remains on the row');
  assert.doesNotMatch(markup, /закройте/iu, 'no request to close the session');
});

test('diverged is repaired the same way, not left as a dead end', async () => {
  const client = await loadClientModule({
    routes: {
      '/dsh-migrate/sessions/tree': sessionsTree('demo', 'one'),
      '/dsh-migrate/sessions/update': { status: 'diverged', addedMessages: 0, addedTurns: 0, verified: false, action: 'reimport', reason: 'diverged', message: '', warnings: [] },
    },
  });
  await mountPage(client);
  await client.invoke((props) => props['data-action'] === 'update', 'onClick');
  const markup = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });
  assert.match(markup, /data-issue="diverged"/u);
  assert.match(markup, /Источник переписал начало истории/u, 'the diverged message explains why the copy lags');
  assert.match(markup, /data-action="repair-watermark"/u, 'the proof is offered first even for a divergence');
  assert.match(markup, /Переимпортировать/u);
  assert.doesNotMatch(markup, /закройте/iu);
});

test('desktop-only wording guard: no F5 / browser-page advice anywhere a human reads', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = async (relative) => readFile(new URL(relative, import.meta.url), 'utf8');
  const texts = {
    client: await read('../client.js'),
    host: await read('../index.js'),
    readme: await read('../README.md'),
    ru: await read('../locale/ru.json'),
    en: await read('../locale/en.json'),
  };
  const forbidden = /F5|Ctrl\+R|обновите страниц|перезагрузите стран|перезагрузк[аи] стран|refresh page|reload the page/iu;
  for (const [name, value] of Object.entries(texts)) {
    assert.doesNotMatch(value, forbidden, `${name} must not mention a browser page or F5`);
  }
  // The only refresh advice is the desktop one: reload the plugins or restart DSH.
  assert.match(texts.client, /перезагрузки плагинов \(⟳\) или перезапуска DSH/u);
  assert.match(texts.client, /Сессии появятся в списке после перезагрузки плагинов/u);
});

/* --------------------------------------------------------------- attach */

test('an imported session outside a project shows «Привязать к проекту» and attaches on click', async () => {
  const tree = sessionsTree('demo', 'one');
  // The imported session is the second one; its cwd names the project, but the
  // workspace registry does not list it — exactly the Ungrouped case.
  tree.projects[0].sessions[1].inWorkspace = false;
  const attachedTree = sessionsTree('demo', 'one');
  attachedTree.projects[0].sessions[1].inWorkspace = true;
  let treeAnswers = 0;
  const client = await loadClientModule({
    routes: {
      '/dsh-migrate/sessions/tree': () => (treeAnswers++ === 0 ? tree : attachedTree),
      '/dsh-migrate/sessions/attach': {
        items: [{ sessionId: 'dsh-session-1', status: 'attached', workspaceTitle: 'demo', workspacePath: 'C:\\work\\demo', reason: '' }],
        summary: { requested: 1, attached: 1, already: 0, failed: 0 },
      },
    },
  });
  const markup = await mountPage(client);
  assert.match(markup, /data-attach="missing"/u, 'the ungrouped session is flagged in the tree');
  assert.match(markup, /Привязать к проекту/u, 'the repair action is offered on the row');
  assert.match(markup, /Сессия не в проекте/u, 'the warning explains the state');

  await client.invoke((props) => props['data-action'] === 'attach', 'onClick');
  const after = await client.render(client.captured.registered.get('main').component, {}, { runEffects: false });
  assert.match(after, /Привязано к проекту «demo»/u, 'the result is reported to the owner');
  assert.ok(client.fetches.some((url) => url.startsWith('/dsh-migrate/sessions/attach')), 'the button posts the attach route');
  assert.doesNotMatch(after, /data-attach="missing"/u, 'the warning disappears once the session is attached');

  // A session already in its project shows no warning and no attach button.
  const clean = await loadClientModule({ routes: { '/dsh-migrate/sessions/tree': attachedTree } });
  const cleanMarkup = await mountPage(clean);
  assert.doesNotMatch(cleanMarkup, /data-attach="missing"/u);
  assert.doesNotMatch(cleanMarkup, /Привязать к проекту/u);
});
