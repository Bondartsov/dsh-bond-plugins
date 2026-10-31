#!/usr/bin/env node
/**
 * Mutation testing for the Peer Bus Host half (CONTRACT.md §6).
 *
 * The suite proves the current behaviour; a mutation run proves the suite can *fail*. Each mutant
 * is one small, semantically meaningful break of `index.js` (a flipped comparison, a removed
 * guard, a changed constant). A mutant that the suite does not notice is a surviving mutant — a
 * hole in the tests.
 *
 * Safety, in this order:
 * 1. the original file is read into memory and copied to a temporary backup outside the repo;
 * 2. every mutant is written only if the file still has the expected hash (no concurrent editor);
 * 3. the original bytes are restored in a `finally` block (also on SIGINT);
 * 4. the restored file is verified by SHA-256 against the original hash;
 * 5. the suite is run once more on the restored file — the final state must be green.
 *
 * Usage:
 *   node test/mutation.mjs                 # run every mutant
 *   node test/mutation.mjs --list          # list mutants, touch nothing
 *   node test/mutation.mjs --only claim    # run mutants whose id contains "claim"
 *   node test/mutation.mjs --keep-going    # exit 0 even with survivors (CI report mode)
 *
 * Exit code: 0 when every applicable mutant was killed and the final run is green, 1 otherwise.
 */
import { createHash } from 'node:crypto'
import { closeSync, copyFileSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const indexPath = join(packageRoot, 'index.js')

/**
 * One mutant: a textual replacement of a fragment that exists exactly once in `index.js`.
 * `find` is a literal fragment (not a regex) so a rename in the source fails loudly instead of
 * silently mutating the wrong place.
 *
 * @typedef {{id: string, why: string, find: string, replace: string}} Mutant
 * @type {Mutant[]}
 */
const MUTANTS = [
  {
    id: 'spawn-budget-constant',
    why: 'the rolling-hour spawn budget is no longer enforced at 5',
    find: 'const SPAWN_BUDGET = 5',
    replace: 'const SPAWN_BUDGET = 500',
  },
  {
    id: 'rate-limit-constant',
    why: 'the 5-messages-per-minute limit is effectively removed',
    find: 'const RATE_MAX = 5',
    replace: 'const RATE_MAX = 500',
  },
  {
    id: 'duplicate-window-disabled',
    why: 'the 30 s duplicate-text window is disabled',
    find: 'const DUPLICATE_MS = 30_000',
    replace: 'const DUPLICATE_MS = 0',
  },
  {
    id: 'claim-default-ttl-changed',
    why: 'the default claim TTL is no longer 900 s',
    find: 'const CLAIM_TTL_S = 900',
    replace: 'const CLAIM_TTL_S = 90_000',
  },
  {
    id: 'claim-expiry-never',
    why: 'an expired claim is no longer treated as expired (a crash would block the resource forever)',
    find: 'if (claim.expiresAt <= Date.now()) {',
    replace: 'if (claim.expiresAt < 0) {',
  },
  {
    id: 'claim-expiry-prune-disabled',
    why: 'the claim sweeper never drops expired claims',
    find: 'for (const [key, claim] of claims) if (claim.expiresAt <= now) claims.delete(key)',
    replace: 'for (const [key, claim] of claims) if (false) claims.delete(key)',
  },
  {
    id: 'claim-key-ignores-project',
    why: 'claims are no longer project-scoped: the same resource name in two projects collides',
    find: 'const claimKey = (project, resource) => `${project}\\u0000${resource}`',
    replace: 'const claimKey = (project, resource) => resource',
  },
  {
    id: 'legacy-claim-without-project-accepted',
    why: 'a state-file claim without a project is attributed to some project instead of being ignored',
    find: "if (typeof claim.project !== 'string' || claim.project.trim() === '') continue",
    replace: 'if (false) continue',
  },
  {
    id: 'dnd-downgrade-removed',
    why: 'a do-not-disturb peer is woken as if it had no dnd flag',
    find: "if (dnd.has(target.id) || target.dnd === true) return { mode: 'silent', downgraded: true }",
    replace: 'if (false) return { mode: \'silent\', downgraded: true }',
  },
  {
    id: 'master-subagent-guard-removed',
    why: 'a delegated subagent may hold the workspace master role',
    find: "if (claim && self.subagent) fail('BAD_ARGUMENT', 'a delegated subagent session cannot hold the workspace master role')",
    replace: "if (false) fail('BAD_ARGUMENT', 'a delegated subagent session cannot hold the workspace master role')",
  },
  {
    id: 'board-version-downgraded',
    why: 'the board route still answers version: 1',
    find: '      version: 2,\n      master,',
    replace: '      version: 1,\n      master,',
  },
  {
    id: 'origin-guard-removed',
    why: 'a cross-site request (foreign sec-fetch-site) is accepted',
    find: "return String(site).trim().toLowerCase() === 'same-origin'",
    replace: 'return true',
  },
  {
    id: 'content-type-guard-removed',
    why: 'POST /peer-bus/master accepts a non-JSON body',
    find: "if (!type.startsWith('application/json')) {",
    replace: 'if (false) {',
  },
  {
    id: 'sanitize-disabled',
    why: 'control and zero-width characters reach the prompt instead of being stripped',
    find: 'const CONTROL_CHARS = /[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]/g',
    replace: 'const CONTROL_CHARS = /(?!)/g',
  },
  {
    id: 'thread-answer-not-recorded',
    why: 'an explicit answer no longer moves the thread to answered',
    find: "if (kind === 'answer' && thread.status === THREAD_OPEN) thread.status = THREAD_ANSWERED",
    replace: "if (false) thread.status = THREAD_ANSWERED",
  },
]

/** SHA-256 of a buffer. */
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Every test file, so a mutant is judged by the whole suite. */
function testFiles() {
  return readdirSync(here)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(here, name))
}

/** Run the whole suite, capturing its TAP report into a file (no pipes: the sandbox never matters). */
function runSuiteCaptured(reportPath) {
  const fd = openSync(reportPath, 'w')
  const started = Date.now()
  try {
    const result = spawnSync(process.execPath, ['--test', ...testFiles()], {
      cwd: packageRoot,
      stdio: ['ignore', fd, fd],
    })
    return { status: result.status ?? 1, ms: Date.now() - started, reportPath }
  } finally {
    closeSync(fd)
  }
}

/** Extract the names of failing subtests from a TAP report. */
function failingTests(reportPath) {
  let report = ''
  try {
    report = readFileSync(reportPath, 'utf8')
  } catch {
    return ['(no report captured)']
  }
  const names = []
  const lines = report.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const match = /^not ok \d+ - (.+)$/.exec(lines[index])
    if (match) names.push(match[1].trim())
  }
  return names.slice(0, 12)
}

/** Apply one mutant to the source, insisting the fragment is unique. */
function mutate(source, mutant) {
  const occurrences = source.split(mutant.find).length - 1
  if (occurrences !== 1) {
    return { applied: false, reason: `fragment found ${occurrences} time(s), expected exactly 1` }
  }
  return { applied: true, source: source.replace(mutant.find, mutant.replace) }
}

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const checkOnly = args.includes('--check')
const keepGoing = args.includes('--keep-going')
const onlyIndex = args.indexOf('--only')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined

const selected = MUTANTS.filter((mutant) => only === undefined || mutant.id.includes(only))

if (listOnly) {
  console.log(`${MUTANTS.length} mutants defined (${selected.length} selected):`)
  for (const mutant of selected) console.log(`- ${mutant.id}: ${mutant.why}`)
  process.exit(0)
}

if (checkOnly) {
  // Verify every fragment still matches the current source exactly once, without writing anything.
  const source = readFileSync(indexPath, 'utf8')
  let broken = 0
  for (const mutant of selected) {
    const occurrences = source.split(mutant.find).length - 1
    if (occurrences === 1) {
      console.log(`[ok]   ${mutant.id}`)
    } else {
      broken += 1
      console.error(`[STALE] ${mutant.id}: fragment found ${occurrences} time(s), expected exactly 1`)
    }
  }
  console.log(`${selected.length - broken}/${selected.length} fragments match the current index.js`)
  process.exit(broken === 0 ? 0 : 1)
}

const original = readFileSync(indexPath)
const originalHash = sha(original)
const workDir = mkdtempSync(join(tmpdir(), 'peer-bus-mutation-'))
const backupPath = join(workDir, 'index.js.original')
copyFileSync(indexPath, backupPath)
const reportPath = join(workDir, 'tap-report.log')

console.log(`index.js sha256 before: ${originalHash}`)
console.log(`backup:                ${backupPath}`)
console.log(`mutants:               ${selected.length}`)
console.log('')

/** Restore the original bytes and verify them. */
function restore(reason) {
  writeFileSync(indexPath, original)
  const restored = sha(readFileSync(indexPath))
  if (restored !== originalHash) {
    console.error(`FATAL: restore failed (${restored} != ${originalHash}); backup is at ${backupPath}`)
    process.exit(2)
  }
  console.log(`restored index.js (${reason}), sha256 ${restored}`)
}

let aborted = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    aborted = true
    restore(`signal ${signal}`)
    process.exit(130)
  })
}

const results = []
try {
  for (const mutant of selected) {
    if (aborted) break
    // Every mutant starts from the pristine source; anything else means a concurrent editor.
    writeFileSync(indexPath, original)
    const current = sha(readFileSync(indexPath))
    if (current !== originalHash) {
      console.error(`FATAL: index.js changed while mutating (${current} != ${originalHash}); staying read-only from here.`)
      process.exit(3)
    }

    const mutation = mutate(original.toString('utf8'), mutant)
    if (!mutation.applied) {
      console.error(`[not-applied] ${mutant.id}: ${mutation.reason}`)
      results.push({ mutant, applied: false, killed: false, failures: [mutation.reason] })
      continue
    }

    const mutantBuffer = Buffer.from(mutation.source, 'utf8')
    const mutantHash = sha(mutantBuffer)
    writeFileSync(indexPath, mutantBuffer)
    const run = runSuiteCaptured(reportPath)

    // Another writer would invalidate this run: stop instead of overwriting their work.
    const after = sha(readFileSync(indexPath))
    if (after !== mutantHash) {
      console.error(`FATAL: index.js was edited during the ${mutant.id} run; aborting without restoring.`)
      console.error(`        the original is preserved at ${backupPath}`)
      process.exit(4)
    }

    // Back to pristine before the next mutant (and before reporting).
    writeFileSync(indexPath, original)

    const killed = run.status !== 0
    const failures = killed ? failingTests(reportPath) : []
    results.push({ mutant, applied: true, killed, failures, ms: run.ms })
    console.log(
      `${killed ? '[killed]   ' : '[SURVIVED] '} ${mutant.id} (${run.ms} ms)` +
        (killed && failures.length > 0 ? ` — ${failures.join(' | ')}` : ''),
    )
  }
} finally {
  restore('end of run')
}

// Final green run on the restored file.
const finalRun = runSuiteCaptured(reportPath)
console.log('')
console.log(`final suite after restore: ${finalRun.status === 0 ? 'GREEN' : 'RED'} (${finalRun.ms} ms)`)

const applied = results.filter((entry) => entry.applied)
const killed = applied.filter((entry) => entry.killed)
const survived = applied.filter((entry) => !entry.killed)
const notApplied = results.filter((entry) => !entry.applied)
const score = applied.length === 0 ? 0 : (killed.length / applied.length) * 100

console.log('')
console.log('--- mutation report ---')
console.log(`mutants defined:  ${MUTANTS.length}`)
console.log(`mutants selected: ${selected.length}`)
console.log(`applied:          ${applied.length}`)
console.log(`killed:           ${killed.length}`)
console.log(`survived:         ${survived.length}`)
console.log(`not applied:      ${notApplied.length}`)
console.log(`mutation score:   ${score.toFixed(1)} % (${killed.length}/${applied.length})`)
if (survived.length > 0) {
  console.log('surviving mutants (the suite must be strengthened):')
  for (const entry of survived) {
    console.log(`- ${entry.mutant.id}: ${entry.mutant.why}`)
    for (const failure of entry.failures) console.log(`    observed: ${failure}`)
  }
}
if (notApplied.length > 0) {
  console.log('mutants that no longer match the source (fix their fragments):')
  for (const entry of notApplied) console.log(`- ${entry.mutant.id}: ${entry.failures[0]}`)
}

const healthy = finalRun.status === 0 && survived.length === 0 && notApplied.length === 0
process.exit(healthy || keepGoing ? 0 : 1)
