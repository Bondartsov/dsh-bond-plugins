/**
 * Validator for the Peer Bus board v2, written from CONTRACT.md §1.
 *
 * The board is the only contract between the Host half and the browser half, so the tests treat
 * its shape as frozen: a field that disappears, changes type or collides by id is a failure.
 * Unknown extra fields are allowed (the contract keeps old fields and may grow), but every
 * documented field must be present and correctly typed.
 *
 * @typedef {{path: string, reason: string}} SchemaProblem
 */

const STATUS = new Set(['running', 'idle', 'closed'])
const ROLE = new Set(['master', 'worker'])
const THREAD_STATUS = new Set(['open', 'answered', 'closed'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isString = (value) => typeof value === 'string'
const isBoolean = (value) => typeof value === 'boolean'

/**
 * @param {SchemaProblem[]} problems - accumulator.
 * @param {string} path - location of the field.
 * @param {unknown} value - the inspected value.
 * @param {(value: unknown) => boolean} predicate - type predicate.
 * @param {string} expected - human-readable expectation.
 */
function check(problems, path, value, predicate, expected) {
  if (!predicate(value)) problems.push({ path, reason: `expected ${expected}, got ${describe(value)}` })
}

/** Describe a value for an error message, without ever throwing on a hostile value. */
function describe(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const type = typeof value
  if (type === 'number' && !Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `array(${value.length})`
  if (type === 'object') return 'object'
  if (type === 'string') return `string(${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)})`
  return type
}

/** Validate one claim entry of the board. */
function validateClaim(claim, path, problems) {
  if (!isObject(claim)) {
    problems.push({ path, reason: `expected claim object, got ${describe(claim)}` })
    return
  }
  // Claims are project-scoped (CONTRACT.md §1): the resource name alone is not the identity.
  check(problems, `${path}.project`, claim.project, isString, 'string (normalized project root)')
  check(problems, `${path}.projectName`, claim.projectName, isString, 'string (project display name)')
  check(problems, `${path}.resource`, claim.resource, isString, 'string')
  check(problems, `${path}.holder`, claim.holder, isString, 'string (session id)')
  check(problems, `${path}.holderName`, claim.holderName, isString, 'string')
  check(problems, `${path}.since`, claim.since, isFiniteNumber, 'finite number')
  check(problems, `${path}.expiresAt`, claim.expiresAt, isFiniteNumber, 'finite number')
  check(problems, `${path}.note`, claim.note, isString, 'string')
  if (isFiniteNumber(claim.since) && isFiniteNumber(claim.expiresAt) && claim.expiresAt < claim.since) {
    problems.push({ path: `${path}.expiresAt`, reason: 'expiresAt is earlier than since' })
  }
}

/** Validate one thread entry of the board. */
function validateThread(thread, path, problems) {
  if (!isObject(thread)) {
    problems.push({ path, reason: `expected thread object, got ${describe(thread)}` })
    return
  }
  check(problems, `${path}.id`, thread.id, isString, 'string')
  check(problems, `${path}.subject`, thread.subject, isString, 'string')
  check(problems, `${path}.status`, thread.status, (value) => isString(value) && THREAD_STATUS.has(value), 'open|answered|closed')
  check(problems, `${path}.from`, thread.from, isString, 'string (session id)')
  if (!(thread.to === null || isString(thread.to))) {
    problems.push({ path: `${path}.to`, reason: `expected string|null, got ${describe(thread.to)}` })
  }
  check(problems, `${path}.createdAt`, thread.createdAt, isFiniteNumber, 'finite number')
  check(problems, `${path}.lastAt`, thread.lastAt, isFiniteNumber, 'finite number')
  check(problems, `${path}.messages`, thread.messages, (value) => isFiniteNumber(value) && value >= 0, 'non-negative number')
}

/** Validate one node entry of the board. */
function validateNode(node, path, problems) {
  if (!isObject(node)) {
    problems.push({ path, reason: `expected node object, got ${describe(node)}` })
    return
  }
  check(problems, `${path}.id`, node.id, (value) => isString(value) && value !== '', 'non-empty string')
  check(problems, `${path}.short`, node.short, isString, 'string')
  check(problems, `${path}.name`, node.name, isString, 'string')
  check(problems, `${path}.status`, node.status, (value) => isString(value) && STATUS.has(value), 'running|idle|closed')
  check(problems, `${path}.role`, node.role, (value) => isString(value) && ROLE.has(value), 'master|worker')
  check(problems, `${path}.master`, node.master, isBoolean, 'boolean')
  check(problems, `${path}.subagent`, node.subagent, isBoolean, 'boolean')
  check(problems, `${path}.dnd`, node.dnd, isBoolean, 'boolean')
  check(problems, `${path}.intent`, node.intent, isString, 'string')
  check(problems, `${path}.last`, node.last, isString, 'string')
  if (!(node.parent === null || isString(node.parent))) {
    problems.push({ path: `${path}.parent`, reason: `expected string|null, got ${describe(node.parent)}` })
  }
  check(problems, `${path}.cwd`, node.cwd, isString, 'string')
  check(problems, `${path}.project`, node.project, isString, 'string')
  check(problems, `${path}.claims`, node.claims, (value) => Array.isArray(value) && value.every(isString), 'array of resource strings')
  check(problems, `${path}.openThreads`, node.openThreads, (value) => isFiniteNumber(value) && value >= 0, 'non-negative number')
  if (node.cost !== null && node.cost !== undefined) {
    if (!isObject(node.cost)) {
      problems.push({ path: `${path}.cost`, reason: `expected null or {total,currency}, got ${describe(node.cost)}` })
    } else {
      check(problems, `${path}.cost.total`, node.cost.total, isFiniteNumber, 'finite number')
      check(problems, `${path}.cost.currency`, node.cost.currency, isString, 'string')
    }
  } else if (node.cost === undefined) {
    problems.push({ path: `${path}.cost`, reason: 'expected null or {total,currency}, got undefined' })
  }
  if (isString(node.role) && isBoolean(node.master) && node.role !== (node.master ? 'master' : 'worker')) {
    problems.push({ path: `${path}.role`, reason: `role "${node.role}" contradicts master=${node.master}` })
  }
}

/**
 * Validate a whole board payload against CONTRACT.md §1.
 * @param {unknown} board - the board JSON as returned by `GET /peer-bus/board` or a tool.
 * @returns {SchemaProblem[]} every violation (empty when valid).
 */
export function collectBoardProblems(board) {
  /** @type {SchemaProblem[]} */
  const problems = []
  if (!isObject(board)) {
    problems.push({ path: '$', reason: `expected board object, got ${describe(board)}` })
    return problems
  }
  check(problems, '$.version', board.version, (value) => value === 2, 'version 2')
  check(problems, '$.updatedAt', board.updatedAt, isFiniteNumber, 'finite number')

  // projects
  if (!Array.isArray(board.projects)) {
    problems.push({ path: '$.projects', reason: `expected array, got ${describe(board.projects)}` })
  } else {
    board.projects.forEach((project, index) => {
      const path = `$.projects[${index}]`
      if (!isObject(project)) {
        problems.push({ path, reason: `expected project object, got ${describe(project)}` })
        return
      }
      check(problems, `${path}.root`, project.root, isString, 'string')
      if (!(project.master === null || isString(project.master))) {
        problems.push({ path: `${path}.master`, reason: `expected string|null, got ${describe(project.master)}` })
      }
    })
  }

  // claims
  if (!Array.isArray(board.claims)) {
    problems.push({ path: '$.claims', reason: `expected array, got ${describe(board.claims)}` })
  } else {
    board.claims.forEach((claim, index) => validateClaim(claim, `$.claims[${index}]`, problems))
    // One holder per (project, resource): the same name in two projects is two different claims.
    const keys = board.claims
      .filter(isObject)
      .map((claim) => `${claim.project}\u0000${claim.resource}`)
      .filter((key) => isString(key))
    for (const key of new Set(keys)) {
      if (keys.filter((value) => value === key).length > 1) {
        problems.push({ path: '$.claims', reason: `claim "${key.split('\u0000').join(' / ')}" is held more than once` })
      }
    }
  }

  // threads
  if (!Array.isArray(board.threads)) {
    problems.push({ path: '$.threads', reason: `expected array, got ${describe(board.threads)}` })
  } else {
    board.threads.forEach((thread, index) => validateThread(thread, `$.threads[${index}]`, problems))
    const ids = board.threads.filter(isObject).map((thread) => thread.id).filter(isString)
    for (const id of new Set(ids)) {
      if (ids.filter((value) => value === id).length > 1) {
        problems.push({ path: '$.threads', reason: `thread id "${id}" is not unique` })
      }
    }
  }

  // nodes
  if (!Array.isArray(board.nodes)) {
    problems.push({ path: '$.nodes', reason: `expected array, got ${describe(board.nodes)}` })
  } else {
    board.nodes.forEach((node, index) => validateNode(node, `$.nodes[${index}]`, problems))
    const ids = board.nodes.filter(isObject).map((node) => node.id).filter(isString)
    for (const id of new Set(ids)) {
      if (ids.filter((value) => value === id).length > 1) {
        problems.push({ path: '$.nodes', reason: `node id "${id}" is not unique` })
      }
    }
  }
  return problems
}

/**
 * Throw when a board payload violates the frozen v2 schema.
 * @param {unknown} board - the payload to validate.
 * @param {string} [label] - source of the payload, for the error message.
 * @returns {unknown} the payload, for chaining.
 */
export function assertBoardSchema(board, label = 'board') {
  const problems = collectBoardProblems(board)
  if (problems.length > 0) {
    const detail = problems
      .slice(0, 12)
      .map((problem) => `${problem.path}: ${problem.reason}`)
      .join('\n  ')
    throw new Error(`${label} violates the v2 schema:\n  ${detail}${problems.length > 12 ? `\n  (+${problems.length - 12} more)` : ''}`)
  }
  return board
}
