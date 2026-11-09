/**
 * Guard 0 — the Host wiring exists: the eight tools, the prompt section and the documented routes.
 * A missing route or tool is a contract break, not a skip: the panel and the model both depend on
 * these names.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHost } from './support/host-harness.mjs'

const TOOLS = [
  'canvas_write',
  'canvas_replace',
  'canvas_set_title',
  'canvas_clear',
  'canvas_read',
  'canvas_comments',
  'canvas_apply',
  'canvas_apply_edits',
]

const ROUTES = [
  '/canvas/doc',
  '/canvas/doc/new',
  '/canvas/comment',
  '/canvas/apply/prepare',
  '/canvas/apply/pending',
  '/canvas/apply/commit',
  '/canvas/apply/discard',
  '/canvas/export',
]

test('every documented tool is registered', () => {
  const host = createHost()
  for (const name of TOOLS) assert.ok(host.tools.has(name), `CONTRACT: tool ${name} must be registered`)
})

test('every documented route is registered exactly once', () => {
  const host = createHost()
  for (const path of ROUTES) {
    assert.equal(host.routes.filter((route) => route.path === path).length, 1, `CONTRACT: route ${path}`)
  }
})

test('one prompt section tells the model the canvas exists', () => {
  const host = createHost()
  const section = host.sections.find((entry) => entry.name === 'canvas:guide')
  assert.ok(section !== undefined, 'CONTRACT: the canvas prompt section must be registered')
  assert.match(section.text, /canvas_write/)
  assert.match(section.text, /canvas_apply/)
  assert.match(section.text, /\[from, to\)/)
  assert.match(section.text, /canvas_clear/)
})

test('GET /canvas/doc answers with the version and the document', async () => {
  const host = createHost()
  const response = await host.request('/canvas/doc', { method: 'GET' })
  assert.equal(response.status, 200)
  const body = response.json()
  assert.equal(body.version, 1)
  assert.equal(body.document.schema, 1)
  assert.equal(body.document.scope, 'global')
  assert.ok(Array.isArray(body.document.blocks))
  assert.equal(body.readOnly, false)
})

test('apply prepare without a session id answers 400 NO_SESSION', async () => {
  const host = createHost()
  const response = await host.request('/canvas/apply/prepare', { method: 'POST', body: {} })
  assert.equal(response.status, 400)
  assert.equal(response.json().code, 'NO_SESSION')
})

test('pending answers 204 while no batch waits', async () => {
  const host = createHost()
  const response = await host.request('/canvas/apply/pending', { method: 'GET' })
  assert.equal(response.status, 204)
})
