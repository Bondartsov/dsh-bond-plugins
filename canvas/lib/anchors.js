/**
 * Anchor survival: what happens to a comment when the text under it changes.
 *
 * A comment stores `{ blockId, from, to, occurrence, quote }`. An edit shifts the flat text, so
 * every comment of the edited block is re-anchored in four steps, in this order and without
 * shortcuts:
 *
 * 1. the exact quote, at the recorded occurrence;
 * 2. the quote after normalizing case, `ё`, punctuation-free whitespace and runs of spaces;
 * 3. the best word overlap of at least 70 %, which marks the comment `approximate` (a pale
 *    highlight; its edit still applies);
 * 4. nothing found — `orphaned` with a reason.
 *
 * The invariant behind the order: the canvas never silently loses a comment. A comment that cannot
 * be placed stays in the list, keeps its note and waits for the person to re-attach it.
 */

import { plainText } from './model.js'

/** Word overlap above which a partial hit counts as the same fragment. */
const APPROXIMATE_THRESHOLD = 0.7

/**
 * Every offset at which `quote` starts in `text`.
 * @param {string} text - the block's flat text.
 * @param {string} quote - the fragment.
 * @returns {number[]} start offsets, ascending.
 */
export function occurrences(text, quote) {
  if (quote === '') return []
  const result = []
  let from = 0
  for (;;) {
    const index = text.indexOf(quote, from)
    if (index === -1) return result
    result.push(index)
    from = index + 1
  }
}

/**
 * Step 1: the exact quote at the requested occurrence.
 * When the text lost one duplicate, the nearest surviving occurrence is used and the recorded
 * occurrence is corrected — an existing quote is never called orphaned because of a vanished twin.
 * @param {string} text - the block's flat text.
 * @param {string} quote - the fragment.
 * @param {number} occurrence - 0-based occurrence number.
 * @returns {{from: number, to: number, occurrence: number}|null} the anchor, or null.
 */
export function findExact(text, quote, occurrence) {
  const offsets = occurrences(text, quote)
  if (offsets.length === 0) return null
  const index = Math.min(Math.max(occurrence, 0), offsets.length - 1)
  const from = offsets[index]
  return { from, to: from + quote.length, occurrence: index }
}

/**
 * Normalize a text for step 2 while keeping a map back to the original offsets.
 * Case, `ё` and whitespace runs are the only differences tolerated here: punctuation is kept,
 * because dropping it would make two different sentences look identical.
 * @param {string} text - the original text.
 * @returns {{text: string, map: number[]}} the normalized text and, per character, its source offset.
 */
export function normalizeWithMap(text) {
  const out = []
  const map = []
  let lastWasSpace = false
  for (let index = 0; index < text.length; index += 1) {
    let character = text[index].toLowerCase().replace('ё', 'е')
    if (/\s/u.test(character)) {
      if (lastWasSpace) continue
      lastWasSpace = true
      character = ' '
    } else {
      lastWasSpace = false
    }
    out.push(character)
    map.push(index)
  }
  return { text: out.join(''), map }
}

/**
 * Step 2: a normalized search for the quote.
 * @param {string} text - the block's flat text.
 * @param {string} quote - the fragment.
 * @returns {{from: number, to: number}|null} the anchor in original offsets, or null.
 */
export function findNormalized(text, quote) {
  const haystack = normalizeWithMap(text)
  const needle = normalizeWithMap(quote).text
  if (needle.trim() === '') return null
  const index = haystack.text.indexOf(needle)
  if (index === -1) return null
  const from = haystack.map[index]
  const last = index + needle.length - 1
  const to = last < haystack.map.length ? haystack.map[last] + 1 : text.length
  return { from, to }
}

/**
 * Word tokens with their original offsets and a punctuation-free comparison key.
 * @param {string} text - the text to tokenize.
 * @returns {{raw: string, start: number, end: number, key: string}[]} the words.
 */
function words(text) {
  const result = []
  const pattern = /\S+/gu
  let match = pattern.exec(text)
  while (match !== null) {
    const raw = match[0]
    result.push({
      raw,
      start: match.index,
      end: match.index + raw.length,
      key: raw
        .toLowerCase()
        .replaceAll('ё', 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ''),
    })
    match = pattern.exec(text)
  }
  return result
}

/**
 * Step 3: the best window of the block that still holds at least 70 % of the quote's words.
 * The window length equals the quote's word count, so a rewritten word keeps the neighbours and a
 * deleted one does not shift the whole fragment.
 * @param {string} text - the block's flat text.
 * @param {string} quote - the fragment.
 * @param {number} [threshold] - minimum share of the quote's words that must match.
 * @returns {{from: number, to: number, ratio: number}|null} the anchor, or null.
 */
export function findApproximate(text, quote, threshold = APPROXIMATE_THRESHOLD) {
  const quoteWords = words(quote)
  const textWords = words(text)
  if (quoteWords.length === 0 || textWords.length === 0) return null
  const wanted = quoteWords.map((word) => word.key).filter((key) => key !== '')
  if (wanted.length === 0) return null

  let best = null
  const span = Math.min(quoteWords.length, textWords.length)
  for (let start = 0; start + span <= textWords.length; start += 1) {
    const window = textWords.slice(start, start + span)
    const pool = new Map()
    for (const word of window) {
      if (word.key === '') continue
      pool.set(word.key, (pool.get(word.key) ?? 0) + 1)
    }
    let matched = 0
    for (const key of wanted) {
      const left = pool.get(key) ?? 0
      if (left > 0) {
        matched += 1
        pool.set(key, left - 1)
      }
    }
    const ratio = matched / wanted.length
    if (best === null || ratio > best.ratio) {
      best = { from: window[0].start, to: window[window.length - 1].end, ratio, start }
    }
    if (ratio === 1) break
  }
  if (best === null || best.ratio < threshold) return null
  return { from: best.from, to: best.to, ratio: best.ratio }
}

/** Statuses whose anchor may move but whose lifecycle state must not be resurrected. */
const SETTLED = new Set(['applied', 'rejected', 'failed', 'conflict'])

/**
 * Re-anchor one comment against the block's current text.
 * @param {object} block - the block the comment points at.
 * @param {object} comment - the comment.
 * @returns {object} the updated comment.
 */
export function anchorComment(block, comment) {
  const text = plainText(block)
  const exact = findExact(text, comment.quote, comment.occurrence)
  if (exact !== null) {
    return {
      ...comment,
      from: exact.from,
      to: exact.to,
      occurrence: exact.occurrence,
      ...(SETTLED.has(comment.status) ? {} : { status: 'open', reason: null }),
    }
  }
  const normalized = findNormalized(text, comment.quote)
  if (normalized !== null) {
    return {
      ...comment,
      from: normalized.from,
      to: normalized.to,
      ...(SETTLED.has(comment.status) ? {} : { status: 'open', reason: null }),
    }
  }
  const approximate = findApproximate(text, comment.quote)
  if (approximate !== null) {
    return {
      ...comment,
      from: approximate.from,
      to: approximate.to,
      ...(SETTLED.has(comment.status) ? {} : { status: 'approximate', reason: null }),
    }
  }
  if (SETTLED.has(comment.status)) return { ...comment }
  return {
    ...comment,
    status: 'orphaned',
    reason: 'фрагмент не найден в блоке',
  }
}

/**
 * Re-anchor every comment of one block, leaving the other blocks' comments untouched.
 * @param {object} document - the document to update in place.
 * @param {string} blockId - the block that changed.
 * @returns {object[]} the comments that moved or changed state.
 */
export function reanchorBlock(document, blockId) {
  const block = (document.blocks ?? []).find((entry) => entry.id === blockId)
  if (block === undefined) return []
  const touched = []
  document.comments = (document.comments ?? []).map((comment) => {
    if (comment.blockId !== blockId) return comment
    const next = anchorComment(block, comment)
    if (
      next.from !== comment.from ||
      next.to !== comment.to ||
      next.status !== comment.status ||
      next.occurrence !== comment.occurrence ||
      next.reason !== comment.reason
    ) {
      touched.push(next)
    }
    return next
  })
  return touched
}

/**
 * Re-anchor every comment against the whole document — used after a rewrite, where block ids are
 * new and an anchor must be looked for in every remaining block.
 * @param {object} document - the document to update in place.
 * @returns {object[]} the comments that moved or changed state.
 */
export function reanchorDocument(document) {
  const touched = []
  document.comments = (document.comments ?? []).map((comment) => {
    const own = (document.blocks ?? []).find((entry) => entry.id === comment.blockId)
    const candidates = own === undefined ? (document.blocks ?? []) : [own, ...(document.blocks ?? [])]
    let next = null
    for (const block of candidates) {
      const candidate = anchorComment(block, comment)
      if (candidate.status !== 'orphaned') {
        next = { ...candidate, blockId: block.id }
        break
      }
      if (next === null) next = candidate
    }
    next = next ?? { ...comment, status: 'orphaned', reason: 'фрагмент не найден в блоке' }
    if (next.blockId !== comment.blockId || next.from !== comment.from || next.to !== comment.to || next.status !== comment.status) {
      touched.push(next)
    }
    return next
  })
  return touched
}
