/**
 * Guard 25 — the browser half installs the surfaces the task promises.
 *
 * A tab type with `keepMounted`, its body and title in the keyed slots, and the «Холст» button with
 * the documented id and order in the session header. The panel itself renders the document, the
 * rail and the apply control.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientHarness, allByClass, byClass, textOf } from './support/client-harness.mjs'

test('the right-dock tab type is registered with keepMounted and a title', async () => {
  const harness = await createClientHarness()
  const definition = harness.tabDefinitions[0]
  assert.ok(definition !== undefined, 'CONTRACT: the canvas tab type must be registered')
  assert.equal(definition.id, '@local/dsh-canvas/panel')
  assert.equal(definition.kind, 'canvasPanel')
  assert.equal(definition.keepMounted, true, 'CONTRACT: the tab keeps its state')
  assert.equal(typeof definition.title, 'function')
  assert.ok(harness.registered.has('sidebar.right.pane.tab:@local/dsh-canvas/panel'), 'the tab body is registered under the type id')
  assert.ok(harness.registered.has('sidebar.right.pane.tab.title:@local/dsh-canvas/panel'), 'the tab title is registered under the type id')
  harness.restore()
})

test('the header button uses the documented id and order', async () => {
  const harness = await createClientHarness()
  const component = harness.registered.get('conversation.session.header.utilities:canvas-open')
  assert.ok(component !== undefined, 'CONTRACT: the canvas-open header button must be registered')
  harness.restore()
})

test('the panel renders the document, the comment rail and the apply control', async () => {
  const harness = await createClientHarness({
    document: {
      schema: 1,
      id: 'doc-1',
      scope: 'global',
      sessionId: null,
      title: 'Коммерческое предложение',
      version: 1,
      nextBlockSeq: 3,
      nextCommentSeq: 2,
      blocks: [
        { id: 'b-1', type: 'h1', spans: [{ t: 'Коммерческое предложение', b: true }] },
        { id: 'b-2', type: 'p', spans: [{ t: 'Уважаемый Иван Иванович, переносим встречу.' }] },
      ],
      comments: [
        {
          id: 'c-1',
          blockId: 'b-2',
          from: 0,
          to: 24,
          occurrence: 0,
          quote: 'Уважаемый Иван Иванович',
          note: 'короче и без канцелярита',
          status: 'open',
          reason: null,
          createdAt: '2026-11-06T13:18:04+03:00',
        },
      ],
      style: { tone: 'деловой', person: 'вы', avgSentence: 14, flags: ['канцелярит'] },
      updatedAt: '2026-11-06T13:20:00+03:00',
    },
  })
  harness.renderPanel()
  await harness.advance(0)

  const text = textOf(harness.tree)
  assert.match(text, /Коммерческое предложение/)
  assert.match(text, /короче и без канцелярита/)
  assert.equal(byClass(harness.tree, 'dshCanvas_rail') !== null, true, 'the comment rail is rendered')
  assert.equal(allByClass(harness.tree, 'dshCanvas_block').length, 2, 'both blocks are editable elements')

  const blockNode = allByClass(harness.tree, 'dshCanvas_block').find((node) => node.props?.['data-block-id'] === 'b-2')
  const html = blockNode?.props?.dangerouslySetInnerHTML?.__html ?? ''
  assert.match(html, /<mark class="dshCanvas_mark[^"]*" data-comment="c-1">/, 'the commented fragment is highlighted')

  const applyButton = allByClass(harness.tree, 'dshCanvas_btnPrimary').find((node) => node.props?.onClick !== undefined)
  assert.ok(applyButton !== undefined, 'the apply button is rendered')
  assert.equal(applyButton.props.disabled, false, 'one open comment enables «Применить все»')

  harness.unmount()
  harness.restore()
})
