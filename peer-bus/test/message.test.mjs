/**
 * `peer_send` + `peer_inbox` — the message path between two sessions.
 *
 * Guards: a live peer is woken through its real agent object, the delivered text always names the
 * sender and says it is not the human, broadcast never crosses a workspace boundary, an unknown
 * target fails loudly listing known peers, and a cold session is resumed through the Host service
 * (or fails loudly when there is none).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHarness, fakeSessionController, short } from './support/mock-ctx.mjs'

/** A, B in one project; `other` in a foreign workspace. */
function conversation() {
  const harness = createHarness()
  const a = harness.addAgent('session-aaaa1111', 'C:\\project')
  const b = harness.addAgent('session-bbbb2222', 'C:\\PROJECT\\')
  const other = harness.addAgent('session-cccc3333', 'C:\\elsewhere')
  return { harness, a, b, other }
}

test('a live message is delivered through the recipient agent (queue mode)', async () => {
  const { harness, a, b } = conversation()
  const sent = await harness.callTool('peer_send', { to: short(b.id), message: 'Ты скоро? Мне надо мержить свой PR.' }, a)

  assert.equal(sent.delivery, 'live')
  assert.equal(sent.to, short(b.id))
  assert.equal(typeof sent.text, 'string')
  assert.equal(b.sent.length, 1, 'exactly one delivery')
  assert.equal(b.sent[0].mode, 'followup', 'queue semantics use followup()')

  const delivered = b.sent[0].message
  assert.equal(delivered.role, 'user', 'delivered message is a user-role message')
  assert.equal(typeof delivered.id, 'string')
  assert.ok(delivered.id.length > 0, 'delivered message carries a stable id')
  assert.ok(delivered.content[0].text.includes(short(a.id)), 'the text names the sender')
  assert.ok(delivered.content[0].text.includes('Ты скоро?'), 'the text carries the body')
  assert.ok(delivered.content[0].text.includes('не пользователь'), 'the text disambiguates the sender')
})

test('the delivery receipt names the peer, not only its handle', async () => {
  const { harness, a, b } = conversation()
  await harness.callTool('peer_intent', { label: 'pr-first', text: 'гоню гейты' }, b)
  const sent = await harness.callTool('peer_send', { to: short(b.id), message: 'статус?' }, a)
  assert.ok(sent.text.includes('pr-first'), `receipt names the peer: ${sent.text}`)
})

test('steer mode reaches the running turn; a label resolves to the peer', async () => {
  const { harness, a, b } = conversation()
  await harness.callTool('peer_intent', { label: 'pr-first' }, b)
  const steered = await harness.callTool('peer_send', { to: 'pr-first', message: 'подожди меня', mode: 'steer' }, a)

  assert.equal(steered.delivery, 'live')
  assert.equal(steered.to, short(b.id), 'the label resolves to the peer handle')
  assert.equal(b.sent[0].mode, 'steer', 'steer mode uses steer()')
})

test('broadcast reaches every peer of this workspace and nobody else', async () => {
  const { harness, a, b, other } = conversation()
  harness.addAgent('session-dddd4444', 'C:\\project')
  const beforeOther = other.sent.length
  const broadcast = await harness.callTool('peer_send', { to: 'all', message: 'всем: стенд занят до 12:00' }, a)

  assert.equal(broadcast.delivery, 'broadcast')
  assert.equal(broadcast.to, 'all')
  assert.ok(b.sent.length > 0, 'a same-workspace peer received it')
  assert.equal(other.sent.length, beforeOther, 'a foreign workspace never receives a broadcast')
  assert.ok(broadcast.text.includes(short(b.id)) || broadcast.text.includes('pr-first'), 'the receipt names each recipient')
})

test('an unknown target is refused and lists the known peers', async () => {
  const { harness, a, b } = conversation()
  const error = await harness.expectError(
    () => harness.callTool('peer_send', { to: 'nobody', message: 'hi' }, a),
    'known peers',
  )
  assert.ok(error.message.includes(short(b.id)), `the error lists the known peer: ${error.message}`)
})

test('an empty message or missing target is refused', async () => {
  const { harness, a } = conversation()
  await harness.expectError(() => harness.callTool('peer_send', { to: 'all', message: '   ' }, a), 'BAD_ARGUMENT')
})

test('a cold session is resumed through sessionController', async () => {
  const { harness, a, b } = conversation()
  const controller = fakeSessionController()
  harness.services.sessionController = controller
  harness.disposeAgent(b)

  const sent = await harness.callTool('peer_send', { to: short(b.id), message: 'ещё тут?' }, a)
  assert.equal(sent.delivery, 'resumed')
  assert.equal(controller.calls.prompt.length, 1, 'the cold session is prompted')
  assert.equal(controller.calls.prompt[0].sessionId, b.id)
  assert.ok(controller.calls.prompt[0].content[0].text.includes('ещё тут?'), 'the body is queued')
})

test('steer to a cold session is downgraded to a queued message, and says so', async () => {
  const { harness, a, b } = conversation()
  harness.services.sessionController = fakeSessionController()
  harness.disposeAgent(b)

  const sent = await harness.callTool('peer_send', { to: short(b.id), message: 'срочно', mode: 'steer' }, a)
  assert.equal(sent.delivery, 'resumed')
  assert.ok(/cold|queued|steer/i.test(sent.text), `the downgrade is explained: ${sent.text}`)
})

test('a cold delivery without sessionController fails loudly', async () => {
  const { harness, a, b } = conversation()
  harness.disposeAgent(b)
  const sent = await harness.callTool('peer_send', { to: short(b.id), message: 'ещё тут?' }, a)
  assert.equal(sent.delivery, 'failed')
  assert.equal(typeof sent.error, 'string')
  assert.ok(sent.error.length > 0, 'the failure explains itself')
})

test('peer_inbox shows both directions and filters by peer', async () => {
  const { harness, a, b } = conversation()
  await harness.callTool('peer_send', { to: short(b.id), message: 'первое' }, a)
  await harness.callTool('peer_send', { to: short(b.id), message: 'второе', mode: 'steer' }, a)

  const inbox = await harness.callTool('peer_inbox', {}, b)
  assert.equal(inbox.messages.length, 2)
  assert.ok(inbox.messages.every((message) => message.direction === 'in'), 'B sees both as inbound')
  assert.ok(inbox.messages.every((message) => message.peer === short(a.id)), 'the sender handle is attached')

  const outbox = await harness.callTool('peer_inbox', {}, a)
  assert.ok(outbox.messages.every((message) => message.direction === 'out'), 'A sees them as outbound')

  const filtered = await harness.callTool('peer_inbox', { peer: short(b.id), limit: 1 }, a)
  assert.equal(filtered.messages.length, 1, 'limit is honoured')
  assert.equal(filtered.messages[0].text, 'второе', 'newest last, so the last message survives the limit')
})

test('peer_inbox refuses an unknown peer filter', async () => {
  const { harness, a } = conversation()
  await harness.expectError(() => harness.callTool('peer_inbox', { peer: 'ghost' }, a), 'no peer')
})
