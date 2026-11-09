/**
 * Guard 8 — `canvas_apply_edits` without a prepared batch is refused with PENDING_MISSING and the
 * document stays byte-identical. "Edits arrived out of nowhere" must never reach the text.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService, expectServiceError } from './support/service-harness.mjs'
import { createHost } from './support/host-harness.mjs'
import { expectCode } from './support/host-harness.mjs'

test('canvas_apply_edits without pending refuses and leaves the document intact', () => {
  const { service } = createService()
  service.write('Абзац с фрагментом для правки.')
  service.addComment({ blockId: 'b-1', from: 0, to: 5, note: 'замени' })
  const before = JSON.stringify(service.document)

  expectServiceError(() => service.applyEdits([{ commentId: 'c-1', replacement: 'Новое' }]), 'PENDING_MISSING')
  assert.equal(JSON.stringify(service.document), before)
  assert.equal(service.document.comments[0].status, 'open')
})

test('the canvas_apply_edits tool reports PENDING_MISSING through the contract error shape', async () => {
  const host = createHost()
  await expectCode(
    () => host.callTool('canvas_apply_edits', { edits: [{ commentId: 'c-1', replacement: 'x' }] }),
    'PENDING_MISSING',
  )
})
