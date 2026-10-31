/**
 * Board filter: closed sessions are hidden until they are asked for.
 *
 * Guard — a dead session filled the board with rows nobody acts on. The board therefore hides
 * `closed` nodes by default, offers a "Показать закрытые" tick that is remembered across restarts,
 * and never hides a project's master, because its crown must stay visible. The counts, the legend,
 * the project filter and the node clicks must keep working while the filter is on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allByClass,
  byClass,
  classText,
  createClientHarness,
  propOf,
  textOf,
} from './support/client-harness.mjs'

const PROJECT = 'C:\\project'
const OTHER = 'C:\\other'

/** One board payload with the given nodes. */
function boardOf(...nodes) {
  return {
    version: 2,
    project: PROJECT,
    claims: [],
    threads: [],
    projects: [],
    nodes,
    updatedAt: 1793468647000,
  }
}

/** One normalized-as-the-Host-sends-it node. */
function node(id, overrides = {}) {
  const state = overrides.state ?? 'running'
  return {
    id,
    short: id.slice(-6),
    name: '',
    title: '',
    status: state === 'running' || state === 'idle' ? state : 'closed',
    state,
    project: PROJECT,
    cwd: PROJECT,
    ...overrides,
  }
}

/** The checkbox in the board header. */
function checkboxOf(tree) {
  return byClass(tree, 'dshPeerBus_toggle')
}

/** The board's per-state count line. */
function metaOf(tree) {
  return classText(tree, 'dshPeerBus_paneMeta')
}

/** The legend entry for one state. */
function legendOf(tree, state) {
  return allByClass(tree, 'dshPeerBus_legendItem').find(
    (entry) => propOf(byClass(entry, 'dshPeerBus_dot'), 'data-state') === state,
  )
}

test('a closed session is not drawn by default, still counted, and the tick is off', async () => {
  const harness = await createClientHarness({
    board: boardOf(
      node('session-live0001', { name: 'Альфа', title: 'Альфа' }),
      node('session-dead0002', { name: 'Омега', title: 'Омега', state: 'closed' }),
    ),
  })
  const tree = harness.renderBoard()
  const text = textOf(tree)

  assert.ok(text.includes('Альфа'), 'a live session is drawn')
  assert.equal(text.includes('Омега'), false, 'a closed session is not drawn by default')
  assert.equal(allByClass(tree, 'dshPeerBus_node').length, 1, 'only the live row is in the tree')

  const checkbox = checkboxOf(tree)
  assert.notEqual(checkbox, null, 'the header has a "show closed" checkbox')
  assert.equal(propOf(checkbox, 'type'), 'checkbox', 'it is a checkbox, not a button')
  assert.equal(propOf(checkbox, 'checked'), false, 'the checkbox starts off')

  assert.match(classText(tree, 'dshPeerBus_toggleLabel'), /\(1\)/, 'the hidden closed session is counted')
  assert.ok(text.includes('Показать закрытые'), 'the label is Russian')

  const closedLegend = legendOf(tree, 'closed')
  assert.equal(propOf(closedLegend, 'data-hidden'), 'true', 'the hidden state is muted in the legend')
  assert.match(textOf(closedLegend), /скрыт/, 'the legend says the state is hidden')

  assert.match(metaOf(tree), /работает/, 'the count line still counts live states')
  assert.equal(/закрыто/.test(metaOf(tree)), false, 'hidden closed rows are not counted as rows')
  assert.equal(/\d{4}-\d{2}-\d{2}/.test(text), false, 'no ISO date leaks into the board')
})

test('the tick shows closed sessions and the choice is remembered', async () => {
  const harness = await createClientHarness({
    board: boardOf(
      node('session-live0001', { name: 'Альфа', title: 'Альфа' }),
      node('session-dead0002', { name: 'Омега', title: 'Омега', state: 'closed' }),
    ),
  })
  let tree = harness.renderBoard()
  assert.equal(textOf(tree).includes('Омега'), false)

  const onChange = propOf(checkboxOf(tree), 'onChange')
  assert.equal(typeof onChange, 'function', 'the checkbox is wired')
  onChange({ target: { checked: true } })
  tree = harness.tree
  assert.ok(textOf(tree).includes('Омега'), 'turning the tick on draws the closed session')
  assert.equal(propOf(checkboxOf(tree), 'checked'), true, 'the checkbox reflects the choice')
  assert.equal(harness.storage.getItem('dsh.peerBus.showClosed'), '1', 'the choice is persisted')

  // A fresh page (same storage) starts with the tick already on — that is what survives a restart.
  const restarted = await createClientHarness({
    board: boardOf(node('session-dead0002', { name: 'Омега', title: 'Омега', state: 'closed' })),
    storage: { 'dsh.peerBus.showClosed': '1' },
  })
  const fresh = restarted.renderBoard()
  assert.ok(textOf(fresh).includes('Омега'), 'the stored choice is honoured on the first render')
  assert.equal(propOf(checkboxOf(fresh), 'checked'), true, 'the stored choice shows in the checkbox')
  assert.equal(propOf(legendOf(fresh, 'closed'), 'data-hidden'), 'false', 'the legend is no longer muted')
})

test('a closed master is always drawn: the project crown never disappears', async () => {
  const harness = await createClientHarness({
    board: boardOf(
      node('session-master01', { name: 'Мастер', title: 'Мастер', state: 'closed', master: true }),
      node('session-dead0002', { name: 'Омега', title: 'Омега', state: 'closed' }),
    ),
  })
  const tree = harness.renderBoard()
  const text = textOf(tree)

  assert.ok(text.includes('Мастер'), 'a closed project master stays on the board')
  assert.equal(text.includes('Омега'), false, 'an ordinary closed session is still hidden')
  assert.notEqual(byClass(tree, 'dshPeerBus_treeCrown'), null, 'the master keeps its crown')
  assert.match(classText(tree, 'dshPeerBus_toggleLabel'), /\(1\)/, 'only the non-master closed row is counted')
  assert.equal(allByClass(tree, 'dshPeerBus_node').length, 1, 'exactly the master row is drawn')
})

test('a board of nothing but closed sessions explains the empty tree', async () => {
  const harness = await createClientHarness({
    board: boardOf(
      node('session-dead0001', { name: 'Омега', title: 'Омега', state: 'closed' }),
      node('session-dead0002', { name: 'Сигма', title: 'Сигма', state: 'closed' }),
    ),
  })
  const tree = harness.renderBoard()
  const text = textOf(tree)

  assert.equal(allByClass(tree, 'dshPeerBus_node').length, 0, 'no dead row is drawn')
  assert.match(classText(tree, 'dshPeerBus_empty'), /Показать закрытые/, 'the empty state points at the tick')
  assert.match(classText(tree, 'dshPeerBus_toggleLabel'), /\(2\)/, 'both hidden sessions are counted')
  assert.equal(/0 закрыто/.test(metaOf(tree)), false, 'the count line does not claim an empty board is all closed')
})

test('the project filter and the node clicks keep working under the filter', async () => {
  const harness = await createClientHarness({
    board: boardOf(
      node('session-live0001', { name: 'Альфа', title: 'Альфа' }),
      node('session-dead0002', { name: 'Омега', title: 'Омега', state: 'closed' }),
      node('session-other003', { name: 'Бета', title: 'Бета', project: OTHER, cwd: OTHER }),
    ),
  })
  let tree = harness.renderBoard()
  const select = byClass(tree, 'dshPeerBus_filter')
  assert.notEqual(select, null, 'two projects give the filter dropdown')

  propOf(select, 'onChange')({ target: { value: PROJECT } })
  tree = harness.tree
  const text = textOf(tree)
  assert.ok(text.includes('Альфа'), 'the chosen project keeps its live session')
  assert.equal(text.includes('Бета'), false, 'the other project is filtered out')
  assert.equal(text.includes('Омега'), false, 'the closed session stays hidden inside the chosen project')
  assert.match(classText(tree, 'dshPeerBus_toggleLabel'), /\(1\)/, 'the hidden count follows the project')

  const head = byClass(tree, 'dshPeerBus_nodeHead')
  assert.equal(typeof propOf(head, 'onClick'), 'function', 'a row is still clickable')
  assert.doesNotThrow(() => propOf(head, 'onClick')(), 'clicking a row does not throw')
})
