/**
 * Guards 12–13 — the approximate and the orphaned end of re-anchoring.
 *
 * A quote whose words changed by a quarter is still recognisably the same fragment: it becomes
 * `approximate`, gets a pale highlight and its edit still applies. A quote that disappeared entirely
 * becomes `orphaned` with a reason and stays in the list — losing it is the one thing the canvas
 * must never do.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService } from './support/service-harness.mjs'
import { plainText } from '../lib/model.js'

test('guard 12: a 25 % word change makes the comment approximate, not orphaned', () => {
  const { service } = createService()
  const original = 'переносим встречу на завтра утром'
  service.write(original)
  service.addComment({ blockId: 'b-1', from: 0, to: original.length, note: 'переформулировать' })

  // One of five words changes: "утром" → "вечером" (80 % of the words still match).
  service.editBlock({ blockId: 'b-1', spans: [{ t: 'переносим встречу на завтра вечером' }] }, service.version)

  const comment = service.document.comments[0]
  assert.equal(comment.status, 'approximate', 'four of five words is still the same fragment')
  assert.equal(comment.reason, null)
  assert.equal(plainText(service.document.blocks[0]).slice(comment.from, comment.to).startsWith('переносим встречу на завтра'), true)
})

test('guard 13: deleting the fragment orphans the comment and keeps it in the list', () => {
  const { service } = createService()
  service.write('Уважаемый Иван Иванович, переносим встречу на завтра.')
  const from = 'Уважаемый Иван Иванович, '.length
  service.addComment({ blockId: 'b-1', from, to: from + 'переносим'.length, note: 'убрать' })

  service.editBlock({ blockId: 'b-1', spans: [{ t: 'Уважаемый Иван Иванович, встреча состоится завтра.' }] }, service.version)

  assert.equal(service.document.comments.length, 1, 'CONTRACT: the comment is never dropped')
  const comment = service.document.comments[0]
  assert.equal(comment.status, 'orphaned')
  assert.equal(comment.reason, 'фрагмент не найден в блоке')
  assert.equal(comment.quote, 'переносим', 'the original quote is preserved for re-attaching')
})
