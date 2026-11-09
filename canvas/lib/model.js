/**
 * The Canvas data model: blocks, spans, flat offsets, identities, sizes and hashes.
 *
 * One document is an ordered list of blocks. A block is a closed type plus rich text stored as
 * `spans` — `{ t, b?, i? }` — and nothing else: no links, colours or sizes, so a comment anchor is
 * a pair of character offsets into a value the editor can reproduce byte for byte.
 *
 * Every comment offset is an offset into the block's *flat* text, the concatenation of its span
 * texts. That is the only representation comments, replacements and re-anchoring use; spans are a
 * rendering detail that never shifts an offset.
 */

import { createHash } from 'node:crypto'

/** Document format version this build writes. A file with a higher value is read-only. */
export const SCHEMA = 1

/** The closed block-type enum. `li` additionally carries `ordered: true|false`. */
export const BLOCK_TYPES = Object.freeze(['h1', 'h2', 'h3', 'p', 'li', 'quote', 'code'])

/** Comment lifecycle states. */
export const COMMENT_STATUSES = Object.freeze([
  'open',
  'approximate',
  'orphaned',
  'applied',
  'conflict',
  'rejected',
  'failed',
])

/** Hard limits, all of them refusals rather than truncations. */
export const LIMITS = Object.freeze({
  /** Whole document, flat text of every block. */
  document: 200_000,
  /** One `canvas_write` call. */
  write: 20_000,
  /** One comment quote. */
  quote: 2_000,
  /** Default and maximum block window of `canvas_read`. */
  readDefault: 30,
  readMax: 100,
  /** Soft cap on comments; past it the panel explains instead of silently refusing. */
  comments: 500,
  /** Operations kept in one document's history file. */
  history: 20,
})

const pad2 = (value) => String(value).padStart(2, '0')

/**
 * Format an instant the way data fields are written: ISO 8601 with the local offset.
 * Display converts to ДД.ММ.ГГГГ; storage and comparison never do.
 * @param {Date} [date] - the instant, now by default.
 * @returns {string} such as `2026-11-06T13:20:00+03:00`.
 */
export function isoNow(date = new Date()) {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hours = pad2(Math.floor(Math.abs(offset) / 60))
  const minutes = pad2(Math.abs(offset) % 60)
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${sign}${hours}:${minutes}`
  )
}

/**
 * The block's flat text: the concatenation of its span texts.
 * @param {object} block - one block.
 * @returns {string} its plain text.
 */
export function plainText(block) {
  const spans = Array.isArray(block?.spans) ? block.spans : []
  let text = ''
  for (const span of spans) if (typeof span?.t === 'string') text += span.t
  return text
}

/**
 * The whole document's flat text, block by block.
 * @param {object} document - the document.
 * @returns {string} every block's plain text joined with newlines.
 */
export function documentText(document) {
  return (document?.blocks ?? []).map(plainText).join('\n')
}

/**
 * The document size the limit is measured in: the sum of every block's flat text.
 * @param {object} document - the document.
 * @returns {number} character count.
 */
export function documentSize(document) {
  let size = 0
  for (const block of document?.blocks ?? []) size += plainText(block).length
  return size
}

/**
 * Copy a plain JSON value, so an in-memory snapshot never aliases live state.
 * @template T
 * @param {T} value - the value to copy.
 * @returns {T} a detached copy.
 */
export function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Canonical form of one block: what an edit must leave untouched to count as "unchanged".
 * Flags are normalized to 0/1 so `{b: false}` and an absent `b` hash the same.
 * @param {object} block - one block.
 * @returns {string} the canonical JSON.
 */
export function canonicalBlock(block) {
  const flags = block?.type === 'li' ? { ordered: block.ordered === true } : {}
  return JSON.stringify({
    type: String(block?.type ?? ''),
    ...flags,
    spans: (block?.spans ?? []).map((span) => ({
      t: String(span?.t ?? ''),
      b: span?.b === true ? 1 : 0,
      i: span?.i === true ? 1 : 0,
    })),
  })
}

/**
 * SHA-256 of the canonical block — the value the commit compares for every untouched block.
 * @param {object} block - one block.
 * @returns {string} lowercase hex digest.
 */
export function blockHash(block) {
  return createHash('sha256').update(canonicalBlock(block), 'utf8').digest('hex')
}

/**
 * Normalize one span list: keep only `t` as a string and `b`/`i` as literal `true`.
 * @param {unknown} spans - raw spans from a tool call or an HTTP body.
 * @returns {{t: string, b?: boolean, i?: boolean}[]} the normalized list.
 */
export function normalizeSpans(spans) {
  if (!Array.isArray(spans)) return []
  const result = []
  for (const raw of spans) {
    if (raw === null || typeof raw !== 'object') continue
    const text = typeof raw.t === 'string' ? raw.t : ''
    if (text === '') continue
    const span = { t: text }
    if (raw.b === true) span.b = true
    if (raw.i === true) span.i = true
    result.push(span)
  }
  return result
}

/**
 * Build one block with a fresh id from the document counter.
 * @param {object} document - the document owning the counter.
 * @param {string} type - one of {@link BLOCK_TYPES}.
 * @param {{t: string, b?: boolean, i?: boolean}[]} spans - normalized spans.
 * @param {boolean} [ordered] - `li` only.
 * @returns {object} the block.
 */
export function makeBlock(document, type, spans, ordered) {
  const id = `b-${document.nextBlockSeq}`
  document.nextBlockSeq += 1
  const block = { id, type }
  if (type === 'li') block.ordered = ordered === true
  block.spans = normalizeSpans(spans)
  return block
}

/**
 * Build one comment with a fresh id from the document counter.
 * @param {object} document - the document owning the counter.
 * @param {object} fields - the anchor, quote and note.
 * @returns {object} the comment.
 */
export function makeComment(document, fields) {
  const id = `c-${document.nextCommentSeq}`
  document.nextCommentSeq += 1
  return {
    id,
    blockId: fields.blockId,
    from: fields.from,
    to: fields.to,
    occurrence: fields.occurrence ?? 0,
    quote: fields.quote,
    note: fields.note ?? '',
    status: fields.status ?? 'open',
    reason: fields.reason ?? null,
    createdAt: fields.createdAt ?? isoNow(),
  }
}

/**
 * An empty document.
 * @param {string} id - the document identity (`doc-<seq>`).
 * @param {string} [title] - its title.
 * @returns {object} the document.
 */
export function emptyDocument(id, title = 'Новый документ') {
  return {
    schema: SCHEMA,
    id,
    scope: 'global',
    sessionId: null,
    title,
    version: 1,
    nextBlockSeq: 1,
    nextCommentSeq: 1,
    blocks: [],
    comments: [],
    style: { tone: 'нейтральный', person: 'вы', avgSentence: 0, flags: [] },
    updatedAt: isoNow(),
  }
}

/**
 * Repair a document read from disk just enough to render it, without inventing content.
 * Unknown block types become `p`; a block without a usable id gets one from the counter, so an
 * older or hand-edited file still opens instead of throwing.
 * @param {object} raw - the parsed file.
 * @returns {object} a safe document.
 */
export function normalizeDocument(raw) {
  const document = {
    schema: Number.isInteger(raw?.schema) ? raw.schema : SCHEMA,
    id: typeof raw?.id === 'string' && raw.id !== '' ? raw.id : 'doc-1',
    scope: raw?.scope === 'session' ? 'session' : 'global',
    sessionId: typeof raw?.sessionId === 'string' ? raw.sessionId : null,
    title: typeof raw?.title === 'string' ? raw.title : 'Документ',
    version: Number.isInteger(raw?.version) && raw.version > 0 ? raw.version : 1,
    nextBlockSeq: Number.isInteger(raw?.nextBlockSeq) && raw.nextBlockSeq > 0 ? raw.nextBlockSeq : 1,
    nextCommentSeq: Number.isInteger(raw?.nextCommentSeq) && raw.nextCommentSeq > 0 ? raw.nextCommentSeq : 1,
    blocks: [],
    comments: [],
    style:
      raw?.style !== null && typeof raw?.style === 'object'
        ? {
            tone: typeof raw.style.tone === 'string' ? raw.style.tone : 'нейтральный',
            person: typeof raw.style.person === 'string' ? raw.style.person : 'вы',
            avgSentence: Number.isFinite(raw.style.avgSentence) ? raw.style.avgSentence : 0,
            flags: Array.isArray(raw.style.flags) ? raw.style.flags.filter((flag) => typeof flag === 'string') : [],
          }
        : { tone: 'нейтральный', person: 'вы', avgSentence: 0, flags: [] },
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : isoNow(),
  }

  const seen = new Set()
  for (const value of Array.isArray(raw?.blocks) ? raw.blocks : []) {
    if (value === null || typeof value !== 'object') continue
    let id = typeof value.id === 'string' && value.id !== '' ? value.id : ''
    if (id === '' || seen.has(id)) {
      id = `b-${document.nextBlockSeq}`
      document.nextBlockSeq += 1
    }
    seen.add(id)
    const type = BLOCK_TYPES.includes(value.type) ? value.type : 'p'
    const block = { id, type }
    if (type === 'li') block.ordered = value.ordered === true
    block.spans = normalizeSpans(value.spans)
    document.blocks.push(block)
  }

  const commentIds = new Set()
  for (const value of Array.isArray(raw?.comments) ? raw.comments : []) {
    if (value === null || typeof value !== 'object') continue
    const id = typeof value.id === 'string' && value.id !== '' ? value.id : ''
    if (id === '' || commentIds.has(id)) continue
    commentIds.add(id)
    const block = document.blocks.find((entry) => entry.id === value.blockId)
    if (block === undefined) continue
    const length = plainText(block).length
    const from = Number.isInteger(value.from) ? Math.max(0, Math.min(value.from, length)) : 0
    const to = Number.isInteger(value.to) ? Math.max(from, Math.min(value.to, length)) : from
    document.comments.push({
      id,
      blockId: block.id,
      from,
      to,
      occurrence: Number.isInteger(value.occurrence) && value.occurrence >= 0 ? value.occurrence : 0,
      quote: typeof value.quote === 'string' ? value.quote : plainText(block).slice(from, to),
      note: typeof value.note === 'string' ? value.note : '',
      status: COMMENT_STATUSES.includes(value.status) ? value.status : 'open',
      reason: typeof value.reason === 'string' ? value.reason : null,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : isoNow(),
    })
  }

  return document
}
