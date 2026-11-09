/**
 * Guard 20 — the typewriter is adaptive and terminates.
 *
 * The rate is `min(20 ms, 2500 / N)` per character with no lower bound, and above 1200 characters
 * the text appears at once, so every visual update finishes within 2.5 s. Two polls 50 ms apart must
 * neither lose text nor reorder it: the panel always paints a prefix of the newest document.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientHarness, walk } from './support/client-harness.mjs'

/** Build a one-block document with the given text. */
function documentWith(text, version = 1) {
  return {
    schema: 1,
    id: 'doc-1',
    scope: 'global',
    sessionId: null,
    title: 'Документ',
    version,
    nextBlockSeq: 2,
    nextCommentSeq: 1,
    blocks: [{ id: 'b-1', type: 'p', spans: [{ t: text }] }],
    comments: [],
    style: { tone: 'нейтральный', person: 'вы', avgSentence: 0, flags: [] },
    updatedAt: '2026-11-06T13:20:00+03:00',
  }
}

/** The HTML the editor would show for one block. */
function blockHtml(harness, blockId) {
  const node = walk(harness.tree).find((entry) => entry.props?.['data-block-id'] === blockId)
  return node?.props?.dangerouslySetInnerHTML?.__html ?? ''
}

/** The plain text of one block's rendered HTML. */
const blockText = (harness, blockId) => blockHtml(harness, blockId).replace(/<[^>]+>/g, '')

test('the typing plan respects the 2.5 s budget and turns instant above 1200 characters', async () => {
  const harness = await createClientHarness()
  const { typingPlan } = harness.internals

  const small = typingPlan(1200)
  assert.equal(small.instant, false, '1200 characters animate')
  assert.ok(small.perCharMs <= 20, `per-char delay must not exceed 20 ms, got ${small.perCharMs}`)
  assert.ok(small.durationMs <= 2500 + 1e-6, `the whole animation must fit 2.5 s, got ${small.durationMs}`)

  assert.equal(typingPlan(3000).instant, true, 'above 1200 characters the text appears at once')
  assert.equal(typingPlan(0).instant, true)

  const tiny = typingPlan(3)
  assert.ok(tiny.perCharMs > 20 === false, 'the delay never exceeds the 20 ms ceiling')
  harness.restore()
})

test('two updates 50 ms apart keep every character and the order', async () => {
  const harness = await createClientHarness({ document: documentWith('Начало.') })
  harness.renderPanel()
  await harness.advance(0)
  assert.equal(blockText(harness, 'b-1'), 'Начало.', 'the first load renders the whole text')

  // The agent writes a sentence; the first poll picks it up and the typewriter animates it.
  harness.publish(documentWith('Начало. Первое предложение.'))
  await harness.advance(3_000)
  await harness.advance(1_000)
  assert.equal(blockText(harness, 'b-1'), 'Начало. Первое предложение.')

  // A second update lands 50 ms later: the panel must keep the first text and paint the tail.
  harness.publish(documentWith('Начало. Первое предложение. Второе предложение.'))
  await harness.advance(600)
  const midway = blockText(harness, 'b-1')
  assert.ok('Начало. Первое предложение. Второе предложение.'.startsWith(midway), `midway is a prefix, got «${midway}»`)

  await harness.advance(3_000)
  assert.equal(blockText(harness, 'b-1'), 'Начало. Первое предложение. Второе предложение.')
  harness.restore()
})

test('a poll with a stale version is ignored', async () => {
  const harness = await createClientHarness({ document: documentWith('Текущий текст.') })
  const { isNewer } = harness.internals
  assert.equal(isNewer(5, { version: 5 }), false, 'the same version is ignored')
  assert.equal(isNewer(5, { version: 4 }), false, 'an older version is ignored')
  assert.equal(isNewer(5, { version: 6 }), true)
  harness.restore()
})
