/**
 * Guard tests for the plugins-version check (GET /dsh-reload/updates).
 *
 * What these protect:
 *   - the answer keeps the contract { installed, remote, behind, branch };
 *   - the check never mutates the checkout (no pull/merge/checkout/reset): an
 *     update is applied by the owner, never by the page;
 *   - a machine without git, or a Host without a checkout, gets a clear error
 *     instead of a crash;
 *   - being offline is reported, not thrown.
 *
 * Run: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, checkUpdates, findRepoRoot, handleUpdates } from '../index.js'

/** A fake ServerResponse that records what the handler answered. */
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

/** A fake incoming request: these routes only read the method and the URL. */
function fakeRequest(method, url) {
  return { method, url, headers: {} }
}

/** Any checkout path: the fake git never touches the disk, so it need not exist. */
const REPO = join(process.cwd(), 'dsh-plugins')

/** The command set of an up-to-date checkout with nothing to report. */
function upToDateScript() {
  return {
    'rev-parse --abbrev-ref HEAD': { ok: true, stdout: 'main' },
    'rev-parse --short HEAD': { ok: true, stdout: 'b940b91' },
    'remote': { ok: true, stdout: 'origin' },
    'fetch --quiet --prune origin main': { ok: true, stdout: '' },
    'rev-parse --short origin/main': { ok: true, stdout: 'b940b91' },
    'rev-list --count HEAD..origin/main': { ok: true, stdout: '0' },
    'rev-list --count origin/main..HEAD': { ok: true, stdout: '0' },
    'status --porcelain': { ok: true, stdout: '' },
  }
}

/** A fake git that answers from a table and records every command it was given. */
function fakeGit(script) {
  const calls = []
  const run = async (_cwd, args) => {
    const key = args.join(' ')
    calls.push(key)
    const answer = script[key]
    if (answer === undefined) return { ok: false, error: 'unexpected git command: ' + key, code: 'git-failed' }
    return answer
  }
  return { calls, run }
}

/** The route, wired to a fake git — the same seam the Host uses for tests. */
function routeWith(script, extra = {}) {
  const git = fakeGit(script)
  const deps = { check: (options) => checkUpdates({ ...options, ...extra, repo: REPO, run: git.run }) }
  return { git, deps }
}

/** The repository manifest, as the Host reads it from plugins.json. */
const MANIFEST = JSON.stringify({
  plugins: [
    { name: '@local/dsh-peer-bus', dir: 'peer-bus', version: '2.1.0' },
    { name: '@local/dsh-reload', dir: 'dsh-reload', version: '1.0.0' },
    { name: '@local/dsh-migrate', dir: 'dsh-migrate', version: '1.0.0' },
  ],
})

/** plugins.json is read from the checkout; tests answer it from memory. */
const readManifest = () => MANIFEST

/** The command set of an up-to-date checkout — no diff is asked for at all. */
const BEHIND_SCRIPT = () => {
  const script = upToDateScript()
  script['rev-parse --short origin/main'] = { ok: true, stdout: 'a1b2c3d' }
  script['rev-list --count HEAD..origin/main'] = { ok: true, stdout: '2' }
  return script
}

test('the route answers installed, remote, behind and branch', async () => {
  const { deps } = routeWith(upToDateScript())
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  assert.equal(response.captured.status, 200)
  const body = response.captured.json
  assert.equal(body.ok, true)
  assert.equal(body.installed, 'b940b91')
  assert.equal(body.remote, 'b940b91')
  assert.equal(body.behind, 0)
  assert.equal(body.branch, 'main')
  assert.equal(body.fetched, true)
  assert.equal(body.dirty, false)
})

test('a checkout behind its remote reports how many commits, and how many are ahead', async () => {
  const script = upToDateScript()
  script['rev-parse --short origin/main'] = { ok: true, stdout: 'a1b2c3d' }
  script['rev-list --count HEAD..origin/main'] = { ok: true, stdout: '3' }
  script['rev-list --count origin/main..HEAD'] = { ok: true, stdout: '1' }
  script['status --porcelain'] = { ok: true, stdout: ' M README.md' }
  const { deps } = routeWith(script)
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  const body = response.captured.json
  assert.equal(response.captured.status, 200)
  assert.equal(body.installed, 'b940b91')
  assert.equal(body.remote, 'a1b2c3d')
  assert.equal(body.behind, 3)
  assert.equal(body.ahead, 1)
  assert.equal(body.dirty, true)
})

test('the check never mutates the checkout: no command installs anything', async () => {
  const { deps, git } = routeWith(upToDateScript())
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  const forbidden = ['pull', 'merge', 'checkout', 'switch', 'reset', 'rebase', 'clean', 'cherry-pick', 'stash', 'am']
  for (const command of git.calls) {
    const verb = command.split(' ')[0]
    assert.ok(
      forbidden.includes(verb) === false,
      'the version check must not run git ' + verb + ' (saw: ' + command + ')',
    )
  }
  assert.ok(git.calls.includes('fetch --quiet --prune origin main'), 'the only network command is a fetch')
})

test('a machine without git answers a clear 503 instead of crashing', async () => {
  const run = async () => ({
    ok: false,
    stdout: '',
    code: 'no-git',
    error: 'git is not recognized as an internal or external command',
  })
  const deps = { check: (options) => checkUpdates({ ...options, repo: REPO, run }) }
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  assert.equal(response.captured.status, 503)
  assert.equal(response.captured.json.ok, false)
  assert.equal(response.captured.json.reason, 'no-git')
  assert.match(response.captured.json.error, /git/u)
})

test('a Host with no checkout at all names the variable that fixes it', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'lonely-host', 'dsh-reload', 'index.js')).href
  const deps = { check: () => checkUpdates({ repo: undefined, env: {}, moduleUrl, isRepo: () => false }) }
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  assert.equal(response.captured.status, 503)
  assert.equal(response.captured.json.reason, 'no-repo')
  assert.match(response.captured.json.error, /DSH_BOND_PLUGINS/u, 'the error says what to fix')
})

test('being offline is reported, not thrown: the installed version still comes back', async () => {
  const script = upToDateScript()
  script['fetch --quiet --prune origin main'] = {
    ok: false,
    code: 'git-failed',
    error: 'Could not resolve host: github.com',
  }
  const { deps } = routeWith(script)
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  const body = response.captured.json
  assert.equal(response.captured.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.fetched, false)
  assert.equal(body.installed, 'b940b91')
  assert.match(body.warning, /fetch failed/u)
})

test('fetch=0 reads the local commit and never touches the network', async () => {
  const { deps, git } = routeWith(upToDateScript())
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates?fetch=0'), response, deps)

  assert.equal(response.captured.status, 200)
  assert.equal(response.captured.json.fetched, false)
  assert.equal(git.calls.some((command) => command.startsWith('fetch')), false, 'no fetch when the caller asks for none')
})

test('the route is GET only', async () => {
  const { deps } = routeWith(upToDateScript())
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('POST', '/dsh-reload/updates'), response, deps)

  assert.equal(response.captured.status, 405)
  assert.equal(response.captured.headers.allow, 'GET')
  assert.equal(response.captured.json.ok, false)
})

test('the check finds the checkout above the plugin directory, without a hardcoded path', () => {
  const root = join(process.cwd(), 'fake-checkout')
  const moduleUrl = pathToFileURL(join(root, 'dsh-reload', 'index.js')).href
  const found = findRepoRoot({ env: {}, moduleUrl, isRepo: (directory) => directory === root })

  assert.equal(found.ok, true)
  assert.equal(found.root, root)
})

test('DSH_BOND_PLUGINS wins over the plugin location, and a wrong value is reported', () => {
  const root = join(process.cwd(), 'elsewhere')
  const good = findRepoRoot({
    env: { DSH_BOND_PLUGINS: root },
    moduleUrl: pathToFileURL(join(process.cwd(), 'dsh-reload', 'index.js')).href,
    isRepo: (directory) => directory === root,
  })
  assert.equal(good.ok, true)
  assert.equal(good.root, root)
  assert.equal(good.source, 'env')

  const bad = findRepoRoot({ env: { DSH_BOND_PLUGINS: root }, moduleUrl: 'file:///nowhere/index.js', isRepo: () => false })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /DSH_BOND_PLUGINS/u)
})

test('the Host half carries no personal path', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /[A-Za-z]:[\\/]+Users[\\/]/u, 'no absolute user path in the Host half')
  // The version check locates the checkout from its own module URL; an
  // environment variable would tie it to one machine's profile layout.
  const start = source.indexOf('export function findRepoRoot')
  const end = source.indexOf('export async function handleUpdates')
  assert.ok(start > 0 && end > start, 'the version-check block is where this guard expects it')
  const block = source.slice(start, end)
  assert.doesNotMatch(block, /USERPROFILE|HOMEPATH|os\.homedir/u, 'the checkout is located from the module, not from the profile')
})

test('only the plugin the incoming commits touch is named, with both versions', async () => {
  const script = BEHIND_SCRIPT()
  script['diff --name-only HEAD..origin/main'] = {
    ok: true,
    stdout: 'peer-bus/index.js\npeer-bus/CHANGELOG.md\nREADME.md',
  }
  script['cat-file -e HEAD:peer-bus/package.json'] = { ok: true, stdout: '' }
  script['show HEAD:peer-bus/package.json'] = {
    ok: true,
    stdout: JSON.stringify({ name: '@local/dsh-peer-bus', version: '2.1.0' }),
  }
  script['cat-file -e origin/main:peer-bus/package.json'] = { ok: true, stdout: '' }
  script['show origin/main:peer-bus/package.json'] = {
    ok: true,
    stdout: JSON.stringify({ name: '@local/dsh-peer-bus', version: '2.2.0' }),
  }
  const { deps } = routeWith(script, { readFile: readManifest })
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  assert.equal(response.captured.status, 200)
  assert.deepEqual(response.captured.json.changedPlugins, [
    { dir: 'peer-bus', name: '@local/dsh-peer-bus', from: '2.1.0', to: '2.2.0' },
  ])
})

test('a docs-only change names no plugin at all', async () => {
  const script = BEHIND_SCRIPT()
  script['diff --name-only HEAD..origin/main'] = { ok: true, stdout: 'README.md\n.github/workflows/ci.yml' }
  const { deps, git } = routeWith(script, { readFile: readManifest })
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  assert.equal(response.captured.status, 200)
  assert.equal(response.captured.json.behind, 2)
  assert.deepEqual(response.captured.json.changedPlugins, [])
  assert.equal(
    git.calls.some((command) => command.startsWith('cat-file')),
    false,
    'a docs-only change must not even look for plugin manifests',
  )
})

test('an up-to-date checkout asks git for no diff at all', async () => {
  const { deps, git } = routeWith(upToDateScript(), { readFile: readManifest })
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  assert.deepEqual(response.captured.json.changedPlugins, [])
  assert.equal(git.calls.some((command) => command.startsWith('diff')), false)
})

test('a broken package.json leaves the version unknown instead of crashing', async () => {
  const script = BEHIND_SCRIPT()
  script['diff --name-only HEAD..origin/main'] = { ok: true, stdout: 'peer-bus/index.js' }
  script['cat-file -e HEAD:peer-bus/package.json'] = { ok: true, stdout: '' }
  script['show HEAD:peer-bus/package.json'] = { ok: true, stdout: 'not json at all' }
  script['cat-file -e origin/main:peer-bus/package.json'] = { ok: true, stdout: '' }
  script['show origin/main:peer-bus/package.json'] = {
    ok: true,
    stdout: JSON.stringify({ name: '@local/dsh-peer-bus', version: '2.2.0' }),
  }
  const { deps } = routeWith(script, { readFile: readManifest })
  const response = fakeResponse()

  await handleUpdates({}, fakeRequest('GET', '/dsh-reload/updates'), response, deps)

  assert.equal(response.captured.status, 200)
  assert.deepEqual(response.captured.json.changedPlugins, [
    { dir: 'peer-bus', name: '@local/dsh-peer-bus', from: null, to: '2.2.0' },
  ])
})

test('the route is registered on the web carrier', () => {
  const registered = []
  const webServer = {
    register(spec) {
      registered.push(spec)
      return () => {}
    },
  }
  const ctx = {
    webServer,
    effect: (operation) => {
      operation()
      return () => {}
    },
    get: (name) => (name === 'webServer' ? webServer : undefined),
  }

  apply(ctx)

  const route = registered.find((spec) => spec.path === '/dsh-reload/updates')
  assert.ok(route !== undefined, 'GET /dsh-reload/updates is registered')
  assert.equal(route.kind, 'exact')
  assert.equal(typeof route.handler, 'function')
})
