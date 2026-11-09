/**
 * Guard 24 — the tab owns no timer after it is unmounted.
 *
 * The panel polls, animates and debounces writes. Every one of those is created inside an effect
 * whose cleanup clears it, and the right-dock tab can be closed at any moment. A leaked timer would
 * keep the whole Host page busy and, worse, keep polling a document nobody looks at.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientHarness } from './support/client-harness.mjs'

test('unmounting the panel leaves no timer and no visibility listener', async () => {
  const harness = await createClientHarness()
  harness.renderPanel()
  await harness.advance(100)

  assert.ok(harness.timerCount() > 0, 'the mounted panel must be polling')
  assert.equal(harness.listenerCount('visibilitychange'), 1)

  harness.unmount()
  assert.equal(harness.timerCount(), 0, 'CONTRACT: no scheduled callback survives the unmount')
  assert.equal(harness.intervalCount(), 0, 'CONTRACT: no interval survives the unmount')
  assert.equal(harness.listenerCount('visibilitychange'), 0, 'the visibility listener is removed')

  // Nothing wakes up later either.
  await harness.advance(60_000)
  assert.equal(harness.timerCount(), 0)
  harness.restore()
})

test('a hidden tab stops polling and resumes when it is visible again', async () => {
  const harness = await createClientHarness()
  harness.renderPanel()
  await harness.advance(100)

  globalThis.document.visibilityState = 'hidden'
  harness.emit('visibilitychange')
  harness.host.requests.length = 0
  await harness.advance(10_000)
  const whileHidden = harness.host.requests.filter((entry) => entry.url === '/canvas/doc')
  assert.equal(whileHidden.length, 0, 'CONTRACT: a hidden tab must not poll the document')

  globalThis.document.visibilityState = 'visible'
  harness.emit('visibilitychange')
  await harness.advance(10)
  const afterVisible = harness.host.requests.filter((entry) => entry.url === '/canvas/doc')
  assert.ok(afterVisible.length > 0, 'the poll resumes when the tab becomes visible')

  harness.unmount()
  harness.restore()
})
