/**
 * Guard 21 — the exported page opens offline and no user text can break it.
 *
 * The file must be self-contained: styles inline, system fonts, and no `http://`, `https://`,
 * `<script src` or `<link href` anywhere. Every piece of user text goes through the escaping of
 * `& < > " '`, so a paragraph about markup — including a literal `</style>` — is displayed, not run.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService } from './support/service-harness.mjs'
import { readFileSync } from 'node:fs'
import { escapeHtml, exportHtml } from '../lib/export-html.js'

test('the exported page has no external references', () => {
  const { service } = createService()
  service.write('# Коммерческое предложение\n\nОбычный абзац с **жирным** и *курсивом*.')
  const html = exportHtml(service.document, { exportedAt: '2026-11-06T16:00:00+03:00' })

  assert.equal(/https?:\/\//i.test(html), false, 'CONTRACT: an exported page has no URL')
  assert.equal(/<script\s+src/i.test(html), false, 'no external script')
  assert.equal(/<link\s+href/i.test(html), false, 'no external stylesheet')
  assert.match(html, /<style>/)
  assert.match(html, /Segoe UI/)
})

test('special characters are escaped and cannot break the page', () => {
  const { service } = createService()
  service.write('Углы & < > и кавычки " \' и закрывающий тег </style> внутри текста.')
  service.addComment({ blockId: 'b-1', from: 0, to: 5, note: 'заметка с <b> и & тоже' })

  const html = exportHtml(service.document, { includeComments: true })
  assert.equal(html.includes('</style> внутри текста'), false, 'the closing tag from the text is escaped')
  assert.ok(html.includes('&lt;/style&gt;'), 'the literal tag is shown as text')
  assert.ok(html.includes('&amp;'), 'ampersands are escaped')
  assert.ok(html.includes('&quot;'), 'double quotes are escaped')
  assert.ok(html.includes('&#39;'), 'single quotes are escaped')
  assert.ok(html.includes('&lt;b&gt;'), 'the note is escaped too')
  assert.match(html, /<section class="notes">/, 'comments become footnotes when asked')
})

test('escapeHtml covers the five characters and nothing else', () => {
  assert.equal(escapeHtml(`& < > " '`), '&amp; &lt; &gt; &quot; &#39;')
  assert.equal(escapeHtml('кириллица и 123'), 'кириллица и 123')
})

test('the export route writes the page into products/ and reports its path', async () => {
  const { createHost } = await import('./support/host-harness.mjs')
  const host = createHost()
  await host.callTool('canvas_write', { text: 'Текст для экспорта.' })
  const response = await host.request('/canvas/export', { method: 'POST', body: { format: 'html' } })
  assert.equal(response.status, 200)
  const body = response.json()
  assert.match(body.path, /products/)
  const html = readFileSync(body.path, 'utf8')
  assert.equal(/https?:\/\//i.test(html), false)
  assert.ok(html.includes('Текст для экспорта.'))
})
