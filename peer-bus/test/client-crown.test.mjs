/**
 * The master crown must look the same everywhere.
 *
 * Guard: the sidebar row's 16px leading cell, the running row's action strip, the board tree and
 * the footer chip all mark the *same* role, so all of them wear the same gold. An outline-only
 * leading cell next to a gold crown read as "this one is not really the master" — the owner said
 * exactly that.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const client = readFileSync(join(root, 'client.js'), 'utf8')

/** The declaration block of one CSS selector, as written in the bundle's CSS array. */
function styleOf(selector) {
  const start = client.indexOf(selector)
  assert.notEqual(start, -1, `the stylesheet must style ${selector}`)
  return client.slice(start, start + 700)
}

const GOLD = 'var(--dsw-alias-state-warn-primary)'

test('every crown draws with the same gold theme token', () => {
  for (const selector of ['.dshPeerBus_mark{', '.dshPeerBus_crownInline{', '.dshPeerBus_treeCrown{', '.dshPeerBus_footerCrown{']) {
    assert.ok(styleOf(selector).includes('color:' + GOLD), `${selector} uses the gold token`)
  }
})

test('the leading-cell crown is filled, not an outline', () => {
  const mark = styleOf('.dshPeerBus_mark{')
  assert.equal(mark.includes('--dsw-alias-label-tertiary'), false, 'the muted outline colour is gone')
  const glyph = styleOf('.dshPeerBus_mark svg path{')
  assert.match(glyph, /fill:currentColor/, 'the leading crown is filled like the others')
  assert.equal(/fill:none/.test(glyph), false, 'no outline-only crown')
})

test('the crown never hard-codes a colour literal', () => {
  const crown = styleOf('.dshPeerBus_mark{') + styleOf('.dshPeerBus_treeCrown{') + styleOf('.dshPeerBus_footerCrown{')
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(crown), false, 'no colour literals in crown styles')
})
