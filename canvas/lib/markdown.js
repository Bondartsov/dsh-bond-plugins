/**
 * Markdown-lite: the only input syntax `canvas_write` and `canvas_replace` accept.
 *
 * The vocabulary is deliberately tiny, because everything the parser drops is a fragment the user
 * cannot comment on afterwards:
 *
 * | source | block |
 * |---|---|
 * | `# `, `## `, `### ` | `h1`, `h2`, `h3` |
 * | `- ` | `li` with `ordered: false` |
 * | `1. ` (any number) | `li` with `ordered: true` |
 * | `> ` | `quote` |
 * | ```` ``` ```` fence | `code` (verbatim, no inline formatting) |
 * | anything else | `p` |
 *
 * Paragraphs are separated by a blank line and each becomes its own block. Inside a paragraph the
 * only inline markup is `**bold**` and `*italic*`; anything else stays literal text, so a stray
 * `#` in the middle of a sentence cannot silently change the block type.
 */

/** One heading marker with its type. */
const HEADINGS = [
  ['### ', 'h3'],
  ['## ', 'h2'],
  ['# ', 'h1'],
]

/** Inline tokenizer: a bold run first, so `**x**` is never read as two italic runs. */
const INLINE = /\*\*([^*]+)\*\*|\*([^*]+)\*/g

/**
 * Split one line's text into bold/italic spans.
 * @param {string} text - the line without its block marker.
 * @returns {{t: string, b?: boolean, i?: boolean}[]} spans covering the complete text.
 */
export function parseInline(text) {
  const spans = []
  let cursor = 0
  INLINE.lastIndex = 0
  let match = INLINE.exec(text)
  while (match !== null) {
    if (match.index > cursor) spans.push({ t: text.slice(cursor, match.index) })
    if (match[1] !== undefined) spans.push({ t: match[1], b: true })
    else spans.push({ t: match[2], i: true })
    cursor = match.index + match[0].length
    match = INLINE.exec(text)
  }
  if (cursor < text.length) spans.push({ t: text.slice(cursor) })
  return spans.filter((span) => span.t !== '')
}

/**
 * The paragraph shape of one non-code block, before inline formatting.
 * @param {string} line - one source line.
 * @returns {{type: string, ordered?: boolean, text: string}} the block shape.
 */
function blockOfLine(line) {
  for (const [marker, type] of HEADINGS) {
    if (line.startsWith(marker)) return { type, text: line.slice(marker.length) }
  }
  if (line.startsWith('- ')) return { type: 'li', ordered: false, text: line.slice(2) }
  if (line.startsWith('> ')) return { type: 'quote', text: line.slice(2) }
  const ordered = /^(\d+)\.\s+/.exec(line)
  if (ordered !== null) return { type: 'li', ordered: true, text: line.slice(ordered[0].length) }
  return { type: 'p', text: line }
}

/**
 * Parse markdown-lite into block descriptions, without ids (the caller mints them from the
 * document counter, so ids stay monotonic even after deletions).
 * @param {string} source - the text a tool received.
 * @returns {{type: string, ordered?: boolean, spans: {t: string, b?: boolean, i?: boolean}[]}[]} blocks in order.
 */
export function parseMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n?/gu, '\n')
  const lines = text.split('\n')
  const blocks = []
  /** Lines of the paragraph being assembled, with their block shape. */
  let paragraph = null

  const flush = () => {
    if (paragraph === null) return
    const { type, ordered, lines: collected } = paragraph
    paragraph = null
    if (type === 'p') {
      // A multi-line paragraph keeps its line breaks: dropping them would change the text the
      // user later comments on, and the flat offsets with it.
      const spans = []
      collected.forEach((line, index) => {
        if (index > 0) spans.push({ t: '\n' })
        spans.push(...parseInline(line))
      })
      blocks.push({ type, spans })
      return
    }
    blocks.push({ type, ordered, spans: parseInline(collected.join('\n')) })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('```')) {
      flush()
      const code = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index])
        index += 1
      }
      blocks.push({ type: 'code', spans: code.length === 0 ? [] : [{ t: code.join('\n') }] })
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    const shape = blockOfLine(line)
    if (paragraph === null) {
      paragraph = { type: shape.type, ordered: shape.ordered, lines: [shape.text] }
      continue
    }
    // A marker of a different block shape starts a new block even without a blank line, which is
    // what a person means by writing a heading right under a paragraph.
    if (shape.type !== paragraph.type || shape.ordered !== paragraph.ordered) {
      flush()
      paragraph = { type: shape.type, ordered: shape.ordered, lines: [shape.text] }
      continue
    }
    paragraph.lines.push(shape.text)
  }
  flush()
  return blocks
}

/**
 * Render one block back to markdown-lite — used by the panel's copy action and by tests.
 * @param {object} block - one block.
 * @returns {string} its markdown-lite line(s).
 */
export function blockToMarkdown(block) {
  const text = (block?.spans ?? []).map((span) => span.t).join('')
  switch (block?.type) {
    case 'h1':
      return `# ${text}`
    case 'h2':
      return `## ${text}`
    case 'h3':
      return `### ${text}`
    case 'li':
      return block.ordered === true ? `1. ${text}` : `- ${text}`
    case 'quote':
      return `> ${text}`
    case 'code':
      return `\`\`\`\n${text}\n\`\`\``
    default:
      return text
  }
}
