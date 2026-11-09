/**
 * Error vocabulary of the Canvas plugin.
 *
 * One closed list of codes, shared by the model-facing tools and the HTTP routes. A tool error is
 * always `<CODE>: <hint>`; a route error body is always `{ code, hint }`. Nothing here invents a
 * code at the call site — a typo in a code is a contract break, so every code is listed in
 * {@link CODES} and the tests assert the list.
 */

/** Every code this plugin may report, frozen by CONTRACT in the task statement. */
export const CODES = Object.freeze([
  'CANVAS_FULL',
  'INVALID_TEXT',
  'UNKNOWN_BLOCK',
  'UNKNOWN_COMMENT',
  'NOTHING_TO_APPLY',
  'PENDING_MISSING',
  'APPLY_IN_PROGRESS',
  'EDIT_TOO_LONG',
  'QUOTE_TOO_LONG',
  'STALE_VERSION',
  'NO_SESSION',
  'UNKNOWN_DOC',
  'UNKNOWN_BATCH',
])

/** A refusal that already knows its contract code. */
export class CanvasError extends Error {
  /**
   * @param {string} code - one of {@link CODES}.
   * @param {string} hint - a short instruction for the caller, no trailing period.
   */
  constructor(code, hint) {
    super(`${code}: ${hint}`)
    this.name = 'CanvasError'
    this.code = code
    this.hint = hint
  }
}

/**
 * Throw a contract error.
 * @param {string} code - one of {@link CODES}.
 * @param {string} hint - what the caller should do instead.
 * @returns {never} always throws.
 */
export function fail(code, hint) {
  throw new CanvasError(code, hint)
}

/**
 * Turn any thrown value into the route error body.
 * @param {unknown} error - the caught value.
 * @returns {{code: string, hint: string}} the body a route answers with.
 */
export function errorBody(error) {
  if (error instanceof CanvasError) return { code: error.code, hint: error.hint }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'FAILED', hint: message }
}
