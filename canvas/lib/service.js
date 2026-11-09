/**
 * The Canvas service: one implementation behind every caller.
 *
 * The panel's HTTP routes and the model's tools both go through this class, so "write a paragraph"
 * has exactly one definition. The class owns three things the contract treats as state:
 *
 * 1. the active document, its version and its read-only mode;
 * 2. the one apply batch of the document — the lock that keeps a panel-initiated preparation and a
 *    model-initiated `canvas_apply` from running at once;
 * 3. the history file, which records what happened even when the document does not change shape.
 *
 * Everything that could be a pure function is not here: parsing lives in `markdown.js`, anchoring in
 * `anchors.js`, the commit arithmetic in `edits.js`, and files in `store.js`.
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  blockHash,
  clone,
  COMMENT_STATUSES,
  documentSize,
  isoNow,
  LIMITS,
  makeBlock,
  makeComment,
  normalizeSpans,
  plainText,
} from './model.js'
import { parseMarkdown } from './markdown.js'
import { occurrences, reanchorBlock } from './anchors.js'
import { planCommit, replacementLimit } from './edits.js'
import { stylePassport } from './style.js'
import { exportHtml } from './export-html.js'
import { fail } from './errors.js'
import { writeAtomic } from './store.js'

/** How long a prepared batch waits for the model before its comments fail. */
export const PENDING_TTL_MS = 10 * 60 * 1000

/** Comment states that still need an edit. */
export const OPEN_STATUSES = Object.freeze(['open', 'approximate'])

/**
 * Parse an `If-Match` value: `12` and `"12"` are the same version.
 * @param {unknown} value - the header value (or a body field).
 * @returns {number|null} the version, or null when it is not a version at all.
 */
export function parseIfMatch(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^W\//u, '')
  const quoted = /^"(\d+)"$/u.exec(trimmed)
  if (quoted !== null) return Number(quoted[1])
  if (/^\d+$/u.test(trimmed)) return Number(trimmed)
  return null
}

/**
 * The active canvas document plus its apply batch.
 */
export class CanvasService {
  /**
   * @param {{store: object, now?: () => Date, productsDirectory?: () => string}} options - the
   *   durable store, a clock (tests freeze it) and where an export lands.
   */
  constructor(options) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.productsDirectory = options.productsDirectory ?? (() => join(this.store.root, 'exports'))
    /** @type {{document: object, readOnly: boolean, newerSchema: boolean}} */
    this.state = this.store.loadActive()
    /** @type {object|null} the single apply batch of this document. */
    this.batch = null
    /** @type {object|null} the last finished batch, for an idempotent repeat. */
    this.lastCommitted = null
  }

  /** The live document. */
  get document() {
    return this.state.document
  }

  /** Whether the document came from a newer schema and must stay untouched. */
  get readOnly() {
    return this.state.readOnly
  }

  /** The current version. */
  get version() {
    return this.state.document.version
  }

  /** Refuse any mutation of a read-only document. */
  assertWritable() {
    if (!this.state.readOnly) return
    fail(
      'STALE_VERSION',
      'документ создан более новой версией DSH; откройте его там или создайте новый через POST /canvas/doc/new',
    )
  }

  /**
   * Bump the version and the timestamp of any document change.
   * @param {object} document - the document being changed.
   */
  touch(document) {
    document.version += 1
    document.updatedAt = isoNow(this.now())
  }

  /** A detached copy of the active document, for HTTP responses. */
  snapshot() {
    return {
      version: this.document.version,
      document: clone(this.document),
      readOnly: this.state.readOnly,
      newerSchema: this.state.newerSchema,
    }
  }

  /**
   * Parse markdown-lite and mint blocks from the document counter.
   * @param {string} text - the tool input.
   * @returns {object[]} blocks without ids yet.
   */
  parseBlocks(text) {
    return parseMarkdown(text)
  }

  /**
   * Append blocks at the end, or directly after one existing block.
   * @param {string} text - markdown-lite.
   * @param {string} [after] - the block id to insert after.
   * @returns {{added: number, blocks: object[], version: number}} the outcome.
   */
  write(text, after) {
    this.assertWritable()
    const source = typeof text === 'string' ? text : ''
    if (source.trim() === '') fail('INVALID_TEXT', 'canvas_write нужен текст; ничего не добавлено')
    if (source.length > LIMITS.write) {
      fail('EDIT_TOO_LONG', `canvas_write принимает не больше ${LIMITS.write} знаков; разделите текст на части`)
    }
    if (after !== undefined && after !== null) {
      if (!this.document.blocks.some((block) => block.id === after)) {
        fail('UNKNOWN_BLOCK', `в документе нет блока «${String(after)}»; идентификаторы перечисляет canvas_read`)
      }
    }
    const parsed = this.parseBlocks(source)
    if (parsed.length === 0) fail('INVALID_TEXT', 'из текста не получилось блоков; пришлите обычные абзацы')

    const projected = documentSize(this.document) + parsed.reduce((sum, block) => sum + plainText(block).length, 0)
    if (projected > LIMITS.document) {
      fail('CANVAS_FULL', `документ превысит ${LIMITS.document} знаков; создайте новый документ`)
    }

    const blocks = parsed.map((block) => makeBlock(this.document, block.type, block.spans, block.ordered))
    if (after === undefined || after === null) this.document.blocks.push(...blocks)
    else {
      const index = this.document.blocks.findIndex((block) => block.id === after)
      this.document.blocks.splice(index + 1, 0, ...blocks)
    }
    this.touch(this.document)
    this.store.save(this.document)
    this.store.appendHistory(this.document.id, {
      op: 'write',
      summary: `дописано блоков: ${blocks.length}`,
      version: this.document.version,
    })
    return { added: blocks.length, blocks: blocks.map((block) => block.id), version: this.document.version }
  }

  /**
   * Replace the whole document with parsed markdown.
   * Every existing comment becomes `orphaned` — none is deleted.
   * @param {string} text - markdown-lite.
   * @returns {{blocks: number, version: number}} the outcome.
   */
  replace(text) {
    this.assertWritable()
    const source = typeof text === 'string' ? text : ''
    if (source.trim() === '') fail('INVALID_TEXT', 'canvas_replace нужен текст; чтобы очистить документ, используйте canvas_clear')
    const parsed = this.parseBlocks(source)
    if (parsed.length === 0) fail('INVALID_TEXT', 'из текста не получилось блоков')
    const size = parsed.reduce((sum, block) => sum + plainText(block).length, 0)
    if (size > LIMITS.document) {
      fail('CANVAS_FULL', `текст доведёт документ до ${size} знаков — это больше предела ${LIMITS.document}`)
    }

    this.document.blocks = parsed.map((block) => makeBlock(this.document, block.type, block.spans, block.ordered))
    for (const comment of this.document.comments) {
      comment.status = 'orphaned'
      comment.reason = 'документ перезаписан'
    }
    this.touch(this.document)
    this.store.saveNow(this.document)
    this.store.appendHistory(this.document.id, {
      op: 'replace',
      summary: `документ перезаписан, блоков: ${this.document.blocks.length}`,
      version: this.document.version,
    })
    return { blocks: this.document.blocks.length, version: this.document.version }
  }

  /**
   * Set the document title.
   * @param {string} title - the new title.
   * @returns {{title: string, version: number}} the outcome.
   */
  setTitle(title) {
    this.assertWritable()
    const value = typeof title === 'string' ? title.trim() : ''
    if (value === '') fail('INVALID_TEXT', 'canvas_set_title нужен непустой заголовок')
    if (value.length > 300) fail('EDIT_TOO_LONG', 'заголовок принимает не больше 300 знаков')
    this.document.title = value
    this.touch(this.document)
    this.store.save(this.document)
    this.store.appendHistory(this.document.id, { op: 'title', summary: `заголовок: ${value}`, version: this.document.version })
    return { title: value, version: this.document.version }
  }

  /**
   * Empty the document: blocks and comments go, the counters and the history stay.
   * @param {unknown} confirm - must be `true`.
   * @returns {{version: number}} the outcome.
   */
  clear(confirm) {
    this.assertWritable()
    if (confirm !== true) {
      fail('INVALID_TEXT', 'canvas_clear удаляет все блоки и комментарии; вызовите его с confirm: true')
    }
    this.document.blocks = []
    this.document.comments = []
    this.document.style = { tone: 'нейтральный', person: 'вы', avgSentence: 0, flags: [] }
    this.batch = null
    this.touch(this.document)
    this.store.saveNow(this.document)
    this.store.appendHistory(this.document.id, { op: 'clear', summary: 'документ очищен', version: this.document.version })
    return { version: this.document.version }
  }

  /**
   * A window of blocks, capped so a 200 000-character document is never returned whole.
   * @param {{from?: number, to?: number, includeComments?: boolean}} [options] - the window.
   * @returns {{items: object[], total: number, from: number, to: number, comments?: object[]}} the window.
   */
  read(options = {}) {
    const total = this.document.blocks.length
    const from = Number.isInteger(options.from) ? Math.max(0, Math.min(options.from, total)) : 0
    const requested = Number.isInteger(options.to) ? options.to : from + LIMITS.readDefault
    const to = Math.max(from, Math.min(requested, from + LIMITS.readMax, total))
    const items = this.document.blocks.slice(from, to).map((block, index) => ({
      id: block.id,
      type: block.type,
      ...(block.type === 'li' ? { ordered: block.ordered === true } : {}),
      text: plainText(block),
      index: from + index,
    }))
    const result = { items, total, from, to }
    if (options.includeComments === true) {
      result.comments = this.document.comments.map((comment) => ({
        id: comment.id,
        blockId: comment.blockId,
        quote: comment.quote,
        note: comment.note,
        status: comment.status,
      }))
    }
    return result
  }

  /**
   * The comment list, optionally filtered by status.
   * @param {{status?: string}} [options] - the filter.
   * @returns {{items: object[], total: number, open: number}} the comments.
   */
  comments(options = {}) {
    const status = typeof options.status === 'string' ? options.status : ''
    if (status !== '' && !COMMENT_STATUSES.includes(status)) {
      fail('INVALID_TEXT', `неизвестный статус «${status}»; допустимы: ${COMMENT_STATUSES.join(', ')}`)
    }
    const items = this.document.comments
      .filter((comment) => status === '' || comment.status === status)
      .map((comment) => ({
        id: comment.id,
        blockId: comment.blockId,
        quote: comment.quote,
        note: comment.note,
        status: comment.status,
        reason: comment.reason,
        from: comment.from,
        to: comment.to,
      }))
    return {
      items,
      total: this.document.comments.length,
      open: this.document.comments.filter((comment) => OPEN_STATUSES.includes(comment.status)).length,
    }
  }

  /**
   * Add a comment over a fragment of one block — the panel's "Прокомментировать".
   * @param {{blockId: string, from: number, to: number, note?: string, quote?: string}} input - the anchor.
   * @returns {object} the created comment.
   */
  addComment(input) {
    this.assertWritable()
    const block = this.document.blocks.find((entry) => entry.id === input?.blockId)
    if (block === undefined) fail('UNKNOWN_BLOCK', `в документе нет блока «${String(input?.blockId)}»`)
    const text = plainText(block)
    const from = Number.isInteger(input.from) ? Math.max(0, Math.min(input.from, text.length)) : 0
    const to = Number.isInteger(input.to) ? Math.max(from, Math.min(input.to, text.length)) : from
    if (to <= from) fail('INVALID_TEXT', 'комментарию нужно непустое выделение внутри одного блока')
    const quote = text.slice(from, to)
    if (quote.length > LIMITS.quote) {
      fail('QUOTE_TOO_LONG', `цитата принимает не больше ${LIMITS.quote} знаков; выделите фрагмент короче`)
    }
    if (this.document.comments.length >= LIMITS.comments) {
      fail('INVALID_TEXT', `на документе уже ${LIMITS.comments} комментариев; закройте часть, прежде чем добавлять новые`)
    }
    const before = occurrences(text, quote).filter((offset) => offset < from).length
    const comment = makeComment(this.document, {
      blockId: block.id,
      from,
      to,
      occurrence: before,
      quote,
      note: typeof input.note === 'string' ? input.note : '',
      createdAt: isoNow(this.now()),
    })
    this.document.comments.push(comment)
    this.touch(this.document)
    this.store.save(this.document)
    return comment
  }

  /**
   * Edit a comment's note.
   * @param {string} commentId - the comment.
   * @param {string} note - the new note.
   * @returns {object} the updated comment.
   */
  updateComment(commentId, note) {
    this.assertWritable()
    const comment = this.document.comments.find((entry) => entry.id === commentId)
    if (comment === undefined) fail('UNKNOWN_COMMENT', `в документе нет комментария «${String(commentId)}»`)
    comment.note = typeof note === 'string' ? note : ''
    this.touch(this.document)
    this.store.save(this.document)
    return comment
  }

  /**
   * Delete one comment.
   * @param {string} commentId - the comment.
   * @returns {{deleted: string}} the outcome.
   */
  deleteComment(commentId) {
    this.assertWritable()
    const index = this.document.comments.findIndex((entry) => entry.id === commentId)
    if (index === -1) fail('UNKNOWN_COMMENT', `в документе нет комментария «${String(commentId)}»`)
    this.document.comments.splice(index, 1)
    this.touch(this.document)
    this.store.save(this.document)
    return { deleted: commentId }
  }

  /**
   * Close a comment by hand, without applying an edit.
   * @param {string} commentId - the comment.
   * @returns {object} the updated comment.
   */
  resolveComment(commentId) {
    this.assertWritable()
    const comment = this.document.comments.find((entry) => entry.id === commentId)
    if (comment === undefined) fail('UNKNOWN_COMMENT', `в документе нет комментария «${String(commentId)}»`)
    comment.status = 'applied'
    comment.reason = null
    this.touch(this.document)
    this.store.save(this.document)
    this.store.appendHistory(this.document.id, {
      op: 'resolve',
      summary: `комментарий ${commentId} решён вручную`,
      version: this.document.version,
    })
    return comment
  }

  /**
   * Re-attach an orphaned comment to a new fragment.
   * @param {{commentId: string, blockId: string, from: number, to: number}} input - the new anchor.
   * @returns {object} the updated comment.
   */
  reanchorComment(input) {
    this.assertWritable()
    const comment = this.document.comments.find((entry) => entry.id === input?.commentId)
    if (comment === undefined) fail('UNKNOWN_COMMENT', `в документе нет комментария «${String(input?.commentId)}»`)
    const block = this.document.blocks.find((entry) => entry.id === input.blockId)
    if (block === undefined) fail('UNKNOWN_BLOCK', `в документе нет блока «${String(input.blockId)}»`)
    const text = plainText(block)
    const from = Math.max(0, Math.min(Number.isInteger(input.from) ? input.from : 0, text.length))
    const to = Math.max(from, Math.min(Number.isInteger(input.to) ? input.to : from, text.length))
    if (to <= from) fail('INVALID_TEXT', 'выберите непустой фрагмент внутри одного блока')
    const quote = text.slice(from, to)
    if (quote.length > LIMITS.quote) fail('QUOTE_TOO_LONG', `цитата принимает не больше ${LIMITS.quote} знаков`)
    comment.blockId = block.id
    comment.from = from
    comment.to = to
    comment.quote = quote
    comment.occurrence = occurrences(text, quote).filter((offset) => offset < from).length
    comment.status = 'open'
    comment.reason = null
    this.touch(this.document)
    this.store.save(this.document)
    this.store.appendHistory(this.document.id, {
      op: 'reanchor',
      summary: `комментарий ${comment.id} перепривязан к абзацу ${this.document.blocks.indexOf(block) + 1}`,
      version: this.document.version,
    })
    return comment
  }

  /**
   * Replace one block's spans from the editor, keeping every comment of that block alive.
   * @param {{blockId: string, spans: unknown}} input - the edited block.
   * @param {unknown} expectedVersion - the `If-Match` value.
   * @returns {{version: number, comments: object[]}} the outcome.
   */
  editBlock(input, expectedVersion) {
    this.assertWritable()
    const version = parseIfMatch(expectedVersion)
    if (version === null) fail('STALE_VERSION', 'передайте If-Match с версией документа: 12 или "12"')
    if (version !== this.document.version) {
      fail('STALE_VERSION', 'документ изменился; обновите его перед записью, чтобы не потерять правки')
    }
    const block = this.document.blocks.find((entry) => entry.id === input?.blockId)
    if (block === undefined) fail('UNKNOWN_BLOCK', `в документе нет блока «${String(input?.blockId)}»`)
    block.spans = normalizeSpans(input.spans)
    const size = documentSize(this.document)
    if (size > LIMITS.document) {
      fail('CANVAS_FULL', `документ занимает ${size} знаков — это больше предела ${LIMITS.document}`)
    }
    const touched = reanchorBlock(this.document, block.id)
    this.touch(this.document)
    this.store.save(this.document)
    return { version: this.document.version, comments: touched }
  }

  /**
   * Begin an application: one batch, one lock, packages for the model.
   * @param {{commentIds?: string[], sessionId?: string, mode?: 'ui'|'model'}} options - the request.
   * @returns {{batchId: string, count: number, packages: object[], instruction: string}} the batch.
   */
  beginApply(options = {}) {
    this.assertWritable()
    this.expire()
    if (this.batch !== null) {
      fail('APPLY_IN_PROGRESS', 'уже идёт другое применение; завершите или отмените его, прежде чем начинать новое')
    }
    const open = this.document.comments.filter((comment) => OPEN_STATUSES.includes(comment.status))
    if (open.length === 0) fail('NOTHING_TO_APPLY', 'открытых комментариев нет; сначала добавьте комментарий')
    let chosen = open
    if (Array.isArray(options.commentIds) && options.commentIds.length > 0) {
      const wanted = new Set(options.commentIds)
      for (const id of wanted) {
        if (!this.document.comments.some((comment) => comment.id === id)) {
          fail('UNKNOWN_COMMENT', `в документе нет комментария «${id}»`)
        }
      }
      chosen = open.filter((comment) => wanted.has(comment.id))
      if (chosen.length === 0) fail('NOTHING_TO_APPLY', 'ни один из названных комментариев не открыт')
    }

    const style = stylePassport(this.document)
    const packages = chosen.map((comment) => {
      const index = this.document.blocks.findIndex((block) => block.id === comment.blockId)
      const block = this.document.blocks[index]
      const before = index > 0 ? plainText(this.document.blocks[index - 1]) : ''
      const after = index >= 0 && index + 1 < this.document.blocks.length ? plainText(this.document.blocks[index + 1]) : ''
      return {
        commentId: comment.id,
        blockId: comment.blockId,
        from: comment.from,
        to: comment.to,
        quote: comment.quote,
        note: comment.note,
        replacementLimit: replacementLimit(comment.quote),
        block: plainText(block),
        before,
        after,
      }
    })
    const batch = {
      id: `batch-${this.now().getTime().toString(36)}-${randomBytes(3).toString('hex')}`,
      mode: options.mode === 'ui' ? 'ui' : 'model',
      sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
      createdAt: this.now().getTime(),
      status: 'collecting',
      style,
      items: packages.map((item) => ({
        commentId: item.commentId,
        blockId: item.blockId,
        from: item.from,
        to: item.to,
        quote: item.quote,
        note: item.note,
        replacement: null,
      })),
      packages,
      modelJoined: false,
    }
    this.batch = batch
    return {
      batchId: batch.id,
      count: packages.length,
      packages,
      style,
      instruction:
        'теперь вызовите `canvas_apply_edits` — по одной правке на каждый commentId; правка заменяет РОВНО диапазон ' +
        '[from, to) этого блока, а не весь блок',
    }
  }

  /**
   * The model's `canvas_apply`: attach to a panel-prepared batch, or open one.
   * @param {{commentIds?: string[]}} [options] - an optional subset.
   * @returns {{batchId: string, count: number, packages: object[], instruction: string}} the batch.
   */
  apply(options = {}) {
    this.expire()
    if (this.batch !== null) {
      if (this.batch.mode === 'ui' && !this.batch.modelJoined && this.batch.status === 'collecting') {
        this.batch.modelJoined = true
        return {
          batchId: this.batch.id,
          count: this.batch.packages.length,
          packages: this.batch.packages,
          style: this.batch.style,
          instruction:
            'теперь вызовите `canvas_apply_edits` — по одной правке на каждый commentId; правка заменяет РОВНО диапазон ' +
            '[from, to) этого блока, а не весь блок',
        }
      }
      fail('APPLY_IN_PROGRESS', 'применение уже идёт; пользователь подтверждает или отменяет его в панели «Холст»')
    }
    const started = this.beginApply({ commentIds: options.commentIds, mode: 'model' })
    this.batch.modelJoined = true
    return started
  }

  /**
   * Accept the model's edits into the pending set. Nothing is applied here.
   * @param {{commentId: string, replacement: string}[]} edits - one replacement per comment.
   * @returns {{batchId: string, count: number}} the pending set.
   */
  applyEdits(edits) {
    this.assertWritable()
    this.expire()
    if (this.batch === null) {
      fail('PENDING_MISSING', 'сначала вызовите `canvas_apply`; правки без подготовленной партии не принимаются')
    }
    if (this.batch.status !== 'collecting') {
      fail('PENDING_MISSING', 'эта партия больше не принимает правки; пользователь подтверждает её в панели «Холст»')
    }
    if (!Array.isArray(edits)) fail('INVALID_TEXT', 'edits — массив объектов { commentId, replacement }')
    const known = new Set(this.batch.items.map((item) => item.commentId))
    const seen = new Set()
    for (const edit of edits) {
      if (edit === null || typeof edit !== 'object') fail('INVALID_TEXT', 'каждая правка — объект { commentId, replacement }')
      if (typeof edit.commentId !== 'string' || !known.has(edit.commentId)) {
        fail('UNKNOWN_COMMENT', `комментария «${String(edit?.commentId)}» нет в этой партии; вся пачка отклонена`)
      }
      if (seen.has(edit.commentId)) fail('INVALID_TEXT', `комментарий «${edit.commentId}» указан дважды; пришлите одну правку на комментарий`)
      seen.add(edit.commentId)
      if (typeof edit.replacement !== 'string') fail('INVALID_TEXT', `replacement для «${edit.commentId}» должен быть строкой`)
      const item = this.batch.items.find((entry) => entry.commentId === edit.commentId)
      if (edit.replacement.length > replacementLimit(item.quote)) {
        fail('EDIT_TOO_LONG', `правка для «${edit.commentId}» длиннее предела ${replacementLimit(item.quote)} знаков`)
      }
    }
    for (const item of this.batch.items) {
      const edit = edits.find((entry) => entry.commentId === item.commentId)
      item.replacement = edit === undefined ? null : edit.replacement
    }
    this.batch.status = 'pending'
    return { batchId: this.batch.id, count: this.batch.items.length }
  }

  /**
   * What the panel polls: the batch waiting for a human decision, or null.
   * @returns {object|null} the pending view.
   */
  pending() {
    this.expire()
    if (this.batch === null || this.batch.status !== 'pending') return null
    const items = this.batch.items
      .map((item) => {
        const comment = this.document.comments.find((entry) => entry.id === item.commentId)
        return {
          commentId: item.commentId,
          blockId: item.blockId,
          quote: item.quote,
          note: item.note,
          before: comment === undefined ? item.quote : comment.quote,
          after: item.replacement ?? '',
          offered: item.replacement !== null,
        }
      })
      .filter((item) => item.offered)
    if (items.length === 0) return null
    return { batchId: this.batch.id, count: items.length, items, createdAt: this.batch.createdAt }
  }

  /**
   * Apply the accepted edits atomically. The file is written before the in-memory state moves, and
   * a repeated commit of the same batch returns the stored result instead of applying twice.
   * @param {{batchId: string, accept?: string[]}} request - the human decision.
   * @returns {{version: number, applied: number, conflicts: object[], batchId: string}} the outcome.
   */
  commit(request = {}) {
    this.assertWritable()
    this.expire()
    const batchId = typeof request.batchId === 'string' ? request.batchId : ''
    if (this.lastCommitted !== null && this.lastCommitted.batchId === batchId) {
      return { ...this.lastCommitted.result, batchId }
    }
    if (this.batch === null || this.batch.id !== batchId) {
      fail('UNKNOWN_BATCH', `партия «${batchId}» не ждёт решения; обновите панель`)
    }
    if (this.batch.status !== 'pending') {
      fail('PENDING_MISSING', 'в этой партии нет правок; модель ещё не ответила')
    }
    const accept = Array.isArray(request.accept) ? request.accept.filter((id) => typeof id === 'string') : []
    const beforeCommit = clone(this.document)
    const edits = this.batch.items
      .filter((item) => typeof item.replacement === 'string')
      .map((item) => ({ commentId: item.commentId, replacement: item.replacement }))
    const planned = planCommit(this.document, this.batch, edits, accept)
    // The passport recomputed at preparation becomes part of the document with the commit.
    planned.document.style = this.batch.style
    planned.document.version = this.document.version + 1
    planned.document.updatedAt = isoNow(this.now())
    // Atomic on disk first: a failed write leaves the document untouched in memory too.
    this.store.saveNow(planned.document)
    this.state.document = planned.document
    const applied = planned.results.filter((result) => result.status === 'applied').length
    const result = {
      version: this.document.version,
      applied,
      conflicts: planned.results.filter((result) => result.status !== 'applied'),
    }
    this.store.appendHistory(this.document.id, {
      op: 'apply',
      summary: `применено правок: ${applied} из ${planned.results.length}`,
      version: this.document.version,
    })
    this.lastCommitted = { batchId, result, before: beforeCommit }
    this.batch = null
    return { ...result, batchId }
  }

  /**
   * Cancel a batch, or roll a committed one back to the byte-identical document it had before.
   * @param {{batchId: string}} request - the batch to discard.
   * @returns {{restored: boolean, version?: number}} the outcome.
   */
  discard(request = {}) {
    const batchId = typeof request.batchId === 'string' ? request.batchId : ''
    if (this.lastCommitted !== null && this.lastCommitted.batchId === batchId) {
      this.assertWritable()
      const restored = clone(this.lastCommitted.before)
      this.store.saveNow(restored)
      this.state.document = restored
      // Every comment of the batch returns to the open state, re-anchored against the restored text.
      for (const comment of this.document.comments) {
        if (comment.status === 'applied' || comment.status === 'conflict' || comment.status === 'failed' || comment.status === 'rejected') {
          comment.status = 'open'
          comment.reason = null
        }
      }
      for (const block of this.document.blocks) reanchorBlock(this.document, block.id)
      this.store.saveNow(this.document)
      this.store.appendHistory(this.document.id, {
        op: 'discard',
        summary: `применение ${batchId} отменено`,
        version: this.document.version,
      })
      this.lastCommitted = null
      return { restored: true, version: this.document.version }
    }
    if (this.batch === null || this.batch.id !== batchId) {
      fail('UNKNOWN_BATCH', `партия «${batchId}» неизвестна; обновите панель`)
    }
    this.batch = null
    return { restored: false }
  }

  /**
   * Fail the comments of a batch that waited longer than {@link PENDING_TTL_MS}.
   * @returns {boolean} whether a batch expired.
   */
  expire() {
    if (this.batch === null) return false
    if (this.batch.status !== 'collecting' && this.batch.status !== 'pending') return false
    if (this.now().getTime() - this.batch.createdAt <= PENDING_TTL_MS) return false
    for (const item of this.batch.items) {
      const comment = this.document.comments.find((entry) => entry.id === item.commentId)
      if (comment === undefined) continue
      comment.status = 'failed'
      comment.reason = 'модель не ответила'
    }
    const batchId = this.batch.id
    this.batch = null
    this.touch(this.document)
    this.store.save(this.document)
    this.store.appendHistory(this.document.id, {
      op: 'expire',
      summary: `применение ${batchId} истекло по TTL`,
      version: this.document.version,
    })
    return true
  }

  /**
   * Archive the active document and start an empty one. The old file stays on disk.
   * @returns {{document: object, readOnly: boolean}} the new document.
   */
  newDocument() {
    this.store.flush()
    const document = this.store.archiveActive()
    this.state = { document, readOnly: false, newerSchema: false }
    this.batch = null
    this.lastCommitted = null
    this.store.appendHistory(document.id, { op: 'new-document', summary: 'создан новый документ', version: 1 })
    return { document: clone(document), readOnly: false }
  }

  /**
   * Write one offline HTML page into the products directory.
   * @param {{includeComments?: boolean}} [options] - whether comments become footnotes.
   * @returns {{path: string, bytes: number}} where the file landed.
   */
  exportPage(options = {}) {
    const directory = this.productsDirectory()
    const date = this.now()
    const pad = (value) => String(value).padStart(2, '0')
    const stamp =
      `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    const path = join(directory, `холст-${this.document.id}-${stamp}.html`)
    const html = exportHtml(this.document, {
      includeComments: options.includeComments === true,
      exportedAt: isoNow(date),
    })
    writeAtomic(path, html)
    return { path, bytes: Buffer.byteLength(html, 'utf8') }
  }

  /** SHA-256 of every block, by id — the value the tests compare across a commit. */
  hashes() {
    const result = {}
    for (const block of this.document.blocks) result[block.id] = blockHash(block)
    return result
  }
}
