/**
 * Guards 3–7 — applying touches exactly the commented ranges and refuses everything else.
 *
 * The point of the canvas is that the rest of the document is not "approximately" preserved: every
 * block nobody commented on must keep the same SHA-256, two edits in one block must not shift each
 * other, and a replacement that smuggles in the surrounding text, empties the fragment, repeats the
 * quote or grows past the limit must become `conflict` with a reason instead of a silent write.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService } from './support/service-harness.mjs'

/**
 * Prepare a batch the model way and hand the edits back.
 * @param {object} service - the service.
 * @param {{commentId: string, replacement: string}[]} edits - the proposals.
 * @returns {object} the pending view.
 */
function prepare(service, edits) {
  service.apply({})
  service.applyEdits(edits)
  return service.pending()
}

test('guard 3: only the commented block changes; the others keep their SHA-256', () => {
  const { service } = createService()
  service.write('Первый абзац остаётся как есть.\n\nВторой абзац, который правим.\n\nТретий абзац тоже цел.')
  const before = service.hashes()
  service.addComment({ blockId: 'b-2', from: 0, to: 6, note: 'короче' })

  prepare(service, [{ commentId: 'c-1', replacement: 'Иной' }])
  service.commit({ batchId: service.batch.id, accept: [] })

  const after = service.hashes()
  assert.equal(after['b-1'], before['b-1'], 'CONTRACT: an untouched block keeps its hash')
  assert.equal(after['b-3'], before['b-3'], 'CONTRACT: an untouched block keeps its hash')
  assert.notEqual(after['b-2'], before['b-2'], 'the commented block changed')
  assert.equal(service.document.blocks[1].spans.map((span) => span.t).join(''), 'Иной абзац, который правим.')
})

test('guard 4: two edits of one block apply from the highest `to` down', () => {
  const { service } = createService()
  service.write('abcdefghij')
  service.addComment({ blockId: 'b-1', from: 2, to: 4, note: 'первая' })
  service.addComment({ blockId: 'b-1', from: 6, to: 8, note: 'вторая' })

  prepare(service, [
    { commentId: 'c-1', replacement: 'X' },
    { commentId: 'c-2', replacement: 'Y' },
  ])
  const result = service.commit({ batchId: service.batch.id, accept: [] })

  assert.equal(result.applied, 2)
  assert.equal(service.document.blocks[0].spans.map((span) => span.t).join(''), 'abXefYij')
  assert.deepEqual(
    service.document.comments.map((comment) => comment.status),
    ['applied', 'applied'],
  )
})

test('guard 5: overlapping edits refuse the second one and leave the document intact', () => {
  const { service } = createService()
  service.write('abcdefghij')
  service.addComment({ blockId: 'b-1', from: 2, to: 6, note: 'широкая' })
  service.addComment({ blockId: 'b-1', from: 4, to: 8, note: 'пересекается' })

  prepare(service, [
    { commentId: 'c-1', replacement: 'X' },
    { commentId: 'c-2', replacement: 'Y' },
  ])
  const result = service.commit({ batchId: service.batch.id, accept: [] })

  assert.equal(result.applied, 1, 'only one of the pair is applied')
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].commentId, 'c-1')
  assert.match(result.conflicts[0].reason, /пересекается/)
  const statuses = service.document.comments.map((comment) => comment.status).sort()
  assert.deepEqual(statuses, ['applied', 'conflict'])
  assert.equal(service.document.blocks[0].spans.map((span) => span.t).join(''), 'abcdYij')
})

test('guard 6: an empty or quote-equal replacement is a conflict', () => {
  const { service } = createService()
  service.write('переносим встречу на завтра')
  service.addComment({ blockId: 'b-1', from: 0, to: 9, note: 'пустая' })
  service.addComment({ blockId: 'b-1', from: 10, to: 17, note: 'та же цитата' })

  prepare(service, [
    { commentId: 'c-1', replacement: '' },
    { commentId: 'c-2', replacement: 'встречу' },
  ])
  const result = service.commit({ batchId: service.batch.id, accept: [] })

  assert.equal(result.applied, 0)
  const reasons = result.conflicts.map((entry) => entry.reason)
  assert.ok(reasons.includes('пустая правка'), `reasons: ${reasons.join(' | ')}`)
  assert.ok(reasons.includes('правка совпадает с цитатой'), `reasons: ${reasons.join(' | ')}`)
  assert.equal(service.document.blocks[0].spans.map((span) => span.t).join(''), 'переносим встречу на завтра')
})

test('guard 7: a replacement containing the text around the range is a conflict', () => {
  const { service } = createService()
  const text = 'Первый абзац, который правим, и хвост документа.'
  service.write(text)
  service.addComment({ blockId: 'b-1', from: 0, to: 6, note: 'только «Первый»' })

  prepare(service, [{ commentId: 'c-1', replacement: text }])
  const result = service.commit({ batchId: service.batch.id, accept: [] })

  assert.equal(result.applied, 0)
  assert.match(result.conflicts[0].reason, /выходит за границы/)
  assert.equal(service.document.blocks[0].spans.map((span) => span.t).join(''), text)
})
