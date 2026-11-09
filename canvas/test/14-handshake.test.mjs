/**
 * Guards 14–19 and 23 — the apply handshake and `If-Match`.
 *
 * 14: a rewrite orphans every comment, a clear deletes them and leaves a history entry.
 * 15: cancelling an application restores the document byte for byte and re-opens the comments.
 * 16: a repeated commit of the same batch applies once.
 * 17: a batch nobody answered expires after ten minutes and fails its comments.
 * 18: a partial answer applies what came and fails the rest with a reason.
 * 19: both drift rules turn an edit into `conflict: "дрейф стиля"`.
 * 23: `If-Match` accepts `12` and `"12"`, and refuses another version.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService, expectServiceError, readDocumentFile } from './support/service-harness.mjs'
import { parseIfMatch } from '../lib/service.js'

/**
 * Prepare a batch and return it.
 * @param {object} service - the service.
 * @param {{commentId: string, replacement: string}[]} edits - the proposals.
 */
function prepare(service, edits) {
  service.apply({})
  service.applyEdits(edits)
  return service.batch
}

test('guard 14: replace orphans every comment and clear deletes them with a history entry', () => {
  const { service } = createService()
  service.write('Первый абзац.\n\nВторой абзац.')
  service.addComment({ blockId: 'b-1', from: 0, to: 6, note: 'первый' })
  service.addComment({ blockId: 'b-2', from: 0, to: 6, note: 'второй' })

  service.replace('# Другой документ')
  assert.equal(service.document.comments.length, 2, 'a rewrite keeps the comments')
  assert.deepEqual(
    service.document.comments.map((comment) => [comment.status, comment.reason]),
    [
      ['orphaned', 'документ перезаписан'],
      ['orphaned', 'документ перезаписан'],
    ],
  )

  service.clear(true)
  assert.equal(service.document.comments.length, 0)
  const history = service.store.readHistory(service.document.id)
  assert.ok(history.entries.some((entry) => entry.op === 'clear'), 'clearing is recorded')
})

test('guard 15: cancelling a commit restores the document byte for byte and re-opens the comments', () => {
  const harness = createService()
  const { service } = harness
  service.write('Уважаемый Иван Иванович, переносим встречу на завтра.')
  const from = 'Уважаемый Иван Иванович, '.length
  service.addComment({ blockId: 'b-1', from, to: from + 'переносим'.length, note: 'короче' })
  harness.store.flush()
  const before = readDocumentFile(harness)
  const anchor = { from: service.document.comments[0].from, to: service.document.comments[0].to }

  prepare(service, [{ commentId: 'c-1', replacement: 'сдвигаем' }])
  const committed = service.commit({ batchId: service.batch.id, accept: [] })
  assert.equal(committed.applied, 1)
  assert.notEqual(readDocumentFile(harness), before, 'the commit changed the file')

  service.discard({ batchId: committed.batchId })
  assert.equal(readDocumentFile(harness), before, 'CONTRACT: undo restores the exact bytes')
  const comment = service.document.comments[0]
  assert.equal(comment.status, 'open')
  assert.equal(comment.reason, null)
  assert.deepEqual({ from: comment.from, to: comment.to }, anchor, 'the anchor is recalculated to the original')
})

test('guard 16: a repeated commit of the same batch applies once', () => {
  const { service } = createService()
  service.write('Абзац с фрагментом.')
  service.addComment({ blockId: 'b-1', from: 0, to: 5, note: 'замени' })
  prepare(service, [{ commentId: 'c-1', replacement: 'Текст' }])

  const first = service.commit({ batchId: service.batch.id, accept: [] })
  const version = service.version
  const second = service.commit({ batchId: first.batchId, accept: [] })

  assert.equal(second.version, first.version)
  assert.equal(service.version, version, 'CONTRACT: a double click must not apply twice')
  assert.equal(service.document.blocks[0].spans.map((span) => span.t).join(''), 'Текст с фрагментом.')
})

test('guard 17: a batch older than ten minutes fails its comments and clears itself', () => {
  const harness = createService()
  const { service } = harness
  service.write('Абзац для правки.')
  service.addComment({ blockId: 'b-1', from: 0, to: 5, note: 'правка' })
  prepare(service, [{ commentId: 'c-1', replacement: 'Другой' }])

  harness.advance(10 * 60 * 1000 + 1_000)
  assert.equal(service.pending(), null, 'the pending set is gone')
  assert.equal(service.batch, null)
  const comment = service.document.comments[0]
  assert.equal(comment.status, 'failed')
  assert.equal(comment.reason, 'модель не ответила')
})

test('guard 18: three of five edits apply, the missing two fail with a reason', () => {
  const { service } = createService()
  service.write('Первый.\n\nВторой.\n\nТретий.\n\nЧетвёртый.\n\nПятый.')
  for (const id of ['b-1', 'b-2', 'b-3', 'b-4', 'b-5']) {
    service.addComment({ blockId: id, from: 0, to: 5, note: `правим ${id}` })
  }
  prepare(service, [
    { commentId: 'c-1', replacement: 'Один' },
    { commentId: 'c-2', replacement: 'Два' },
    { commentId: 'c-3', replacement: 'Три' },
  ])
  const result = service.commit({ batchId: service.batch.id, accept: [] })

  assert.equal(result.applied, 3)
  assert.equal(result.conflicts.length, 2)
  assert.deepEqual(
    result.conflicts.map((entry) => [entry.status, entry.reason]),
    [
      ['failed', 'модель не вернула правку'],
      ['failed', 'модель не вернула правку'],
    ],
  )
  assert.deepEqual(
    service.document.comments.map((comment) => comment.status),
    ['applied', 'applied', 'applied', 'failed', 'failed'],
  )
})

test('guard 19: a new emoji is a style drift conflict', () => {
  const { service } = createService()
  service.write('Переносим встречу на завтра.')
  service.addComment({ blockId: 'b-1', from: 0, to: 9, note: 'короче' })
  prepare(service, [{ commentId: 'c-1', replacement: 'Отлично 😀' }])
  const result = service.commit({ batchId: service.batch.id, accept: [] })

  assert.equal(result.applied, 0)
  assert.equal(result.conflicts[0].reason, 'дрейф стиля')
  assert.equal(service.document.comments[0].status, 'conflict')
})

test('guard 19: a fragment that grows more than 2.5× is a style drift conflict', () => {
  const { service } = createService()
  service.write('переносим встречу на завтра')
  service.addComment({ blockId: 'b-1', from: 0, to: 9, note: 'переписать' })
  // 9 characters × 2.5 = 22.5, so 41 characters trips the rule while staying under the 50 limit.
  prepare(service, [{ commentId: 'c-1', replacement: 'переносим нашу с вами встречу завтра утром' }])
  const result = service.commit({ batchId: service.batch.id, accept: [] })

  assert.equal(result.applied, 0)
  assert.equal(result.conflicts[0].reason, 'дрейф стиля')
})

test('guard 23: If-Match accepts 12 and "12", and refuses another version', () => {
  const { service } = createService()
  service.write('Абзац для правки.')

  assert.equal(parseIfMatch(12), 12)
  assert.equal(parseIfMatch('12'), 12)
  assert.equal(parseIfMatch('"12"'), 12)
  assert.equal(parseIfMatch('W/"12"'), 12)
  assert.equal(parseIfMatch('12abc'), null)

  const start = service.version
  const numeric = service.editBlock({ blockId: 'b-1', spans: [{ t: 'Абзац раз.' }] }, start)
  assert.equal(numeric.version, start + 1)
  const quoted = service.editBlock({ blockId: 'b-1', spans: [{ t: 'Абзац два.' }] }, `"${start + 1}"`)
  assert.equal(quoted.version, start + 2)

  const before = JSON.stringify(service.document)
  expectServiceError(() => service.editBlock({ blockId: 'b-1', spans: [{ t: 'Поздно.' }] }, start), 'STALE_VERSION')
  assert.equal(JSON.stringify(service.document), before, 'a stale write must not touch the document')
})
