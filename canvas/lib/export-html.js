/**
 * Offline HTML export: one self-contained page per document.
 *
 * The file must open with no network at all, so it carries its styles in a `<style>` block, names
 * only system fonts, and contains no `http://`, `https://`, `<script src` or `<link href`. Every
 * piece of user text — title, blocks, notes, quotes — passes through {@link escapeHtml}, because a
 * document about markup is exactly the document that contains `</style>` in a paragraph.
 */

import { plainText } from './model.js'

/**
 * Escape text for HTML text nodes and attribute values.
 * @param {string} value - the raw text.
 * @returns {string} the escaped text.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Render one span list as escaped inline HTML.
 * @param {{t: string, b?: boolean, i?: boolean}[]} spans - the block's spans.
 * @returns {string} the inline markup.
 */
function renderSpans(spans) {
  return (spans ?? [])
    .map((span) => {
      const text = escapeHtml(span.t)
      if (span.b === true && span.i === true) return `<strong><em>${text}</em></strong>`
      if (span.b === true) return `<strong>${text}</strong>`
      if (span.i === true) return `<em>${text}</em>`
      return text
    })
    .join('')
}

/**
 * Render one block as its HTML element.
 * @param {object} block - one block.
 * @param {number} position - 1-based block number, used by comment footnotes.
 * @returns {string} the block's HTML.
 */
function renderBlock(block, position) {
  const inner = renderSpans(block.spans)
  const anchor = ` id="block-${position}"`
  switch (block.type) {
    case 'h1':
      return `<h1${anchor}>${inner}</h1>`
    case 'h2':
      return `<h2${anchor}>${inner}</h2>`
    case 'h3':
      return `<h3${anchor}>${inner}</h3>`
    case 'li':
      return `<p class="li"${anchor}><span class="marker">${block.ordered === true ? '1.' : '•'}</span>${inner}</p>`
    case 'quote':
      return `<blockquote${anchor}>${inner}</blockquote>`
    case 'code':
      return `<pre${anchor}><code>${inner}</code></pre>`
    default:
      return `<p${anchor}>${inner}</p>`
  }
}

/** Styles carried by every exported page; system fonts only, no external resource. */
const STYLES = `
:root { color-scheme: light dark; }
body { margin: 0; background: #ffffff; color: #1b1b1f; font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
h1, h2, h3 { line-height: 1.25; margin: 2rem 0 0.75rem; }
h1 { font-size: 2rem; }
h2 { font-size: 1.5rem; }
h3 { font-size: 1.2rem; }
p, blockquote, pre { font-size: 1rem; line-height: 1.65; margin: 0 0 1rem; }
blockquote { border-left: 3px solid #c8c8d0; padding: 0 0 0 1rem; color: #4a4a55; }
pre { background: #f4f4f7; border-radius: 8px; padding: 1rem; overflow-x: auto; }
code { font-family: "Cascadia Mono", Consolas, "Courier New", monospace; font-size: 0.92em; }
.li { display: flex; gap: 0.6rem; }
.li .marker { color: #6b6b78; min-width: 1.4rem; }
.title { font-size: 2.2rem; margin: 0 0 0.5rem; }
.meta { color: #6b6b78; font-size: 0.85rem; margin: 0 0 2.5rem; }
.notes { margin-top: 3rem; border-top: 1px solid #d8d8e0; padding-top: 1.5rem; }
.notes h2 { font-size: 1.1rem; }
.notes ol { padding-left: 1.4rem; }
.notes li { margin-bottom: 0.9rem; line-height: 1.55; }
.notes .where { color: #6b6b78; font-size: 0.85rem; display: block; }
@media print { main { padding: 0; max-width: none; } a { color: inherit; } }
`

/**
 * Build the complete exported page.
 * @param {object} document - the document.
 * @param {{includeComments?: boolean, exportedAt?: string}} [options] - export options.
 * @returns {string} a complete HTML document.
 */
export function exportHtml(document, options = {}) {
  const includeComments = options.includeComments === true
  const title = escapeHtml(document?.title ?? 'Документ')
  const blocks = document?.blocks ?? []
  const comments = includeComments
    ? (document?.comments ?? []).filter((comment) => comment.status !== 'rejected')
    : []

  /** Footnote numbers by comment id, so an approximate comment still points somewhere. */
  const footnote = new Map()
  comments.forEach((comment, index) => footnote.set(comment.id, index + 1))

  const body = blocks
    .map((block, index) => {
      const position = index + 1
      const marks = comments
        .filter((comment) => comment.blockId === block.id)
        .map((comment) => `<sup>${footnote.get(comment.id)}</sup>`)
        .join('')
      return renderBlock(block, position) + marks
    })
    .join('\n')

  const notes =
    comments.length === 0
      ? ''
      : `<section class="notes"><h2>Комментарии</h2><ol>${comments
          .map((comment) => {
            const where = blocks.findIndex((block) => block.id === comment.blockId) + 1
            return (
              `<li>«${escapeHtml(comment.quote)}» — ${escapeHtml(comment.note === '' ? 'без заметки' : comment.note)}` +
              `<span class="where">абзац ${where === 0 ? '—' : where}</span></li>`
            )
          })
          .join('')}</ol></section>`

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1 class="title">${title}</h1>
<p class="meta">Холст · версия ${Number.isInteger(document?.version) ? document.version : 1}${options.exportedAt === undefined ? '' : ` · ${escapeHtml(options.exportedAt)}`}</p>
${body}
${notes}
</main>
</body>
</html>
`
}
