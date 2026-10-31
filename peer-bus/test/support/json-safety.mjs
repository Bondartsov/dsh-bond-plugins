/**
 * Lossless-JSON validation, shared by every test.
 *
 * The Harness tool-output pipeline rejects a result that is not lossless JSON. The rule is
 * recursive: `undefined`, `NaN`/`Infinity`, functions, symbols, bigints, cycles and non-plain
 * objects (Map, Set, Date, class instances) are all failures at any nesting depth.
 *
 * @typedef {{path: string, reason: string}} JsonProblem
 */

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Walk a value and collect every lossless-JSON violation.
 * @param {unknown} value - the value to inspect.
 * @param {string} [path] - human-readable location used in the report.
 * @param {WeakSet<object>} [seen] - cycle detector.
 * @returns {JsonProblem[]} all violations found (empty when the value is safe).
 */
export function collectJsonProblems(value, path = 'value', seen = new WeakSet()) {
  /** @type {JsonProblem[]} */
  const problems = []
  const type = typeof value
  if (value === undefined) {
    problems.push({ path, reason: 'undefined' })
    return problems
  }
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    problems.push({ path, reason: type })
    return problems
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) problems.push({ path, reason: `non-finite number ${String(value)}` })
    return problems
  }
  if (type !== 'object' || value === null) return problems

  if (seen.has(value)) {
    problems.push({ path, reason: 'cycle' })
    return problems
  }
  seen.add(value)

  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...collectJsonProblems(item, `${path}[${index}]`, seen)))
    seen.delete(value)
    return problems
  }
  if (!isPlainObject(value)) {
    const name = value.constructor?.name ?? 'non-plain object'
    problems.push({ path, reason: `non-plain object (${name})` })
    return problems
  }
  for (const [key, nested] of Object.entries(value)) {
    problems.push(...collectJsonProblems(nested, `${path}.${key}`, seen))
  }
  seen.delete(value)
  return problems
}

/**
 * Throw a descriptive error when a value is not lossless JSON.
 * @param {unknown} value - the value to validate.
 * @param {string} [label] - what is being validated (a tool name, a route body).
 * @returns {unknown} the value, for chaining.
 */
export function assertLosslessJson(value, label = 'value') {
  const problems = collectJsonProblems(value, label)
  if (problems.length > 0) {
    const detail = problems
      .slice(0, 8)
      .map((problem) => `${problem.path} is ${problem.reason}`)
      .join('; ')
    throw new Error(`${label} is not lossless JSON: ${detail}${problems.length > 8 ? ` (+${problems.length - 8} more)` : ''}`)
  }
  return value
}
