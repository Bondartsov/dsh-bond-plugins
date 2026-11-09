/**
 * Service-level harness: one CanvasService over a throwaway profile directory.
 *
 * The plugin's state lives inside `apply()`, so every harness builds its own document, its own
 * store and its own clock — no test can leak a batch, a version or a comment into another one.
 * The clock is frozen by default, so TTL and timestamp assertions do not depend on wall time.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../../lib/store.js'
import { CanvasService } from '../../lib/service.js'

/**
 * Build one service with an isolated root.
 * @param {{now?: number, debounceMs?: number}} [options] - the initial clock.
 * @returns {{service: object, store: object, root: string, advance: Function, clock: Function}} the harness.
 */
export function createService(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'canvas-test-'))
  let clock = options.now ?? Date.parse('2026-11-06T10:20:00+03:00')
  const now = () => new Date(clock)
  const store = new CanvasStore({
    root: join(root, 'canvas'),
    now,
    debounceMs: options.debounceMs ?? 400,
  })
  const service = new CanvasService({
    store,
    now,
    productsDirectory: () => join(root, 'products'),
  })
  return {
    service,
    store,
    root,
    profileRoot: join(root, 'canvas'),
    advance(milliseconds) {
      clock += milliseconds
      return clock
    },
    clock: () => clock,
  }
}

/**
 * A stable JSON snapshot for "the document did not change" assertions.
 * @param {object} value - any JSON value.
 * @returns {string} its canonical text.
 */
export function freeze(value) {
  return JSON.stringify(value)
}

/**
 * Assert that a call throws one contract code.
 * @param {Function} factory - the synchronous call.
 * @param {string} code - the expected code.
 * @returns {Error} the caught error.
 */
export function expectServiceError(factory, code) {
  try {
    factory()
  } catch (error) {
    if (error?.code !== code) throw new Error(`expected ${code}, got: ${error?.message ?? String(error)}`)
    return error
  }
  throw new Error(`expected ${code}, but the call succeeded`)
}

/**
 * Read one document file as text, so a test can compare bytes.
 * @param {object} harness - the service harness.
 * @returns {string} the file contents.
 */
export function readDocumentFile(harness) {
  return readFileSync(harness.store.paths(harness.service.document.id).document, 'utf8')
}
