/**
 * The document's style passport and the drift detector.
 *
 * The passport is recomputed from the text on every apply preparation — never stored as a promise
 * about the document, so it cannot go stale. The rules are deterministic and deliberately blunt:
 * they run in the Host, on every keystroke-free boundary, and a person can predict them.
 *
 * The drift detector has exactly two rules in v1.0, both of them "the fragment stopped looking
 * like this document": an emoji the document did not have, and a fragment that grew more than
 * 2.5×. A hit turns the edit into `conflict` with `reason: "дрейф стиля"` instead of a silent
 * insert, because a rewritten paragraph is a decision the person has to see.
 */

import { plainText } from './model.js'

/** Markers of clerical style; any hit flags the document. */
const CLERICAL = [
  'в соответствии с',
  'на основании',
  'в целях',
  'осуществля',
  'производить',
  'является',
  'настоящ',
  'вышеуказанн',
  'в связи с',
  'согласно',
  'должным образом',
  'в рамках',
  'данный',
]

/** Colloquial markers that pull a short-sentence text towards «разговорный». */
const COLLOQUIAL = ['привет', 'давай', 'окей', 'кстати', 'ну,', 'вот', 'смотри']

/** One emoji code point, including the pictographic ranges the product actually sees. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}\u{FE0F}]/gu

/**
 * Every distinct emoji in a text.
 * @param {string} text - the text to scan.
 * @returns {Set<string>} the emoji it contains.
 */
export function emojiSet(text) {
  const found = new Set()
  for (const match of String(text ?? '').matchAll(EMOJI)) found.add(match[0])
  return found
}

/**
 * Count the sentences and the words of a text with the simplest stable punctuation rule.
 * @param {string} text - the text to measure.
 * @returns {{sentences: number, words: number}} the counts.
 */
export function measure(text) {
  const clean = String(text ?? '').trim()
  if (clean === '') return { sentences: 0, words: 0 }
  const sentences = clean.split(/[.!?…]+/u).filter((part) => part.trim() !== '').length || 1
  const words = clean.split(/\s+/u).filter((part) => part !== '').length
  return { sentences, words }
}

/**
 * Recompute the style passport of a document.
 * @param {object} document - the document.
 * @returns {{tone: string, person: string, avgSentence: number, flags: string[]}} the passport.
 */
export function stylePassport(document) {
  const text = (document?.blocks ?? []).map(plainText).join('\n')
  const lower = text.toLowerCase()
  const { sentences, words } = measure(text)
  const avgSentence = sentences === 0 ? 0 : Math.round(words / sentences)

  const flags = []
  if (CLERICAL.some((marker) => lower.includes(marker))) flags.push('канцелярит')
  if (avgSentence > 25) flags.push('длинные предложения')
  if (emojiSet(text).size > 0) flags.push('эмодзи')

  const person = /\bвы\b|\bваш/u.test(lower) ? 'вы' : /\bты\b|\bтвой/u.test(lower) ? 'ты' : 'вы'
  let tone = 'нейтральный'
  if (flags.includes('канцелярит')) tone = 'деловой'
  else if (avgSentence > 0 && avgSentence < 10 && COLLOQUIAL.some((marker) => lower.includes(marker))) tone = 'разговорный'

  return { tone, person, avgSentence, flags }
}

/**
 * The drift verdict for one replacement against the document it lands in.
 * @param {string} documentText - the document's flat text *before* the edit.
 * @param {string} quote - the fragment being replaced.
 * @param {string} replacement - what the model proposes.
 * @returns {string|null} `"дрейф стиля"` when a rule fires, otherwise null.
 */
export function driftReason(documentText, quote, replacement) {
  const known = emojiSet(documentText)
  for (const emoji of emojiSet(replacement)) if (!known.has(emoji)) return 'дрейф стиля'
  if (quote.length > 0 && replacement.length > 2.5 * quote.length) return 'дрейф стиля'
  return null
}
