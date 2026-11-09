/**
 * Guard 11 — re-anchoring steps 1 and 2: an edit *around* a comment keeps it, and a change of case
 * or whitespace still finds the fragment. The canvas never silently loses a comment.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService } from './support/service-harness.mjs'
import { plainText } from '../lib/model.js'

/**
 * Replace a block's text wholesale, the way the editor does on blur.
 * @param {object} service - the service under test.
 * @param {string} blockId - the block.
 * @param {string} text - the new text.
 */
function retype(service, blockId, text) {
  service.editBlock({ blockId, spans: [{ t: text }] }, service.version)
}

test('step 1: an edit above the quote moves the offsets and keeps the comment open', () => {
  const { service } = createService()
  const original = 'Уважаемый Иван Иванович, переносим встречу на завтра.'
  service.write(original)
  const from = original.indexOf('переносим')
  const comment = service.addComment({ blockId: 'b-1', from, to: from + 'переносим'.length, note: 'короче' })
  assert.equal(comment.quote, 'переносим')

  const updated = 'Дорогой Иван Иванович, переносим встречу на завтра.'
  retype(service, 'b-1', updated)

  const after = service.document.comments[0]
  const shifted = updated.indexOf('переносим')
  assert.equal(after.status, 'open')
  assert.equal(after.reason, null)
  assert.equal(after.from, shifted)
  assert.equal(after.to, shifted + 'переносим'.length)
  assert.equal(after.quote, 'переносим')
  assert.equal(service.document.comments.length, 1, 'the comment is not duplicated')
})

test('step 2: a change of case is found by the normalized search', () => {
  const { service } = createService()
  service.write('Переносим встречу на завтра.')
  service.addComment({ blockId: 'b-1', from: 0, to: 'Переносим'.length, note: 'ниже регистром' })

  retype(service, 'b-1', 'переносим встречу на завтра.')

  const after = service.document.comments[0]
  assert.equal(after.status, 'open', 'exact search fails, the normalized one must succeed')
  assert.equal(plainText(service.document.blocks[0]).slice(after.from, after.to), 'переносим')
})

test('step 2: a different whitespace run is found by the normalized search', () => {
  const { service } = createService()
  service.write('переносим  встречу на завтра')
  service.addComment({ blockId: 'b-1', from: 0, to: 'переносим  встречу'.length, note: 'лишний пробел' })

  retype(service, 'b-1', 'переносим встречу на завтра')

  const after = service.document.comments[0]
  assert.notEqual(after.status, 'orphaned')
  assert.equal(plainText(service.document.blocks[0]).slice(after.from, after.to), 'переносим встречу')
})
