/**
 * Guard 1 — `canvas_write` appends blocks and markdown-lite maps to the closed block type enum.
 *
 * The mapping is the contract a model writes against; a silent change here would turn a heading
 * into a paragraph and quietly break every document already written in that shape.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createService } from './support/service-harness.mjs'
import { createHost } from './support/host-harness.mjs'

const SOURCE = [
  '# Заголовок',
  '',
  '## Подзаголовок',
  '',
  '### Третий уровень',
  '',
  '- пункт списка',
  '',
  '1. нумерованный пункт',
  '',
  '> цитата',
  '',
  '```',
  'const answer = 42;',
  '```',
  '',
  'Обычный **жирный** и *курсив* текст.',
].join('\n')

test('canvas_write appends blocks and maps markdown-lite to the block enum', () => {
  const { service } = createService()
  const result = service.write(SOURCE)
  const blocks = service.document.blocks

  assert.equal(result.added, 8)
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['h1', 'h2', 'h3', 'li', 'li', 'quote', 'code', 'p'],
  )
  assert.equal(blocks[3].ordered, false, 'a dash is an unordered list item')
  assert.equal(blocks[4].ordered, true, '1. is an ordered list item')
  assert.equal(blocks[6].spans.map((span) => span.t).join(''), 'const answer = 42;', 'a fence is verbatim')
  assert.deepEqual(blocks[7].spans, [
    { t: 'Обычный ' },
    { t: 'жирный', b: true },
    { t: ' и ' },
    { t: 'курсив', i: true },
    { t: ' текст.' },
  ])
  assert.equal(blocks[0].id, 'b-1')
  assert.equal(blocks[7].id, 'b-8')
})

test('canvas_write inserts after a block id, never after an index', () => {
  const { service } = createService()
  service.write('# Один\n\n# Три')
  service.write('## Два', 'b-1')

  assert.deepEqual(
    service.document.blocks.map((block) => block.spans.map((span) => span.t).join('')),
    ['Один', 'Два', 'Три'],
  )
  assert.equal(service.document.blocks[1].id, 'b-3', 'ids keep growing from the counter')
})

test('the canvas_write tool appends and reports the block ids', async () => {
  const host = createHost()
  const tool = host.tools.get('canvas_write')
  assert.equal(typeof tool?.execute, 'function', 'CONTRACT: canvas_write must be registered')

  const result = await host.callTool('canvas_write', { text: 'Первый абзац' })
  assert.match(result.text, /записано блоков: 1/)
  assert.match(result.text, /b-1/)
})
