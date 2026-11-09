/**
 * Applying edits: one replacement per comment, and nothing else moves.
 *
 * The commit planner lives here, apart from the Host service, because it is the part that must be
 * provably conservative:
 *
 * - edits of one block are applied **from the highest `to` down**, so an earlier offset is still
 *   valid when its turn comes;
 * - an edit that overlaps another edit of the same block is refused (the later one of the pair);
 * - a replacement that repeats the block text outside `[from, to)` is refused — that is the model
 *   returning a whole paragraph instead of the fragment;
 * - an empty replacement, the untouched quote itself, an over-limit fragment or a style drift is
 *   refused with a reason;
 * - every block nobody commented on keeps its SHA-256, and the planner checks that before it
 *   returns.
 *
 * Nothing is written by this module: it returns the next document for the caller to persist.
 */

import { blockHash, clone, documentText, normalizeSpans, plainText } from './model.js'
import { reanchorBlock } from './anchors.js'
import { driftReason } from './style.js'

/** The longest replacement allowed for a quote, by the contract. */
export const REPLACEMENT_MIN = 50
export const REPLACEMENT_MAX = 5_000

/**
 * The per-comment replacement limit: three times the quote, clamped to `[50, 5000]`.
 * @param {string} quote - the commented fragment.
 * @returns {number} the maximum replacement length.
 */
export function replacementLimit(quote) {
  return Math.min(Math.max(3 * String(quote ?? '').length, REPLACEMENT_MIN), REPLACEMENT_MAX)
}

/**
 * Replace `[from, to)` inside a span list, keeping the formatting of everything outside and
 * making the inserted text plain — a replacement is data, not markup.
 * @param {{t: string, b?: boolean, i?: boolean}[]} spans - the block's spans.
 * @param {number} from - start offset in the flat text.
 * @param {number} to - end offset in the flat text.
 * @param {string} replacement - the text to insert.
 * @returns {{t: string, b?: boolean, i?: boolean}[]} the new span list.
 */
export function replaceRange(spans, from, to, replacement) {
  const result = []
  let offset = 0
  let inserted = false
  for (const span of normalizeSpans(spans)) {
    const start = offset
    const end = offset + span.t.length
    offset = end
    if (end <= from || start >= to) {
      if (!inserted && start >= to) {
        result.push({ t: replacement })
        inserted = true
      }
      result.push(span)
      continue
    }
    if (start < from) result.push({ ...span, t: span.t.slice(0, from - start) })
    if (!inserted) {
      result.push({ t: replacement })
      inserted = true
    }
    if (end > to) result.push({ ...span, t: span.t.slice(to - start) })
  }
  if (!inserted) result.push({ t: replacement })
  return result.filter((span) => span.t !== '')
}

/**
 * Whether a replacement smuggles in the block's text from outside the commented range.
 * The check uses the complete prefix and the complete suffix when they are long enough to be
 * meaningful (10 characters), which is what "the model returned the whole paragraph" looks like.
 * @param {string} text - the block's flat text.
 * @param {number} from - start of the commented range.
 * @param {number} to - end of the commented range.
 * @param {string} replacement - the proposed text.
 * @returns {boolean} true when the replacement escapes the range.
 */
export function escapesRange(text, from, to, replacement) {
  const before = text.slice(0, from)
  const after = text.slice(to)
  if (before.length >= 10 && replacement.includes(before)) return true
  if (after.length >= 10 && replacement.includes(after)) return true
  return false
}

/**
 * Why one proposed replacement cannot be applied, or null when it can.
 * @param {{text: string, from: number, to: number, quote: string}} anchor - the fragment.
 * @param {string} replacement - the proposal.
 * @param {string} documentTextBefore - the document text before any edit.
 * @returns {string|null} a Russian reason, or null.
 */
export function replacementProblem(anchor, replacement, documentTextBefore) {
  const { from, to, quote, text } = anchor
  if (from < 0 || to > text.length || from >= to) return 'диапазон фрагмента вне блока'
  if (replacement === '') return 'пустая правка'
  if (replacement === quote) return 'правка совпадает с цитатой'
  if (replacement.length > replacementLimit(quote)) return 'правка длиннее предела для этой цитаты'
  if (escapesRange(text, from, to, replacement)) return 'правка выходит за границы фрагмента'
  const drift = driftReason(documentTextBefore, quote, replacement)
  if (drift !== null) return drift
  return null
}

/**
 * Apply a batch of accepted edits to a copy of the document.
 * @param {object} document - the current document.
 * @param {{items: {commentId: string}[], id: string}} batch - the pending batch.
 * @param {{commentId: string, replacement: string}[]} edits - what the model returned.
 * @param {string[]} accept - comment ids the person ticked; empty means "everything proposed".
 * @returns {{document: object, results: object[]}} the next document and one result per comment.
 */
export function planCommit(document, batch, edits, accept) {
  const next = clone(document)
  const textBefore = documentText(document)
  const proposed = new Map()
  for (const edit of edits) {
    if (edit !== null && typeof edit === 'object' && typeof edit.commentId === 'string') {
      proposed.set(edit.commentId, typeof edit.replacement === 'string' ? edit.replacement : '')
    }
  }
  const accepted = accept.length === 0 ? new Set(batch.items.map((item) => item.commentId)) : new Set(accept)

  /** @type {Map<string, {commentId: string, replacement: string, from: number, to: number}[]>} */
  const byBlock = new Map()
  /** @type {Map<string, {status: string, reason?: string}>} */
  const verdicts = new Map()

  for (const item of batch.items) {
    const comment = next.comments.find((entry) => entry.id === item.commentId)
    if (comment === undefined) {
      verdicts.set(item.commentId, { status: 'conflict', reason: 'комментарий больше не существует' })
      continue
    }
    if (!accepted.has(item.commentId)) {
      verdicts.set(item.commentId, { status: 'rejected', reason: 'отклонено пользователем' })
      continue
    }
    if (!proposed.has(item.commentId)) {
      verdicts.set(item.commentId, { status: 'failed', reason: 'модель не вернула правку' })
      continue
    }
    const block = next.blocks.find((entry) => entry.id === comment.blockId)
    if (block === undefined) {
      verdicts.set(item.commentId, { status: 'conflict', reason: 'блок фрагмента больше не существует' })
      continue
    }
    const replacement = proposed.get(item.commentId)
    const anchor = { text: plainText(block), from: comment.from, to: comment.to, quote: comment.quote }
    const problem = replacementProblem(anchor, replacement, textBefore)
    if (problem !== null) {
      verdicts.set(item.commentId, { status: 'conflict', reason: problem })
      continue
    }
    const list = byBlock.get(block.id) ?? []
    list.push({ commentId: item.commentId, replacement, from: comment.from, to: comment.to })
    byBlock.set(block.id, list)
  }

  const editedBlocks = new Set()

  for (const [blockId, list] of byBlock) {
    const block = next.blocks.find((entry) => entry.id === blockId)
    // Highest `to` first: an edit to the right of another never invalidates the one on its left.
    list.sort((left, right) => right.to - left.to || right.from - left.from)
    let spans = block.spans
    let text = plainText(block)
    let leftmostStart = Number.POSITIVE_INFINITY
    for (const edit of list) {
      if (edit.to > leftmostStart) {
        verdicts.set(edit.commentId, { status: 'conflict', reason: 'пересекается с другой правкой этого блока' })
        continue
      }
      spans = replaceRange(spans, edit.from, edit.to, edit.replacement)
      text = `${text.slice(0, edit.from)}${edit.replacement}${text.slice(edit.to)}`
      leftmostStart = edit.from
      verdicts.set(edit.commentId, { status: 'applied' })
    }
    block.spans = spans
    editedBlocks.add(blockId)
  }

  // The invariant behind "only the commented fragments change": every block nobody edited keeps
  // its hash. A mismatch would mean the planner itself moved text, so the commit is abandoned.
  for (const before of document.blocks) {
    if (editedBlocks.has(before.id)) continue
    const after = next.blocks.find((entry) => entry.id === before.id)
    if (after === undefined || blockHash(before) !== blockHash(after)) {
      throw new Error('CANVAS_INTERNAL: unchanged block hash mismatch')
    }
  }

  // Re-anchor every other comment of an edited block, so an applied neighbour does not orphan one.
  for (const blockId of editedBlocks) reanchorBlock(next, blockId)

  const results = []
  for (const item of batch.items) {
    const verdict = verdicts.get(item.commentId) ?? { status: 'failed', reason: 'правка не получена' }
    const comment = next.comments.find((entry) => entry.id === item.commentId)
    if (comment !== undefined) {
      comment.status = verdict.status
      comment.reason = verdict.status === 'applied' ? null : (verdict.reason ?? null)
    }
    results.push({
      commentId: item.commentId,
      status: verdict.status,
      reason: verdict.status === 'applied' ? null : (verdict.reason ?? null),
    })
  }
  return { document: next, results }
}
