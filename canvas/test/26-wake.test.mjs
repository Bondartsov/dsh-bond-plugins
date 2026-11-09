/**
 * Guard 26 — the wake-up message is admissible in the session log.
 *
 * The session format v4 refuses the retired `source.kind = "plugin"` wrapper: a message must carry
 * the producer's own kind. A wrong kind does not fail quietly — the whole turn dies with
 * "format v4 message requires a producer-owned source kind", which is exactly what happened on
 * 06.11.2026 when the panel pressed «Применить все». This guard pins the kind and the two-message
 * shape (`inject` context + `followup` wake).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHost } from './support/host-harness.mjs'

test('prepare without a live session answers NO_SESSION and releases the lock', async () => {
  const host = createHost()
  await host.callTool('canvas_write', { text: 'Стих про осень.' })
  await host.request('/canvas/comment', { method: 'POST', body: { action: 'add', blockId: 'b-1', from: 0, to: 4, note: 'короче' } })

  const failed = await host.request('/canvas/apply/prepare', { method: 'POST', body: { sessionId: 'нет-такой' } })
  assert.equal(failed.status, 400)
  assert.equal(failed.json().code, 'NO_SESSION')

  // The refused preparation must not hold the document lock: a retry with a live agent works.
  host.addAgent('session-1')
  const retried = await host.request('/canvas/apply/prepare', { method: 'POST', body: { sessionId: 'session-1' } })
  assert.equal(retried.status, 200)
  assert.equal(retried.json().count, 1)
})

test('a cold but resumable conversation is resumed instead of refused', async () => {
  const host = createHost({ resumable: ['session-1'] })
  await host.callTool('canvas_write', { text: 'Стих про осень.' })
  await host.request('/canvas/comment', { method: 'POST', body: { action: 'add', blockId: 'b-1', from: 0, to: 4, note: 'короче' } })

  const prepared = await host.request('/canvas/apply/prepare', { method: 'POST', body: { sessionId: 'session-1' } })
  assert.equal(prepared.status, 200, 'a resumable session must not answer NO_SESSION')
  const agent = host.agents.get('session-1')
  assert.ok(agent !== undefined, 'the session is live after the resume')
  assert.equal(agent.injected.length, 1)
  assert.equal(agent.sent.length, 1)
})

test('the wake-up messages carry the producer-owned kind, never "plugin"', async () => {
  const host = createHost()
  const agent = host.addAgent('session-1')
  await host.callTool('canvas_write', { text: 'Стих про осень.' })
  await host.request('/canvas/comment', { method: 'POST', body: { action: 'add', blockId: 'b-1', from: 0, to: 4, note: 'короче' } })

  const prepared = await host.request('/canvas/apply/prepare', { method: 'POST', body: { sessionId: 'session-1' } })
  assert.equal(prepared.status, 200)

  assert.equal(agent.injected.length, 1, 'the context goes through inject (no wake)')
  assert.equal(agent.sent.length, 1, 'the instruction goes through followup (wakes the agent)')
  for (const entry of [...agent.injected, ...agent.sent]) {
    assert.equal(entry.message.source.kind, 'canvas', 'CONTRACT: the source kind is the plugin own kind')
    assert.notEqual(entry.message.source.kind, 'plugin', 'CONTRACT: format v4 refuses the retired plugin wrapper')
    assert.equal(entry.message.role, 'user')
    assert.equal(typeof entry.message.id, 'string')
  }
  assert.match(agent.injected[0].message.content[0].text, /c-1/, 'the context names the comment')
  assert.match(agent.sent[0].message.content[0].text, /canvas_apply/)
})
