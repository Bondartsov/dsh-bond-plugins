/**
 * Guard 10 — the three limits are refusals, never truncations:
 * 200 000 characters per document, 20 000 per `canvas_write`, 2 000 per quote.
 *
 * A silent cut is worse than an error: the person would comment on text the model never wrote.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService, expectServiceError } from './support/service-harness.mjs'
import { documentSize, LIMITS } from '../lib/model.js'

test('a canvas_write over 20 000 characters is refused without touching the document', () => {
  const { service } = createService()
  service.write('Первый абзац')
  const before = JSON.stringify(service.document)

  expectServiceError(() => service.write('а'.repeat(LIMITS.write + 1)), 'EDIT_TOO_LONG')
  assert.equal(JSON.stringify(service.document), before)
})

test('a quote over 2 000 characters is refused and the comment is not created', () => {
  const { service } = createService()
  service.write('я'.repeat(3_000))

  expectServiceError(() => service.addComment({ blockId: 'b-1', from: 0, to: LIMITS.quote + 1, note: 'длинно' }), 'QUOTE_TOO_LONG')
  assert.equal(service.document.comments.length, 0)
})

test('a document over 200 000 characters is refused with CANVAS_FULL', () => {
  const { service } = createService()
  // Ten writes of 19 000 characters stay under the per-call limit and reach 190 000.
  for (let index = 0; index < 10; index += 1) service.write('б'.repeat(19_000))
  assert.equal(documentSize(service.document), 190_000)

  expectServiceError(() => service.write('в'.repeat(15_000)), 'CANVAS_FULL')
  assert.equal(documentSize(service.document), 190_000, 'the refused text is not stored, not even partially')
  assert.equal(service.document.blocks.length, 10)
})
