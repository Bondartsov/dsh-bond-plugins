/**
 * Guard 22 — the client bundle uses theme tokens only.
 *
 * A hex literal, `rgb(`, or `hsl(` outside a CSS custom-property declaration ignores the theme and
 * breaks in dark mode. The scan is deliberately textual: it looks at the shipped bundle, which is
 * what the browser executes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'client.js'), 'utf8')

test('client.js has no colour literals and no rgb()/hsl() colours', () => {
  // Allowed: a value assigned to a `--name` custom property. Everything else must be a token.
  const withoutVariableDeclarations = source.replace(/--[a-zA-Z0-9-]+\s*:\s*[^;'"`}]+/g, '')

  const hex = withoutVariableDeclarations.match(/(?<!&)#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(hex, [], `hex colours outside CSS variables: ${hex.join(', ')}`)

  const rgb = withoutVariableDeclarations.match(/\brgba?\(/gi) ?? []
  assert.deepEqual(rgb, [], `rgb()/rgba() colours: ${rgb.join(', ')}`)

  const hsl = withoutVariableDeclarations.match(/\bhsla?\(/gi) ?? []
  assert.deepEqual(hsl, [], `hsl()/hsla() colours: ${hsl.join(', ')}`)
})

test('every colour in the bundle is a --dsw token', () => {
  const colours = source.match(/(?:color|background|border-color|box-shadow|outline)\s*:[^;]*/g) ?? []
  const offenders = colours.filter((declaration) => /(?<!&)#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(declaration))
  assert.deepEqual(offenders, [], `declarations with a literal colour: ${offenders.join(' | ')}`)
  assert.ok(source.includes('var(--dsw-'), 'the bundle must draw through theme tokens')
})
