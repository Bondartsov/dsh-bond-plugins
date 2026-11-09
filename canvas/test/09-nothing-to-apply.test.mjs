/**
 * Guard 9 — `canvas_apply` with no open comments is refused with NOTHING_TO_APPLY, and no batch is
 * created (a batch would hold the lock for ten minutes).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService, expectServiceError } from './support/service-harness.mjs'
import { createHost, expectCode } from './support/host-harness.mjs'

test('canvas_apply without open comments refuses', () => {
  const { service } = createService()
  service.write('Текст без комментариев.')
  expectServiceError(() => service.apply({}), 'NOTHING_TO_APPLY')
  assert.equal(service.batch, null, 'a refused apply must not hold the lock')
})

test('canvas_apply ignores settled comments and refuses when none is open', () => {
  const { service } = createService()
  service.write('Абзац.')
  service.addComment({ blockId: 'b-1', from: 0, to: 5, note: 'x' })
  service.resolveComment('c-1')

  expectServiceError(() => service.apply({}), 'NOTHING_TO_APPLY')
})

test('the canvas_apply tool reports NOTHING_TO_APPLY', async () => {
  const host = createHost()
  await expectCode(() => host.callTool('canvas_apply', {}), 'NOTHING_TO_APPLY')
})
