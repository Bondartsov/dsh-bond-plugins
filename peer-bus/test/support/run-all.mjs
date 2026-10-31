#!/usr/bin/env node
/**
 * Test runner for the Peer Bus suite.
 *
 * `node --test test/` is what CONTRACT.md §6 names, but the Node build used by this Host
 * (v22.15.0) resolves a directory positional as a module and fails with
 * "Cannot find module ...\\test". Node's own glob support does work, so this script collects the
 * test files explicitly and runs them in one `node --test` process.
 *
 * Usage: node test/support/run-all.mjs [--name-filter <substring>]
 * Exit code: 0 when every check passed, non-zero otherwise (CI-friendly).
 */
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const testDir = resolve(here, '..')

const filterIndex = process.argv.indexOf('--name-filter')
const filter = filterIndex >= 0 ? process.argv[filterIndex + 1] : undefined

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => filter === undefined || name.includes(filter))
  .sort()
  .map((name) => join(testDir, name))

if (files.length === 0) {
  console.error(`no *.test.mjs files found in ${testDir}`)
  process.exit(1)
}

console.log(`peer-bus: running ${files.length} test files with node --test`)
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: resolve(testDir, '..'), stdio: 'inherit' })
process.exit(result.status ?? 1)
