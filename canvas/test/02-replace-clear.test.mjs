/**
 * Guard 2 — `canvas_replace` rewrites the document and orphans (never deletes) its comments;
 * `canvas_clear` refuses without `confirm: true` and records the deletion in the history.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService, expectServiceError } from './support/service-harness.mjs'

test('canvas_replace swaps every block and orphans the comments with the documented reason', () => {
  const { service } = createService()
  service.write('Первый абзац про перенос встречи.')
  service.addComment({ blockId: 'b-1', from: 0, to: 6, note: 'короче' })

  const result = service.replace('# Новый документ\n\nСовсем другой текст.')
  assert.equal(result.blocks, 2)
  assert.deepEqual(
    service.document.blocks.map((block) => block.type),
    ['h1', 'p'],
  )
  assert.equal(service.document.comments.length, 1, 'the comment is kept')
  assert.equal(service.document.comments[0].status, 'orphaned')
  assert.equal(service.document.comments[0].reason, 'документ перезаписан')
  assert.equal(service.document.comments[0].quote, 'Первый', 'the quote survives the rewrite')
})

test('canvas_clear without confirm refuses and changes nothing', () => {
  const { service } = createService()
  service.write('Текст, который должен остаться.')
  const before = JSON.stringify(service.document)

  expectServiceError(() => service.clear(false), 'INVALID_TEXT')
  assert.equal(JSON.stringify(service.document), before, 'a refused clear must not touch the document')
  assert.equal(service.document.blocks.length, 1)
})

test('canvas_clear with confirm empties blocks and comments and writes the history entry', () => {
  const { service } = createService()
  service.write('Абзац.\n\nВторой абзац.')
  service.addComment({ blockId: 'b-1', from: 0, to: 5, note: 'заметка' })

  service.clear(true)
  assert.equal(service.document.blocks.length, 0)
  assert.equal(service.document.comments.length, 0)

  const history = service.store.readHistory(service.document.id)
  const clear = history.entries.find((entry) => entry.op === 'clear')
  assert.ok(clear !== undefined, 'CONTRACT: clearing must be recorded in the history')
  assert.equal(clear.summary, 'документ очищен')
})
