/**
 * Canvas — the document the assistant writes and the person comments on.
 *
 * Host half. It owns the document service, the eight model-facing tools, the HTTP routes the panel
 * calls, one apply batch at a time, and the one prompt section that tells a model the canvas
 * exists. Everything the panel can do, a model can ask for through a tool; both paths enter
 * {@link CanvasService}, so there is exactly one implementation of each operation.
 *
 * Applying comments is deliberately asymmetric: the model prepares edits, the person commits them.
 * `POST /canvas/apply/prepare` wakes the agent through its inbox (`agent.inject` + `agent.followup`)
 * instead of writing a synthetic user message into the conversation.
 *
 * No external dependencies: Node built-ins and Cordis services only.
 */

export const name = 'canvas'

// `webServer` and `agents` are declared so the Loader publishes them before activation: on a cold
// start the routes and the wake-up path then exist from the first request. A deployment without an
// HTTP carrier keeps the tools and simply has no panel routes.
export const inject = ['tools', 'systemPrompt', 'webServer', 'agents']

import { homedir } from 'node:os'
import { join } from 'node:path'
import { CanvasService } from './lib/service.js'
import { CanvasStore } from './lib/store.js'
import { errorBody, fail } from './lib/errors.js'
import { LIMITS } from './lib/model.js'

/** Same-origin guard for every route, copied from the verified peer-bus pattern. */
function sameOrigin(request) {
  const site = request?.headers?.['sec-fetch-site']
  if (site === undefined || site === null) return true
  return String(site).trim().toLowerCase() === 'same-origin'
}

/**
 * Read a JSON request body, bounded in size.
 * @param {object} request - the Node incoming message.
 * @param {number} limit - maximum accepted body size in bytes.
 * @returns {Promise<unknown>} the parsed body, or `undefined`.
 */
function readJsonBody(request, limit = 2 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        finish(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(undefined)
      }
    })
    request.on('error', () => finish(undefined))
  })
}

/** JSON response with no caching. */
function respondJson(response, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** The one error body shape every route uses. */
function respondError(response, status, code, hint) {
  respondJson(response, status, { code, hint })
}

/**
 * HTTP status for a contract code.
 * @param {string} code - the contract code.
 * @returns {number} the status the route answers with.
 */
function statusFor(code) {
  switch (code) {
    case 'STALE_VERSION':
    case 'APPLY_IN_PROGRESS':
      return 409
    case 'UNKNOWN_DOC':
    case 'UNKNOWN_BATCH':
      return 404
    case 'CANVAS_FULL':
    case 'EDIT_TOO_LONG':
    case 'QUOTE_TOO_LONG':
      return 413
    default:
      return 400
  }
}

/**
 * Register the canvas on one Cordis context.
 * @param {object} ctx - the plugin context (tools, systemPrompt, webServer and agents injected).
 */
export function apply(ctx) {
  const store = new CanvasStore()
  const productsDirectory = () => {
    try {
      const directory = ctx.get('workingDirectory')?.defaultDirectory
      if (typeof directory === 'string' && directory.trim() !== '') return join(directory, 'products')
    } catch {
      // The service is absent in a bare harness; the profile directory is the fallback.
    }
    return join(homedir(), 'products')
  }
  const service = new CanvasService({ store, productsDirectory })

  // The debounced write is the only timer this half owns; it must not outlive the plugin.
  ctx.effect(
    () => () => {
      store.dispose()
    },
    'canvas: flush pending write',
  )

  /* ------------------------------------------------------------------ tools */

  /** Tools answer with one text block; the Harness rejects non-lossless values. */
  const asText = (text) => [{ type: 'text', text }]

  /** A tool definition that only returns text. */
  const textOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    render: (_args, value) => asText(value.text),
  }

  ctx.tools.register({
    name: 'canvas_write',
    description:
      "Write into the user's Canvas document — a shared text pane they read and comment on. " +
      'Accepts markdown-lite: `# `, `## `, `### ` headings; `- ` and `1. ` list items; `> ` quotes; ' +
      '``` fences for code; `**bold**` and `*italic*`. Every blank-line-separated paragraph becomes its ' +
      'own block with its own id. Appends to the end, or directly after the block named by `after` ' +
      '(a block id from canvas_read). Prefer several calls of 1–3 paragraphs over one huge text: the user ' +
      'watches it appear. Existing blocks and their comments are untouched.',
    parameters: {
      text: { type: 'string', required: true, description: 'Markdown-lite text; each paragraph becomes a block.' },
      after: {
        type: 'string',
        description: 'Block id (not an index) to insert after. Omit to append at the end of the document.',
      },
    },
    output: textOutput,
    execute(args) {
      const result = service.write(args?.text, args?.after)
      return {
        text: `записано блоков: ${result.added} (${result.blocks.join(', ')}); версия документа ${result.version}`,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Запись на холст', kind: 'other', rawInput: args }),
  })

  ctx.tools.register({
    name: 'canvas_replace',
    description:
      'Replace the whole Canvas document text with markdown-lite. Every existing comment becomes ' +
      '`orphaned` with the reason "документ перезаписан" — comments are kept, never deleted. ' +
      'Use it only when the user asks to rewrite the document; to act on comments use canvas_apply.',
    parameters: {
      text: { type: 'string', required: true, description: 'The complete new document, markdown-lite.' },
    },
    output: textOutput,
    execute(args) {
      const result = service.replace(args?.text)
      return { text: `документ заменён: блоков ${result.blocks}; версия документа ${result.version}` }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Переписать холст', kind: 'other', rawInput: args }),
  })

  ctx.tools.register({
    name: 'canvas_set_title',
    description: 'Set the Canvas document title (the heading the user sees above the text).',
    parameters: {
      title: { type: 'string', required: true, description: 'The new document title.' },
    },
    output: textOutput,
    execute(args) {
      const result = service.setTitle(args?.title)
      return { text: `заголовок: «${result.title}»; версия документа ${result.version}` }
    },
  })

  ctx.tools.register({
    name: 'canvas_clear',
    description:
      'Empty the Canvas document: every block and every comment is deleted and the fact is recorded in ' +
      'the document history. Requires `confirm: true`; without it the call is refused and nothing changes. ' +
      'Call it only when the user explicitly asks to clear the canvas.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'Must be true; the deletion is not undoable from the tool.' },
    },
    output: textOutput,
    execute(args) {
      const result = service.clear(args?.confirm === true)
      return { text: `холст очищен; версия документа ${result.version}` }
    },
  })

  ctx.tools.register({
    name: 'canvas_read',
    description:
      'Read a window of the Canvas document: block ids, types and plain text. Default 30 blocks, at most ' +
      '100 per call, so a 200 000-character document is never returned whole. `includeComments: true` adds ' +
      'the comment list with ids, quotes, notes and statuses.',
    parameters: {
      from: { type: 'number', description: 'First block index (0-based). Default 0.' },
      to: { type: 'number', description: 'Exclusive end index. Default from + 30, clamped to from + 100.' },
      includeComments: { type: 'boolean', description: 'Also return the comment list.' },
    },
    output: textOutput,
    execute(args) {
      const window = service.read({
        from: args?.from,
        to: args?.to,
        includeComments: args?.includeComments === true,
      })
      const lines =
        window.total === 0
          ? ['документ пуст; напишите в него через canvas_write']
          : [`блоки ${window.from}–${window.to - 1} из ${window.total}:`, ...window.items.map((item) => `${item.id} [${item.type}] ${item.text}`)]
      if (window.to < window.total) lines.push(`… ещё блоков: ${window.total - window.to}; вызовите canvas_read с from=${window.to}.`)
      if (window.comments !== undefined) {
        lines.push('комментарии:')
        if (window.comments.length === 0) lines.push('  (пусто)')
        for (const comment of window.comments) {
          lines.push(`  ${comment.id} [${comment.status}] «${comment.quote}» — ${comment.note || 'без заметки'}`)
        }
      }
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'canvas_comments',
    description:
      "List the Canvas document's comments: id, quoted fragment, the user's note and the lifecycle status " +
      '(open, approximate, orphaned, applied, conflict, rejected, failed). Use it to see what the user ' +
      'asked to change before calling canvas_apply.',
    parameters: {
      status: {
        type: 'string',
        description: 'Only comments in this status.',
        enum: ['open', 'approximate', 'orphaned', 'applied', 'conflict', 'rejected', 'failed'],
      },
    },
    output: textOutput,
    execute(args) {
      const list = service.comments({ status: args?.status })
      const lines = [`комментариев: ${list.total}, открытых: ${list.open}`]
      for (const comment of list.items) {
        lines.push(
          `${comment.id} [${comment.status}] «${comment.quote}» — ${comment.note || 'без заметки'}` +
            (comment.reason === null ? '' : ` (${comment.reason})`),
        )
      }
      if (list.items.length === 0) lines.push('(пусто)')
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'canvas_apply',
    description:
      'Start applying the open comments of the Canvas document. Returns one package per comment — the quoted ' +
      'fragment, its block, the neighbouring blocks and the per-comment replacement limit — and the ' +
      'instruction to call `canvas_apply_edits`. You never write into the document yourself: the person ' +
      'reviews the proposed "before → after" and confirms in the Canvas panel. Without open comments the ' +
      'call is refused (NOTHING_TO_APPLY); a second application while one is running is refused ' +
      '(APPLY_IN_PROGRESS).',
    parameters: {
      commentIds: {
        type: 'array',
        description: 'Only these comment ids. Omit to prepare every open comment.',
        items: { type: 'string' },
      },
    },
    output: textOutput,
    execute(args) {
      const started = service.apply({ commentIds: Array.isArray(args?.commentIds) ? args.commentIds : undefined })
      const lines = [
        `партия ${started.batchId}: комментариев ${started.count}.`,
        'Пакеты (заменяйте РОВНО диапазон [from, to) блока, а не весь блок):',
      ]
      for (const item of started.packages) {
        lines.push(
          `${item.commentId} · блок ${item.blockId} · [${item.from}, ${item.to}) · предел ${item.replacementLimit}`,
          `  цитата: «${item.quote}»`,
          `  заметка: ${item.note || 'без заметки'}`,
          `  блок: ${item.block}`,
          `  до: ${item.before}`,
          `  после: ${item.after}`,
        )
      }
      lines.push(`стиль: тон=${started.style?.tone ?? '—'}`)
      lines.push(started.instruction)
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'canvas_apply_edits',
    description:
      'Deliver one replacement per comment of the prepared batch. IMPORTANT: `replacement` replaces EXACTLY ' +
      'the commented range [from, to) inside the block — NOT the whole block and not the whole paragraph; ' +
      'keep the surrounding text out of it. Refusals: an unknown commentId rejects the whole set ' +
      '(UNKNOWN_COMMENT), a replacement longer than the package limit is refused (EDIT_TOO_LONG). Nothing is ' +
      'written to the document: the user confirms the batch in the Canvas panel.',
    parameters: {
      edits: {
        type: 'array',
        required: true,
        description: 'One entry per comment: { commentId, replacement }.',
        items: {
          type: 'object',
          properties: {
            commentId: { type: 'string' },
            replacement: { type: 'string' },
          },
          required: ['commentId', 'replacement'],
        },
      },
    },
    output: textOutput,
    execute(args) {
      const accepted = service.applyEdits(Array.isArray(args?.edits) ? args.edits : undefined)
      return {
        text:
          `правки получены для ${accepted.count} комментариев; пользователь подтвердит их в панели «Холст». ` +
          'Не записывайте в документ сами.',
      }
    },
  })

  /* -------------------------------------------------------------- prompt section */

  ctx.systemPrompt.section({
    name: 'canvas:guide',
    order: 250,
    text: [
      'У пользователя есть Холст — общий текстовый документ в правом доке, который он читает и комментирует (плагин `canvas`).',
      'Когда просят написать документ — пишите его через `canvas_write` порциями по 1–3 абзаца, а не одним огромным вызовом, и не переписывайте документ целиком без просьбы.',
      'Правки по комментариям вы только готовите: `canvas_apply` возвращает по пакету на комментарий, `canvas_apply_edits` доставляет по одной правке на комментарий, а подтверждает партию пользователь в панели «Холст».',
      '`replacement` заменяет РОВНО прокомментированный фрагмент `[from, to)` — текст вокруг него в правку не включайте.',
      'Не вызывайте `canvas_clear` без явной просьбы пользователя очистить документ.',
    ].join(' '),
  })

  /* -------------------------------------------------------------- wake the agent */

  /**
   * Put the apply request into a session's inbox and wake it, without writing a user message.
   *
   * Verified against this build's agent loop: `inject` appends to the next step's input and does not
   * wake the driver, `followup` queues a turn and wakes it. The context message (hidden from the
   * transcript as an ordinary context row) carries the comment list; the follow-up message is short
   * and carries only the instruction, so the model reads it once.
   * @param {string} sessionId - the conversation the panel belongs to.
   * @param {{batchId: string, count: number, packages: object[]}} started - the prepared batch.
   */
  async function wakeAgent(sessionId, started) {
    const registry = ctx.get('agents')
    let agent = typeof registry?.get === 'function' ? registry.get(sessionId) : undefined
    if (agent === undefined || typeof agent.followup !== 'function') {
      // A conversation can be open in the GUI while its agent is not live (a fresh Host start, a
      // session that has not run a turn yet). Resume it instead of refusing: the panel is already
      // looking at that conversation, so "open it and retry" would be a dead end.
      if (registry !== undefined && typeof registry.resume === 'function') {
        try {
          const handle = await registry.resume({ sessionId })
          const resumed = handle?.agent ?? handle
          if (resumed !== undefined && typeof resumed.followup === 'function') agent = resumed
        } catch {
          // A failed resume falls through to the contract error below.
        }
      }
    }
    if (agent === undefined || typeof agent.followup !== 'function') {
      fail('NO_SESSION', 'беседа не активна; откройте её и повторите')
    }
    const context = [
      `Холст: пользователь попросил применить открытых комментариев — ${started.count}, документ «${service.document.title}».`,
      `Партия ${started.batchId}. Вызовите \`canvas_apply\` — он вернёт по пакету на комментарий.`,
      'Комментарии:',
      ...started.packages.map((item) => `- ${item.commentId} [${item.blockId} ${item.from}..${item.to}] «${item.quote}» — ${item.note || 'без заметки'}`),
    ].join('\n')
    const wake = 'Холст: пользователь нажал «Применить все». Вызовите `canvas_apply`, затем `canvas_apply_edits` — по одной правке на комментарий. Не правьте документ сами.'
    // The session log format v4 refuses the retired `kind: "plugin"` wrapper: a message must carry
    // the producer's own kind. `canvas` is this plugin's kind, so the row is an ordinary context
    // injection (hidden from the transcript) rather than a fake user message.
    const message = (text) => ({
      id: globalThis.crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'canvas' },
    })
    if (typeof agent.inject === 'function') agent.inject(message(context))
    agent.followup(message(wake))
  }

  /* ------------------------------------------------------------------ routes */

  const installRoutes = (webCtx) => {
    const server = webCtx.webServer
    webCtx.effect(
      () => {
        /** Wrap one handler with the same-origin check and the contract error mapping. */
        const route = (path, handler) =>
          server.register({
            kind: 'exact',
            path,
            handler: async (request, response) => {
              if (!sameOrigin(request)) {
                respondError(response, 403, 'FORBIDDEN', 'холст отдаётся только этому окну; страница другого сайта читать его не может')
                return
              }
              try {
                const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readJsonBody(request)
                await handler(request, response, body)
              } catch (error) {
                const mapped = errorBody(error)
                respondError(response, statusFor(mapped.code), mapped.code, mapped.hint)
              }
            },
          })

        const disposeDoc = route('/canvas/doc', async (request, response, body) => {
          if (request.method === 'GET') {
            respondJson(response, 200, service.snapshot())
            return
          }
          if (request.method !== 'PUT') {
            response.writeHead(405, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const payload = body !== null && typeof body === 'object' ? body : {}
          const ifMatch = request.headers?.['if-match']
          const result = service.editBlock({ blockId: payload.blockId, spans: payload.spans }, ifMatch)
          respondJson(response, 200, result)
        })

        const disposeNew = route('/canvas/doc/new', async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const created = service.newDocument()
          respondJson(response, 200, { version: created.document.version, document: created.document })
        })

        const disposeComment = route('/canvas/comment', async (request, response, body) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const payload = body !== null && typeof body === 'object' ? body : {}
          const action = String(payload.action ?? 'add')
          if (action === 'add') {
            const comment = service.addComment({
              blockId: payload.blockId,
              from: payload.from,
              to: payload.to,
              note: payload.note,
            })
            respondJson(response, 200, { comment, version: service.version })
            return
          }
          if (action === 'update') {
            const comment = service.updateComment(payload.commentId, payload.note)
            respondJson(response, 200, { comment, version: service.version })
            return
          }
          if (action === 'delete') {
            respondJson(response, 200, { ...service.deleteComment(payload.commentId), version: service.version })
            return
          }
          if (action === 'resolve') {
            const comment = service.resolveComment(payload.commentId)
            respondJson(response, 200, { comment, version: service.version })
            return
          }
          if (action === 'reanchor') {
            const comment = service.reanchorComment({
              commentId: payload.commentId,
              blockId: payload.blockId,
              from: payload.from,
              to: payload.to,
            })
            respondJson(response, 200, { comment, version: service.version })
            return
          }
          respondError(response, 400, 'INVALID_TEXT', `неизвестное действие «${action}»; допустимы add, update, delete, resolve, reanchor`)
        })

        const disposePrepare = route('/canvas/apply/prepare', async (request, response, body) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const payload = body !== null && typeof body === 'object' ? body : {}
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
          if (sessionId === '') {
            respondError(response, 400, 'NO_SESSION', 'передайте { "sessionId": "<id беседы>" }, чтобы разбудить агента')
            return
          }
          const started = service.beginApply({ sessionId, mode: 'ui' })
          try {
            await wakeAgent(sessionId, started)
          } catch (error) {
            // A batch nobody was told about would hold the lock for ten minutes; release it now.
            service.batch = null
            throw error
          }
          respondJson(response, 200, { batchId: started.batchId, count: started.count })
        })

        const disposePending = route('/canvas/apply/pending', async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const pending = service.pending()
          if (pending === null) {
            response.writeHead(204, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          respondJson(response, 200, pending)
        })

        const disposeCommit = route('/canvas/apply/commit', async (request, response, body) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const payload = body !== null && typeof body === 'object' ? body : {}
          const result = service.commit({ batchId: payload.batchId, accept: Array.isArray(payload.accept) ? payload.accept : [] })
          respondJson(response, 200, result)
        })

        const disposeDiscard = route('/canvas/apply/discard', async (request, response, body) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const payload = body !== null && typeof body === 'object' ? body : {}
          respondJson(response, 200, service.discard({ batchId: payload.batchId }))
        })

        const disposeExport = route('/canvas/export', async (request, response, body) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const payload = body !== null && typeof body === 'object' ? body : {}
          const format = String(payload.format ?? 'html').toLowerCase()
          if (format !== 'html') {
            respondError(
              response,
              400,
              'INVALID_TEXT',
              'экспортируется только «html»; PDF вне области — откройте HTML и выберите «Печать → Сохранить как PDF»',
            )
            return
          }
          const exported = service.exportPage({ includeComments: payload.includeComments === true })
          respondJson(response, 200, exported)
        })

        return () => {
          disposeDoc()
          disposeNew()
          disposeComment()
          disposePrepare()
          disposePending()
          disposeCommit()
          disposeDiscard()
          disposeExport()
        }
      },
      'canvas: routes',
    )
  }

  const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (server !== undefined && typeof server.register === 'function') {
    installRoutes({ webServer: server, effect: (callback) => ctx.effect(callback) })
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], installRoutes)
  }
}
