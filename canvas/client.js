/**
 * Canvas — browser half.
 *
 * One right-dock tab, one header button, one page fallback. The tab is a controlled view of the
 * Host's document: it polls `GET /canvas/doc`, renders blocks as `contenteditable` elements (one per
 * block, never one editor for the whole document), and writes a block back with `If-Match` when the
 * person pauses or leaves it.
 *
 * What lives here and why:
 *
 * - **spans → HTML → spans.** A block renders from `{t,b?,i?}` spans; the editor serializes its DOM
 *   back to the same shape. Comments are drawn as `<mark data-comment>` wrappers that serialization
 *   ignores, so decoration never enters the text.
 * - **typewriter.** New agent text appears at `min(20 ms, 2500 / N)` per character and instantly
 *   above 1200 characters, so every update finishes within 2.5 s. The rate is a pure function
 *   (`typingPlan`), which is also what the tests pin.
 * - **polling.** 500 ms while the last write is younger than 10 s, 3 s otherwise; a hidden tab
 *   stops polling and a newer local version ignores older responses, so "edit vs poll" cannot
 *   overwrite an edit.
 * - **apply handshake.** The panel asks the Host to prepare, waits for the model's edits, shows the
 *   "before → after" overview and commits only what the person ticked.
 *
 * The component never writes to `document.body`; nothing here needs a portal.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-canvas',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Copy namespace this bundle owns. */
    const NS = 'canvasUI'

    /** Right-dock tab type this bundle contributes. */
    const TAB_ID = '@local/dsh-canvas/panel'
    const TAB_KIND = 'canvasPanel'

    /** How long a write keeps the fast poll alive. */
    const FAST_WINDOW_MS = 10_000
    /** Poll cadence while the agent is writing and while it is idle. */
    const POLL_FAST_MS = 500
    const POLL_SLOW_MS = 3_000
    /** Pause before a manually edited block is written back. */
    const SAVE_PAUSE_MS = 400
    /** How long the panel waits for the model to answer a prepared batch. */
    const PREPARE_TIMEOUT_MS = 30_000
    /** Pending-batch poll cadence while an application is running. */
    const PENDING_POLL_MS = 1_500
    /** Characters above which new text is painted at once. */
    const TYPEWRITER_MAX_CHARS = 1200
    /** Ceiling for the whole animation, in milliseconds. */
    const TYPEWRITER_BUDGET_MS = 2_500
    /** Rows of the comment rail rendered in one window. */
    const RAIL_WINDOW = 40
    /** Height of one rail row, used by the windowing spacer. */
    const RAIL_ROW_HEIGHT = 96

    /* ------------------------------------------------------------- dictionaries */

    /** Russian wording — what this owner reads. */
    const RUSSIAN = {
      'tab.title': 'Холст',
      'tab.titleCount': 'Холст · {count} открытых',
      'open': 'Холст',
      'openHint': 'Открыть холст',
      'badge.pending': 'Готовы правки ({count}) — откройте Холст',
      'doc.empty': 'Документ пуст',
      'doc.emptyHint': 'Попросите ассистента написать текст — он появится здесь построчно.',
      'doc.version': 'версия {version}',
      'doc.new': 'Новый документ',
      'doc.newHint': 'Текущий документ уйдёт в архив, файл останется на диске.',
      'doc.untitled': 'Документ',
      'export.html': 'Экспорт HTML',
      'export.comments': 'включить комментарии',
      'export.pdf': 'PDF',
      'export.done': 'Файл сохранён: {path}',
      'export.pdfHint': 'Откройте HTML и выберите «Печать → Сохранить как PDF»: кириллица требует встроенного шрифта.',
      'rail.title': 'Комментарии',
      'rail.openCount': '{count} открытых',
      'rail.empty': 'Комментариев пока нет',
      'rail.emptyHint': 'Выделите фрагмент и нажмите «Прокомментировать».',
      'rail.limit': 'На документе уже 500 комментариев — закройте часть, прежде чем добавлять новые.',
      'rail.delete': 'Удалить',
      'rail.resolve': 'Решён вручную',
      'rail.edit': 'Изменить',
      'rail.save': 'Сохранить',
      'rail.cancel': 'Отмена',
      'rail.reanchor': 'Перепривязать',
      'rail.reanchorHint': 'Выделите фрагмент в абзаце и нажмите «Привязать сюда».',
      'rail.reanchorGo': 'Привязать сюда',
      'rail.approximate': 'найдено приблизительно',
      'rail.orphaned': 'фрагмент потерян',
      'rail.applied': 'применён',
      'rail.conflict': 'конфликт',
      'rail.rejected': 'отклонён',
      'rail.failed': 'не применён',
      'rail.status.open': 'открыт',
      'sel.comment': 'Прокомментировать',
      'sel.chat': 'В чат',
      'sel.hint': 'Выделено: «{quote}»',
      'sel.oneBlock': 'В этой версии — по одному абзацу: выделение из двух абзацев не поддерживается.',
      'note.placeholder': 'Заметка: что изменить',
      'note.add': 'Добавить комментарий',
      'note.cancel': 'Отмена',
      'apply.all': 'Применить все',
      'apply.busy': 'Применение уже идёт',
      'apply.nothing': 'Нет открытых комментариев',
      'apply.noSession': 'Откройте беседу, затем нажмите «Применить все».',
      'apply.waiting': 'Ассистент готовит правки…',
      'apply.timeout': 'Ассистент не ответил за 30 секунд.',
      'apply.retry': 'Повторить',
      'apply.overview': 'Обзор правок',
      'apply.accept': 'Принять',
      'apply.commit': 'Применить выбранные',
      'apply.discard': 'Отменить применение',
      'apply.progress': 'применено {done} из {total}',
      'apply.applied': 'Применено {applied} из {total}',
      'apply.conflicts': 'Не применилось: {count}',
      'apply.undo': 'Вернуть как было',
      'apply.undone': 'Применение отменено, документ восстановлен.',
      'apply.count': 'Готовы правки: {count}',
      'notice.stale': 'Документ изменён — обновите, чтобы не потерять правки',
      'notice.staleAction': 'Обновить',
      'notice.newer': 'Документ создан более новой версией DSH и открыт только для чтения.',
      'notice.clipboard': 'Текст скопирован в буфер обмена — вставьте его в композер.',
      'notice.copyManual': 'Буфер обмена недоступен: скопируйте текст из поля ниже.',
      'notice.inserted': 'Цитата вставлена в композер.',
      'notice.error': 'Не удалось выполнить действие: {message}',
      'notice.loading': 'Загрузка документа…',
      'notice.retry': 'Повторить',
      'state.open': 'открыт',
      'state.approximate': 'приблизительно',
      'state.orphaned': 'потерян',
      'state.applied': 'применён',
      'state.conflict': 'конфликт',
      'state.rejected': 'отклонён',
      'state.failed': 'не применён',
    }

    /* ------------------------------------------------------------------- styles */

    /** Tokens only: no colour literal appears outside the theme's own variables. */
    const CSS = [
      '.dshCanvas_root{display:flex;flex-direction:column;height:100%;min-height:0;',
      'color:var(--dsw-alias-label-primary);font:inherit}',
      '.dshCanvas_head{display:flex;align-items:center;gap:8px;padding:10px 14px;',
      'border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;flex-wrap:wrap}',
      '.dshCanvas_title{font-size:calc(var(--dsh-content-font-size,14px) + 1px);font-weight:600;',
      'margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshCanvas_meta{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}',
      '.dshCanvas_spacer{margin-left:auto}',
      '.dshCanvas_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l1);',
      'color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:3px 9px;',
      'font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dshCanvas_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshCanvas_btn:disabled{opacity:.55;cursor:default}',
      '.dshCanvas_btnPrimary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);',
      'font-weight:500}',
      '.dshCanvas_btnDanger{color:var(--dsw-alias-state-error-primary)}',
      '.dshCanvas_check{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dshCanvas_notice{margin:8px 14px 0;padding:8px 10px;border-radius:var(--dsw-radius-sm);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;',
      'display:flex;align-items:center;gap:10px;flex:none}',
      '.dshCanvas_noticeError{color:var(--dsw-alias-state-error-primary)}',
      '.dshCanvas_noticeWarn{color:var(--dsw-alias-state-warn-primary)}',
      '.dshCanvas_body{display:flex;flex:1;min-height:0}',
      '.dshCanvas_doc{flex:1;min-width:0;overflow:auto;padding:18px 22px 40px;cursor:text}',
      '.dshCanvas_rail{width:320px;flex:none;border-left:1px solid var(--dsw-alias-border-l2);',
      'display:flex;flex-direction:column;min-height:0}',
      '.dshCanvas_railHead{display:flex;align-items:center;gap:8px;padding:8px 12px;',
      'border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshCanvas_railList{overflow:auto;flex:1;padding:8px;min-height:0}',
      '.dshCanvas_empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:24px 4px;text-align:center}',
      '.dshCanvas_block{margin:0 0 12px;line-height:1.6;font-size:14px;outline:none;white-space:pre-wrap;',
      'overflow-wrap:anywhere;border-radius:var(--dsw-radius-xs);padding:1px 2px}',
      '.dshCanvas_block:focus{box-shadow:0 0 0 1px var(--dsw-alias-border-l3)}',
      '.dshCanvas_h1{font-size:24px;font-weight:700;line-height:1.3;margin:4px 0 14px}',
      '.dshCanvas_h2{font-size:19px;font-weight:650;line-height:1.35;margin:4px 0 10px}',
      '.dshCanvas_h3{font-size:16px;font-weight:600;line-height:1.4;margin:4px 0 8px}',
      '.dshCanvas_li{display:flex;gap:8px}',
      '.dshCanvas_li::before{content:attr(data-marker);color:var(--dsw-alias-label-tertiary);flex:none;user-select:none}',
      '.dshCanvas_quote{border-left:3px solid var(--dsw-alias-border-l2);padding-left:12px;',
      'color:var(--dsw-alias-label-secondary);margin-left:0}',
      '.dshCanvas_code{font-family:"Cascadia Mono",Consolas,monospace;font-size:12.5px;',
      'background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-sm);padding:10px 12px;',
      'white-space:pre-wrap}',
      '.dshCanvas_mark{background:var(--dsw-alias-state-warn-primary);opacity:.22;border-radius:2px;',
      'cursor:pointer}',
      '.dshCanvas_markPale{opacity:.12;outline:1px dashed var(--dsw-alias-state-warn-primary)}',
      '.dshCanvas_markActive{opacity:.38}',
      '.dshCanvas_sel{display:flex;align-items:center;gap:8px;margin:8px 14px 0;padding:8px 10px;',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);font-size:12px;flex:none}',
      '.dshCanvas_selQuote{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshCanvas_note{display:flex;flex-direction:column;gap:6px;margin:8px 14px 0;flex:none}',
      '.dshCanvas_noteInput{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:12px;padding:6px 8px;resize:vertical;min-height:52px}',
      '.dshCanvas_row{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);',
      'padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-l1);font-size:12px;',
      'display:flex;flex-direction:column;gap:6px}',
      '.dshCanvas_rowActive{border-color:var(--dsw-alias-brand-primary)}',
      '.dshCanvas_quoteText{color:var(--dsw-alias-label-secondary);font-style:italic;',
      'overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dshCanvas_noteText{color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dshCanvas_rowFoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshCanvas_status{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dshCanvas_statusConflict{color:var(--dsw-alias-state-error-primary)}',
      '.dshCanvas_statusApplied{color:var(--dsw-alias-state-success-primary)}',
      '.dshCanvas_link{border:none;background:none;color:var(--dsw-alias-brand-primary);font:inherit;',
      'font-size:11px;cursor:pointer;padding:0}',
      '.dshCanvas_apply{padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;',
      'display:flex;flex-direction:column;gap:6px}',
      '.dshCanvas_diff{display:grid;grid-template-columns:1fr;gap:3px;margin-top:4px}',
      '.dshCanvas_before{color:var(--dsw-alias-state-error-primary);text-decoration:line-through;opacity:.85}',
      '.dshCanvas_after{color:var(--dsw-alias-state-success-primary)}',
      '.dshCanvas_applyItem{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);',
      'padding:6px 8px;margin-bottom:6px;font-size:12px}',
      '.dshCanvas_headBtn{border:none;background:none;color:var(--dsw-alias-label-secondary);font:inherit;',
      'font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:2px 6px;',
      'border-radius:var(--dsw-radius-xs)}',
      '.dshCanvas_headBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshCanvas_badge{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);',
      'border-radius:9px;font-size:10px;line-height:14px;min-width:14px;text-align:center;padding:0 3px}',
      '.dshCanvas_page{max-width:900px;margin:0 auto;padding:24px;height:100%;box-sizing:border-box}',
    ].join('')

    /* --------------------------------------------------------------- pure helpers */

    /**
     * Escape text for HTML text nodes and attributes.
     * @param {string} value - raw text.
     * @returns {string} escaped text.
     */
    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    /**
     * The typewriter rate for a newly appended run of text.
     * Per character the delay is `min(20 ms, 2500 / N)`; above 1200 characters nothing is animated,
     * so the total is never longer than 2.5 s and there is no lower bound on the delay.
     * @param {number} length - how many characters were appended.
     * @returns {{instant: boolean, perCharMs: number, durationMs: number}} the plan.
     */
    function typingPlan(length) {
      const count = Math.max(0, Math.floor(Number(length) || 0))
      if (count === 0) return { instant: true, perCharMs: 0, durationMs: 0 }
      if (count > TYPEWRITER_MAX_CHARS) return { instant: true, perCharMs: 0, durationMs: 0 }
      const perCharMs = Math.min(20, TYPEWRITER_BUDGET_MS / count)
      return { instant: false, perCharMs, durationMs: perCharMs * count }
    }

    /**
     * The poll cadence: fast while the last write is younger than ten seconds.
     * @param {number} lastWriteAt - epoch milliseconds of the last write, 0 when there was none.
     * @param {number} now - the current instant.
     * @returns {number} the delay in milliseconds.
     */
    function pollDelay(lastWriteAt, now) {
      return now - lastWriteAt < FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS
    }

    /**
     * Whether a polled document is newer than what the tab already shows.
     * A response whose version is not greater is ignored, which closes the edit-vs-poll race.
     * @param {number} localVersion - the version on screen.
     * @param {{version?: number}} incoming - the payload.
     * @returns {boolean} true when it should be adopted.
     */
    function isNewer(localVersion, incoming) {
      return Number.isFinite(incoming?.version) && incoming.version > localVersion
    }

    /**
     * Split a span list at a character offset, for the typewriter's partial text.
     * @param {{t: string, b?: boolean, i?: boolean}[]} spans - the block's spans.
     * @param {number} length - how many characters to keep.
     * @returns {{t: string, b?: boolean, i?: boolean}[]} the prefix.
     */
    function sliceSpans(spans, length) {
      const result = []
      let left = Math.max(0, length)
      for (const span of spans ?? []) {
        if (left <= 0) break
        const take = Math.min(left, span.t.length)
        if (take > 0) result.push({ ...span, t: span.t.slice(0, take) })
        left -= take
      }
      return result
    }

    /** Flat text of a span list. */
    const flat = (spans) => (spans ?? []).map((span) => span.t).join('')

    /**
     * Render a block's spans as editor HTML, wrapping commented ranges in `<mark>` elements.
     * Serialization ignores `<mark>`, so the decoration never becomes text.
     * @param {{t: string, b?: boolean, i?: boolean}[]} spans - the block's spans.
     * @param {{id: string, from: number, to: number, status: string}[]} marks - comment ranges.
     * @param {string|null} activeId - the comment highlighted right now.
     * @returns {string} the escaped HTML.
     */
    function spansToHtml(spans, marks, activeId) {
      let offset = 0
      let html = ''
      const push = (text, bold, italic, mark) => {
        if (text === '') return
        let inner = escapeHtml(text)
        if (bold) inner = `<strong>${inner}</strong>`
        if (italic) inner = `<em>${inner}</em>`
        if (mark !== undefined) {
          const active = mark.id === activeId ? ' dshCanvas_markActive' : ''
          const pale = mark.status === 'approximate' ? ' dshCanvas_markPale' : ''
          inner = `<mark class="dshCanvas_mark${pale}${active}" data-comment="${escapeHtml(mark.id)}">${inner}</mark>`
        }
        html += inner
      }
      for (const span of spans ?? []) {
        const start = offset
        offset += span.t.length
        let cursor = start
        while (cursor < offset) {
          const mark = (marks ?? []).find((entry) => cursor >= entry.from && cursor < entry.to)
          const stop = mark === undefined ? offset : Math.min(offset, mark.to)
          push(span.t.slice(cursor - start, stop - start), span.b === true, span.i === true, mark)
          cursor = stop
        }
      }
      return html
    }

    /**
     * Serialize one editor element back to spans: `<b>/<strong>` are bold, `<i>/<em>` are italic,
     * `<br>` and block-level breaks are newlines, `<mark>` is transparent.
     * @param {object} root - the contenteditable element.
     * @returns {{t: string, b?: boolean, i?: boolean}[]} the spans.
     */
    function serializeSpans(root) {
      const result = []
      const pushText = (text, bold, italic) => {
        if (text === '') return
        const last = result[result.length - 1]
        if (last !== undefined && last.b === bold && last.i === italic) last.t += text
        else {
          const span = { t: text }
          if (bold) span.b = true
          if (italic) span.i = true
          result.push(span)
        }
      }
      const walk = (node, bold, italic) => {
        if (node.nodeType === 3) {
          pushText(node.nodeValue ?? '', bold, italic)
          return
        }
        if (node.nodeType !== 1) return
        const tag = String(node.tagName ?? '').toUpperCase()
        if (tag === 'BR') {
          pushText('\n', bold, italic)
          return
        }
        const nextBold = bold || tag === 'B' || tag === 'STRONG'
        const nextItalic = italic || tag === 'I' || tag === 'EM'
        if ((tag === 'DIV' || tag === 'P') && result.length > 0) pushText('\n', bold, italic)
        for (const child of node.childNodes ?? []) walk(child, nextBold, nextItalic)
      }
      for (const child of root?.childNodes ?? []) walk(child, false, false)
      return result.filter((span) => span.t !== '')
    }

    /**
     * Flat offset of a DOM position inside one block element.
     * @param {object} root - the block element.
     * @param {object} node - the selection's container.
     * @param {number} offset - the offset inside that container.
     * @returns {number} the offset in the block's flat text.
     */
    function offsetOf(root, node, offset) {
      let total = 0
      let result = null
      const visit = (current) => {
        if (result !== null) return
        if (current === node) {
          if (current.nodeType === 3) {
            result = total + offset
            return
          }
          if (current.nodeType === 1) {
            // An element container: count the text before the child at `offset`.
            const children = current.childNodes ?? []
            if (offset >= children.length) {
              result = total + flatLength(current)
              return
            }
            for (let index = 0; index < offset; index += 1) total += flatLength(children[index])
            result = total
            return
          }
        }
        if (current.nodeType === 3) {
          total += (current.nodeValue ?? '').length
          return
        }
        if (current.nodeType === 1 && String(current.tagName).toUpperCase() === 'BR') {
          total += 1
          return
        }
        for (const child of current.childNodes ?? []) visit(child)
      }
      visit(root)
      return result === null ? total : result
    }

    /** Length of a subtree in flat text, with `<br>` counting as one character. */
    function flatLength(node) {
      if (node === null || node === undefined) return 0
      if (node.nodeType === 3) return (node.nodeValue ?? '').length
      if (node.nodeType === 1 && String(node.tagName).toUpperCase() === 'BR') return 1
      let total = 0
      for (const child of node.childNodes ?? []) total += flatLength(child)
      return total
    }

    /**
     * Put text on the clipboard through the async API only.
     * There is deliberately no hidden-textarea path: that would write a node into `document.body`,
     * outside this component. When the clipboard is unavailable the panel shows the text in a
     * selectable box instead (see the copy fallback in the panel).
     * @param {string} text - the text to copy.
     * @returns {Promise<boolean>} whether it is on the clipboard.
     */
    async function copyText(text) {
      try {
        if (globalThis.navigator?.clipboard?.writeText === undefined) return false
        await globalThis.navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /**
     * Call one JSON route.
     * @param {string} path - the route path.
     * @param {{method?: string, body?: object, headers?: object}} [options] - request shape.
     * @returns {Promise<any>} the parsed body.
     */
    async function call(path, options = {}) {
      const response = await globalThis.fetch(path, {
        method: options.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      if (response.status === 204) return null
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const error = new Error(payload?.hint ?? `HTTP ${response.status}`)
        error.code = payload?.code ?? 'HTTP'
        error.status = response.status
        throw error
      }
      return payload
    }

    /** A tiny external store, so the tab title can show the open-comment count. */
    function createCountStore() {
      let value = 0
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (next === value) return
          value = next
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const openCount = createCountStore()
    const pendingCount = createCountStore()

    /* ------------------------------------------------------------------ components */

    /**
     * One editable block.
     *
     * Uncontrolled on purpose: React writes `dangerouslySetInnerHTML` only when the string changes,
     * and while the block is focused the last committed string is kept, so a poll cannot reset the
     * caret or the text a person is typing.
     * @param {object} props - block, marks, callbacks.
     * @returns {object} the rendered element.
     */
    function Block(props) {
      const { block, html, editable, activeComment, onInput, onBlur, onPaste, onKeyDown, onFocus, onMarkClick } = props
      const ref = React.useRef(null)
      const tag = block.type === 'li' ? 'div' : block.type === 'code' ? 'pre' : block.type === 'quote' ? 'blockquote' : block.type
      const className = `dshCanvas_block dshCanvas_${block.type}`
      const content = html
      return h(
        tag,
        {
          ref,
          'data-block-id': block.id,
          ...(block.type === 'li' ? { 'data-marker': block.ordered === true ? '1.' : '•' } : {}),
          className,
          contentEditable: editable,
          suppressContentEditableWarning: true,
          spellCheck: false,
          ...(editable ? {} : { 'aria-readonly': 'true' }),
          onInput,
          onBlur,
          onPaste,
          onKeyDown,
          onFocus,
          onClick: onMarkClick,
          'data-active-comment': activeComment ?? undefined,
          dangerouslySetInnerHTML: { __html: content },
        },
      )
    }

    /** One status chip, coloured by the lifecycle state. */
    function StatusChip(props) {
      const { status, t } = props
      const tone =
        status === 'conflict' || status === 'failed'
          ? ' dshCanvas_statusConflict'
          : status === 'applied'
            ? ' dshCanvas_statusApplied'
            : ''
      return h('span', { className: `dshCanvas_status${tone}` }, t(`state.${status}`))
    }

    /**
     * One comment row.
     * @param {object} props - the comment and its actions.
     * @returns {object} the row.
     */
    function CommentRow(props) {
      const { comment, t, active, index, editing, draft, onSelect, onEdit, onDraft, onSave, onCancel, onDelete, onResolve, onReanchor, reattaching } = props
      return h(
        'div',
        {
          className: `dshCanvas_row${active ? ' dshCanvas_rowActive' : ''}`,
          'data-comment-row': comment.id,
          onClick: onSelect,
        },
        h('div', { className: 'dshCanvas_quoteText' }, `«${comment.quote}»`),
        editing
          ? h('textarea', {
              className: 'dshCanvas_noteInput',
              value: draft,
              onChange: (event) => onDraft(event.target.value),
              placeholder: t('note.placeholder'),
            })
          : h('div', { className: 'dshCanvas_noteText' }, comment.note === '' ? '—' : comment.note),
        h(
          'div',
          { className: 'dshCanvas_rowFoot' },
          h(StatusChip, { status: comment.status, t }),
          comment.reason === null ? null : h('span', { className: 'dshCanvas_status' }, `· ${comment.reason}`),
          h('span', { className: 'dshCanvas_spacer' }),
          editing
            ? [
                h('button', { key: 'save', className: 'dshCanvas_link', onClick: onSave }, t('rail.save')),
                h('button', { key: 'cancel', className: 'dshCanvas_link', onClick: onCancel }, t('rail.cancel')),
              ]
            : [
                h('button', { key: 'edit', className: 'dshCanvas_link', onClick: onEdit }, t('rail.edit')),
                comment.status === 'orphaned'
                  ? h('button', { key: 're', className: 'dshCanvas_link', onClick: onReanchor }, reattaching ? t('rail.reanchorGo') : t('rail.reanchor'))
                  : null,
                h('button', { key: 'resolve', className: 'dshCanvas_link', onClick: onResolve }, t('rail.resolve')),
                h('button', { key: 'del', className: 'dshCanvas_link dshCanvas_btnDanger', onClick: onDelete }, t('rail.delete')),
              ],
          h('span', { className: 'dshCanvas_status' }, `#${index + 1}`),
        ),
      )
    }

    /**
     * The rail with its virtualized list: only {@link RAIL_WINDOW} rows are rendered, with spacers
     * above and below, so 500 comments do not become 500 DOM rows.
     */
    function CommentRail(props) {
      const { comments, t, selectedId, editingId, draft, onSelect, onEdit, onDraft, onSave, onCancel, onDelete, onResolve, onReanchor, reattachId } = props
      const [scrollTop, setScrollTop] = React.useState(0)
      const total = comments.length
      const start = Math.max(0, Math.min(Math.floor(scrollTop / RAIL_ROW_HEIGHT), Math.max(0, total - RAIL_WINDOW)))
      const end = Math.min(total, start + RAIL_WINDOW)
      const rows = comments.slice(start, end).map((comment, offset) =>
        h(CommentRow, {
          key: comment.id,
          comment,
          t,
          index: start + offset,
          active: comment.id === selectedId,
          editing: comment.id === editingId,
          draft,
          reattaching: comment.id === reattachId,
          onSelect: () => onSelect(comment.id),
          onEdit: () => onEdit(comment.id),
          onDraft,
          onSave: () => onSave(comment.id),
          onCancel,
          onDelete: () => onDelete(comment.id),
          onResolve: () => onResolve(comment.id),
          onReanchor: () => onReanchor(comment.id),
        }),
      )
      if (total === 0) {
        return h(
          'div',
          { className: 'dshCanvas_railList' },
          h('div', { className: 'dshCanvas_empty' }, h('div', null, t('rail.empty')), h('div', null, t('rail.emptyHint'))),
        )
      }
      return h(
        'div',
        {
          className: 'dshCanvas_railList',
          onScroll: (event) => setScrollTop(event.currentTarget.scrollTop),
        },
        h('div', { style: { height: `${start * RAIL_ROW_HEIGHT}px` } }),
        rows,
        h('div', { style: { height: `${(total - end) * RAIL_ROW_HEIGHT}px` } }),
      )
    }

    /**
     * The apply block of the rail: the button, the waiting state, and the "before → after" overview.
     */
    function ApplySection(props) {
      const { t, openComments, pending, applying, overview, accepted, batch, lastResult, onApply, onRetry, onToggle, onCommit, onDiscard, onUndo, timeout } = props
      if (pending !== null) {
        const items = pending.items ?? []
        return h(
          'div',
          { className: 'dshCanvas_apply' },
          h('div', { className: 'dshCanvas_meta' }, `${t('apply.overview')} · ${items.length}`),
          ...items.map((item) =>
            h(
              'label',
              { key: item.commentId, className: 'dshCanvas_applyItem', style: { display: 'block' } },
              h(
                'div',
                { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
                h('input', {
                  type: 'checkbox',
                  checked: accepted.has(item.commentId),
                  onChange: () => onToggle(item.commentId),
                }),
                h(
                  'div',
                  { style: { minWidth: '0' } },
                  h('div', { className: 'dshCanvas_before' }, item.before),
                  h('div', { className: 'dshCanvas_after' }, item.after),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dshCanvas_rowFoot' },
            h('button', { className: 'dshCanvas_btn dshCanvas_btnPrimary', onClick: onCommit, disabled: accepted.size === 0 }, t('apply.commit')),
            h('button', { className: 'dshCanvas_btn', onClick: onDiscard }, t('apply.discard')),
          ),
        )
      }
      if (applying) {
        return h(
          'div',
          { className: 'dshCanvas_apply' },
          h('div', { className: 'dshCanvas_meta' }, timeout ? t('apply.timeout') : t('apply.waiting')),
          timeout
            ? h('button', { className: 'dshCanvas_btn', onClick: onRetry }, t('apply.retry'))
            : h('button', { className: 'dshCanvas_btn', onClick: onDiscard }, t('apply.discard')),
        )
      }
      return h(
        'div',
        { className: 'dshCanvas_apply' },
        h(
          'div',
          { className: 'dshCanvas_rowFoot' },
          h(
            'button',
            { className: 'dshCanvas_btn dshCanvas_btnPrimary', onClick: onApply, disabled: openComments === 0 },
            t('apply.all'),
          ),
          openComments === 0 ? h('span', { className: 'dshCanvas_meta' }, t('apply.nothing')) : null,
        ),
        lastResult === null
          ? null
          : h(
              'div',
              { className: 'dshCanvas_meta' },
              `${t('apply.applied', { applied: lastResult.applied, total: lastResult.total })}` +
                (lastResult.conflicts > 0 ? ` · ${t('apply.conflicts', { count: lastResult.conflicts })}` : ''),
              ' ',
              h('button', { className: 'dshCanvas_link', onClick: onUndo }, t('apply.undo')),
            ),
      )
    }

    /**
     * Translate a dictionary key, with `{name}` interpolation.
     *
     * The wording is Russian regardless of the interface language: the plugin is Russian-only, so a
     * build that answers `en` (or answers the key itself) still shows Russian copy.
     * @param t - the framework-bound translator.
     * @returns a `t(key, values)` function.
     */
    function translator(t) {
      return (key, values) => {
        const fallback = typeof t === 'function' ? t(key, values) : key
        const template = RUSSIAN[key] ?? (typeof fallback === 'string' && fallback !== key ? fallback : key)
        if (values === undefined) return template
        return String(template).replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])))
      }
    }

    /**
     * The panel itself: document on the left, comments on the right, apply in the rail head.
     * Rendered both as the right-dock tab and as the fallback page.
     */
    function CanvasPanel(props) {
      const t = translator(props.t)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const inputActions = props.inputActions

      const [doc, setDoc] = React.useState(null)
      const [version, setVersion] = React.useState(0)
      const [readOnly, setReadOnly] = React.useState(false)
      const [newerSchema, setNewerSchema] = React.useState(false)
      const [loading, setLoading] = React.useState(true)
      const [notice, setNotice] = React.useState(null)
      const [stale, setStale] = React.useState(false)
      const [selection, setSelection] = React.useState(null)
      const [noteOpen, setNoteOpen] = React.useState(false)
      const [noteDraft, setNoteDraft] = React.useState('')
      const [selectedId, setSelectedId] = React.useState(null)
      const [editingId, setEditingId] = React.useState(null)
      const [editingDraft, setEditingDraft] = React.useState('')
      const [reattachId, setReattachId] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [applying, setApplying] = React.useState(false)
      const [prepareTimeout, setPrepareTimeout] = React.useState(false)
      const [batchId, setBatchId] = React.useState(null)
      const [accepted, setAccepted] = React.useState(new Set())
      const [lastResult, setLastResult] = React.useState(null)
      const [typing, setTyping] = React.useState(null)
      const [focusHtml, setFocusHtml] = React.useState(null)
      const [focusedId, setFocusedId] = React.useState(null)
      const [exportComments, setExportComments] = React.useState(false)
      const [copyFallback, setCopyFallback] = React.useState(null)
      const [lastBatchId, setLastBatchId] = React.useState(null)

      const docRef = React.useRef(null)
      const versionRef = React.useRef(0)
      const lastWriteRef = React.useRef(0)
      const blockNodes = React.useRef(new Map())
      const saveTimers = React.useRef(new Map())
      const typingTimer = React.useRef(null)
      const typingState = React.useRef(null)
      const prepareTimer = React.useRef(null)
      const staleRef = React.useRef(false)

      const remember = (next) => {
        docRef.current = next
        setDoc(next)
      }

      /**
       * Adopt a server document. Older versions are ignored (the edit-vs-poll race), and a growing
       * block is painted through the typewriter instead of jumping.
       */
      const adopt = (payload, { write = false } = {}) => {
        if (payload === null || payload === undefined) return
        if (!write && !isNewer(versionRef.current, payload)) return
        const next = payload.document ?? payload
        const nextVersion = Number.isFinite(payload.version) ? payload.version : next.version
        const previous = docRef.current
        versionRef.current = nextVersion
        setVersion(nextVersion)
        setReadOnly(payload.readOnly === true)
        setNewerSchema(payload.newerSchema === true)
        staleRef.current = false
        setStale(false)
        const open = (next.comments ?? []).filter((comment) => comment.status === 'open' || comment.status === 'approximate').length
        openCount.set(open)
        // Any adopted change — ours or the agent's — counts as "a write just happened", so the poll
        // holds 500 ms while the document is moving and relaxes to 3 s once it rests.
        lastWriteRef.current = Date.now()
        const startTyping = !write && previous !== null
        if (startTyping) beginTyping(previous, next)
        remember(next)
      }

      /** Start (or restart) the typewriter on the block that grew at its end. */
      const beginTyping = (previous, next) => {
        if (previous.blocks.length !== next.blocks.length) return
        let candidate = null
        for (let index = 0; index < next.blocks.length; index += 1) {
          const before = flat(previous.blocks[index].spans)
          const after = flat(next.blocks[index].spans)
          if (after !== before && after.startsWith(before)) {
            candidate = { blockId: next.blocks[index].id, before: before.length, spans: next.blocks[index].spans, added: after.length - before.length }
            break
          }
        }
        if (candidate === null) return
        const plan = typingPlan(candidate.added)
        if (plan.instant) {
          finishTyping()
          return
        }
        if (typingTimer.current !== null) {
          clearTimeout(typingTimer.current)
          typingTimer.current = null
        }
        typingState.current = { ...candidate, shown: 0 }
        setTyping({ blockId: candidate.blockId, shown: 0, spans: candidate.spans, before: candidate.before })
        const frame = () => {
          const state = typingState.current
          if (state === null) return
          const step = Math.max(1, Math.ceil(16 / Math.max(plan.perCharMs, 0.01)))
          const shown = Math.min(state.spans === null ? 0 : flat(state.spans).length - state.before, state.shown + step)
          state.shown = shown
          setTyping({ blockId: state.blockId, shown, spans: state.spans, before: state.before })
          if (state.shown >= flat(state.spans).length - state.before) {
            typingTimer.current = null
            typingState.current = null
            setTyping(null)
            return
          }
          typingTimer.current = setTimeout(frame, Math.max(1, plan.perCharMs * step))
        }
        typingTimer.current = setTimeout(frame, Math.max(1, plan.perCharMs))
      }

      /** Stop the animation and show the full text. */
      const finishTyping = () => {
        if (typingTimer.current !== null) clearTimeout(typingTimer.current)
        typingTimer.current = null
        typingState.current = null
        setTyping(null)
      }

      /** Load the document once. */
      const reload = async () => {
        setLoading(true)
        try {
          const payload = await call('/canvas/doc')
          adopt(payload, { write: true })
          setNotice(null)
        } catch (error) {
          setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        } finally {
          setLoading(false)
        }
      }

      // One polling loop with a visibility gate; both timers and the listener are cleared on unmount.
      React.useEffect(() => {
        let disposed = false
        let timer = null
        let pendingTimer = null
        const schedule = (delay) => {
          if (disposed) return
          timer = setTimeout(tick, delay)
        }
        async function tick() {
          if (disposed) return
          if (document.visibilityState === 'hidden') {
            timer = null
            return
          }
          try {
            const payload = await call('/canvas/doc')
            if (disposed) return
            adopt(payload)
          } catch {
            // A transient read failure keeps the last good document on screen.
          }
          if (disposed) return
          schedule(pollDelay(lastWriteRef.current, Date.now()))
        }
        const onVisibility = () => {
          if (disposed) return
          if (document.visibilityState === 'hidden') {
            if (timer !== null) clearTimeout(timer)
            timer = null
            return
          }
          if (timer === null) tick()
        }
        reload()
        schedule(POLL_SLOW_MS)
        document.addEventListener('visibilitychange', onVisibility)

        /** Watch the pending batch while an application is in flight. */
        async function pollPending() {
          if (disposed) return
          try {
            const value = await call('/canvas/apply/pending')
            if (disposed) return
            if (value === null) {
              pendingCount.set(0)
              setPending(null)
            } else {
              if (prepareTimer.current !== null) {
                clearTimeout(prepareTimer.current)
                prepareTimer.current = null
              }
              setPrepareTimeout(false)
              pendingCount.set(value.count)
              setPending(value)
              setAccepted(new Set((value.items ?? []).map((item) => item.commentId)))
            }
          } catch {
            // Keep the previous view; the next tick retries.
          }
          if (disposed) return
          pendingTimer = setTimeout(pollPending, PENDING_POLL_MS)
        }
        pollPending()

        return () => {
          disposed = true
          if (timer !== null) clearTimeout(timer)
          if (pendingTimer !== null) clearTimeout(pendingTimer)
          if (typingTimer.current !== null) clearTimeout(typingTimer.current)
          for (const handle of saveTimers.current.values()) clearTimeout(handle)
          saveTimers.current.clear()
          if (prepareTimer.current !== null) clearTimeout(prepareTimer.current)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      /** Persist one block with `If-Match`; a stale version raises the banner instead of overwriting. */
      const saveBlock = async (blockId, spans) => {
        try {
          const payload = await call('/canvas/doc', {
            method: 'PUT',
            headers: { 'if-match': String(versionRef.current) },
            body: { blockId, spans },
          })
          if (Number.isFinite(payload?.version)) {
            versionRef.current = payload.version
            setVersion(payload.version)
          }
          lastWriteRef.current = Date.now()
          for (const touched of payload?.comments ?? []) {
            const current = docRef.current?.comments?.find((comment) => comment.id === touched.id)
            if (current !== undefined) Object.assign(current, touched)
          }
          if (docRef.current !== null) remember({ ...docRef.current })
        } catch (error) {
          if (error.code === 'STALE_VERSION') {
            staleRef.current = true
            setStale(true)
            return
          }
          setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        }
      }

      /** Schedule the 400 ms write that follows a pause in typing. */
      const scheduleSave = (blockId, spans) => {
        const existing = saveTimers.current.get(blockId)
        if (existing !== undefined) clearTimeout(existing)
        const handle = setTimeout(() => {
          saveTimers.current.delete(blockId)
          saveBlock(blockId, spans)
        }, SAVE_PAUSE_MS)
        saveTimers.current.set(blockId, handle)
      }

      /** Read the current selection inside a single block. */
      const readSelection = () => {
        const selectionApi = globalThis.window?.getSelection?.() ?? globalThis.getSelection?.()
        if (selectionApi === null || selectionApi === undefined || selectionApi.rangeCount === 0) return null
        const range = selectionApi.getRangeAt(0)
        if (range.collapsed) return null
        const elementOf = (node) => {
          let current = node
          while (current !== null && current !== undefined) {
            if (current.nodeType === 1 && current.hasAttribute?.('data-block-id')) return current
            current = current.parentNode
          }
          return null
        }
        const startEl = elementOf(range.startContainer)
        const endEl = elementOf(range.endContainer)
        if (startEl === null || endEl === null) return null
        if (startEl !== endEl) {
          setNotice({ tone: 'warn', text: t('sel.oneBlock') })
          return null
        }
        const blockId = startEl.getAttribute('data-block-id')
        const block = docRef.current?.blocks?.find((entry) => entry.id === blockId)
        if (block === undefined) return null
        const text = flat(block.spans)
        const from = Math.min(offsetOf(startEl, range.startContainer, range.startOffset), offsetOf(endEl, range.endContainer, range.endOffset))
        const to = Math.max(offsetOf(startEl, range.startContainer, range.startOffset), offsetOf(endEl, range.endContainer, range.endOffset))
        if (to <= from) return null
        return { blockId, from, to, quote: text.slice(from, to), index: docRef.current.blocks.indexOf(block) }
      }

      const onDocumentMouseUp = () => {
        const found = readSelection()
        if (found !== null) {
          setNotice(null)
          setSelection(found)
          setNoteOpen(false)
          setNoteDraft('')
        }
      }

      /** Highlight the comment a fragment belongs to. */
      const onMarkClick = (event) => {
        const mark = event.target?.closest?.('mark[data-comment]')
        if (mark !== null && mark !== undefined) {
          setSelectedId(mark.getAttribute('data-comment'))
          return
        }
        if (!event.target?.closest?.('[contenteditable="true"]')) {
          setSelectedId(null)
          setSelection(null)
        }
      }

      /** Keep the selected quote, or re-attach an orphaned comment to it. */
      const confirmSelection = async () => {
        if (selection === null) return
        if (reattachId !== null) {
          try {
            await call('/canvas/comment', {
              method: 'POST',
              body: {
                action: 'reanchor',
                commentId: reattachId,
                blockId: selection.blockId,
                from: selection.from,
                to: selection.to,
              },
            })
            setReattachId(null)
            setSelection(null)
            setNotice(null)
            await reload()
          } catch (error) {
            setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
          }
          return
        }
        setNoteOpen(true)
      }

      /** Create the comment the person just wrote a note for. */
      const addComment = async () => {
        if (selection === null) return
        try {
          await call('/canvas/comment', {
            method: 'POST',
            body: { action: 'add', blockId: selection.blockId, from: selection.from, to: selection.to, note: noteDraft },
          })
          setNoteOpen(false)
          setNoteDraft('')
          setSelection(null)
          await reload()
        } catch (error) {
          if (error.code === 'QUOTE_TOO_LONG') {
            setNotice({ tone: 'warn', text: error.message })
            return
          }
          setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        }
      }

      /** Insert the selected fragment into the composer, with a fallback to the clipboard. */
      const quoteToChat = async () => {
        if (selection === null) return
        const text = `> «${selection.quote}»\n(холст, абзац ${selection.index + 1})\n`
        let inserted = false
        try {
          if (inputActions !== undefined && typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
            const span = inputActions.captureInsertion()
            inserted = inputActions.insertText(text, span) === true
          }
        } catch {
          inserted = false
        }
        if (!inserted) {
          if (await copyText(text)) {
            setNotice({ tone: 'warn', text: t('notice.clipboard') })
          } else {
            setCopyFallback(text)
            setNotice({ tone: 'warn', text: t('notice.copyManual') })
          }
          return
        }
        setNotice({ tone: 'info', text: t('notice.inserted') })
        setSelection(null)
      }

      /** Start the apply handshake. */
      const applyAll = async () => {
        if (!sessionId) {
          setNotice({ tone: 'warn', text: t('apply.noSession') })
          return
        }
        setApplying(true)
        setPrepareTimeout(false)
        setLastResult(null)
        try {
          const started = await call('/canvas/apply/prepare', { method: 'POST', body: { sessionId } })
          setBatchId(started.batchId)
          if (prepareTimer.current !== null) clearTimeout(prepareTimer.current)
          prepareTimer.current = setTimeout(() => {
            prepareTimer.current = null
            setPrepareTimeout(true)
          }, PREPARE_TIMEOUT_MS)
        } catch (error) {
          setApplying(false)
          if (error.code === 'APPLY_IN_PROGRESS') setNotice({ tone: 'warn', text: t('apply.busy') })
          else if (error.code === 'NOTHING_TO_APPLY') setNotice({ tone: 'warn', text: t('apply.nothing') })
          else if (error.code === 'NO_SESSION') setNotice({ tone: 'warn', text: t('apply.noSession') })
          else setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        }
      }

      /** Commit the ticked edits. The Host applies them atomically and returns the new version. */
      const commit = async () => {
        if (batchId === null) return
        try {
          const result = await call('/canvas/apply/commit', {
            method: 'POST',
            body: { batchId, accept: [...accepted] },
          })
          setLastResult({ applied: result.applied, total: result.applied + (result.conflicts?.length ?? 0), conflicts: result.conflicts?.length ?? 0 })
          setLastBatchId(result.batchId ?? batchId)
          setPending(null)
          pendingCount.set(0)
          setBatchId(null)
          setApplying(false)
          if (prepareTimer.current !== null) clearTimeout(prepareTimer.current)
          prepareTimer.current = null
          versionRef.current = result.version
          await reload()
        } catch (error) {
          setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        }
      }

      /** Cancel the batch, or roll a committed one back. */
      const discard = async () => {
        const id = batchId ?? pending?.batchId
        if (id === null || id === undefined) {
          setApplying(false)
          setPending(null)
          return
        }
        try {
          await call('/canvas/apply/discard', { method: 'POST', body: { batchId: id } })
          setPending(null)
          pendingCount.set(0)
          setBatchId(null)
          setApplying(false)
          if (prepareTimer.current !== null) clearTimeout(prepareTimer.current)
          prepareTimer.current = null
          await reload()
        } catch (error) {
          setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        }
      }

      /** Undo the last commit by its batch id, the one the Host kept for exactly this rollback. */
      const undo = async () => {
        if (lastResult === null || lastBatchId === null) return
        try {
          await call('/canvas/apply/discard', { method: 'POST', body: { batchId: lastBatchId } })
          setLastResult(null)
          setLastBatchId(null)
          setNotice({ tone: 'info', text: t('apply.undone') })
          await reload()
        } catch (error) {
          setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        }
      }

      const newDocument = async () => {
        try {
          const created = await call('/canvas/doc/new', { method: 'POST' })
          versionRef.current = created.version ?? 1
          setLastResult(null)
          setPending(null)
          await reload()
        } catch (error) {
          setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        }
      }

      const exportDoc = async (format) => {
        try {
          const result = await call('/canvas/export', {
            method: 'POST',
            body: { format, includeComments: exportComments },
          })
          setNotice({ tone: 'info', text: format === 'pdf' ? `${t('export.done', { path: result.path })} ${t('export.pdfHint')}` : t('export.done', { path: result.path }) })
        } catch (error) {
          setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        }
      }

      const commentAction = async (action, commentId, note) => {
        try {
          await call('/canvas/comment', { method: 'POST', body: { action, commentId, note } })
          setEditingId(null)
          await reload()
        } catch (error) {
          setNotice({ tone: 'error', text: t('notice.error', { message: error.message }) })
        }
      }

      /* --------------------------------------------------------------- rendering */

      const comments = doc?.comments ?? []
      const openComments = comments.filter((comment) => comment.status === 'open' || comment.status === 'approximate').length
      const position = new Map(comments.map((comment, index) => [comment.id, index]))
      const ordered = [...comments].sort((left, right) => {
        const leftBlock = doc?.blocks?.findIndex((block) => block.id === left.blockId) ?? 0
        const rightBlock = doc?.blocks?.findIndex((block) => block.id === right.blockId) ?? 0
        if (leftBlock !== rightBlock) return leftBlock - rightBlock
        if (left.from !== right.from) return left.from - right.from
        return (position.get(left.id) ?? 0) - (position.get(right.id) ?? 0)
      })

      const blocksView = (doc?.blocks ?? []).map((block) => {
        const marks = ordered
          .filter((comment) => comment.blockId === block.id && (comment.status === 'open' || comment.status === 'approximate' || comment.status === 'applied'))
          .map((comment) => ({ id: comment.id, from: comment.from, to: comment.to, status: comment.status }))
        // The typewriter paints only the prefix of the newest text; every other block renders whole.
        const typingHere = typing !== null && typing.blockId === block.id
        const visible = typingHere ? sliceSpans(typing.spans, typing.before + typing.shown) : block.spans
        const html = focusedId === block.id && focusHtml !== null ? focusHtml : spansToHtml(visible, marks, selectedId)
        return h(Block, {
          key: block.id,
          block,
          html,
          activeComment: selectedId,
          editable: !readOnly,
          onFocus: (event) => {
            setFocusedId(block.id)
            // Freeze the focused block at what it shows now: a poll cannot reset the caret.
            setFocusHtml(spansToHtml(visible, marks, selectedId))
            event.currentTarget.setAttribute('data-focused', 'true')
          },
          onInput: (event) => {
            const spansNext = serializeSpans(event.currentTarget)
            scheduleSave(block.id, spansNext)
          },
          onBlur: (event) => {
            // Write the final text immediately: a blur is a decision, not a pause.
            const spansNext = serializeSpans(event.currentTarget)
            const handle = saveTimers.current.get(block.id)
            if (handle !== undefined) clearTimeout(handle)
            saveTimers.current.delete(block.id)
            event.currentTarget.removeAttribute('data-focused')
            setFocusedId(null)
            setFocusHtml(null)
            saveBlock(block.id, spansNext)
          },
          onPaste: (event) => {
            // Plain text only: source markup is dropped, formatting comes from the bold/italic state.
            event.preventDefault()
            const text = event.clipboardData?.getData?.('text/plain') ?? ''
            const api = globalThis.document
            if (typeof api.execCommand === 'function') api.execCommand('insertText', false, text)
            else if (event.currentTarget.ownerDocument?.execCommand) event.currentTarget.ownerDocument.execCommand('insertText', false, text)
          },
          onKeyDown: (event) => {
            const meta = event.metaKey || event.ctrlKey
            if (meta && (event.key === 'b' || event.key === 'B')) {
              event.preventDefault()
              event.currentTarget.ownerDocument?.execCommand?.('bold')
              return
            }
            if (meta && (event.key === 'i' || event.key === 'I')) {
              event.preventDefault()
              event.currentTarget.ownerDocument?.execCommand?.('italic')
            }
          },
          onMarkClick,
        })
      })

      const head = h(
        'div',
        { className: 'dshCanvas_head' },
        h('h2', { className: 'dshCanvas_title' }, doc?.title ?? t('doc.untitled')),
        h('span', { className: 'dshCanvas_meta' }, t('doc.version', { version })),
        h('span', { className: 'dshCanvas_spacer' }),
        h('label', { className: 'dshCanvas_check' }, h('input', { type: 'checkbox', checked: exportComments, onChange: () => setExportComments(!exportComments) }), t('export.comments')),
        h('button', { className: 'dshCanvas_btn', onClick: () => exportDoc('html') }, t('export.html')),
        h('button', { className: 'dshCanvas_btn', onClick: () => exportDoc('pdf') }, t('export.pdf')),
        h('button', { className: 'dshCanvas_btn', onClick: newDocument, title: t('doc.newHint') }, t('doc.new')),
      )

      const notices = []
      if (stale) {
        notices.push(
          h(
            'div',
            { key: 'stale', className: 'dshCanvas_notice dshCanvas_noticeWarn' },
            t('notice.stale'),
            h('button', { className: 'dshCanvas_btn', onClick: reload }, t('notice.staleAction')),
          ),
        )
      }
      if (newerSchema || readOnly) {
        notices.push(h('div', { key: 'newer', className: 'dshCanvas_notice dshCanvas_noticeWarn' }, t('notice.newer')))
      }
      if (notice !== null) {
        notices.push(
          h(
            'div',
            {
              key: 'notice',
              className: `dshCanvas_notice${notice.tone === 'error' ? ' dshCanvas_noticeError' : notice.tone === 'warn' ? ' dshCanvas_noticeWarn' : ''}`,
            },
            notice.text,
          ),
        )
      }

      const selectionBar =
        selection === null
          ? null
          : h(
              'div',
              { className: 'dshCanvas_sel' },
              h('span', { className: 'dshCanvas_selQuote' }, t('sel.hint', { quote: selection.quote })),
              h('span', { className: 'dshCanvas_spacer' }),
              h('button', { className: 'dshCanvas_btn dshCanvas_btnPrimary', onClick: confirmSelection }, reattachId !== null ? t('rail.reanchorGo') : t('sel.comment')),
              h('button', { className: 'dshCanvas_btn', onClick: quoteToChat }, t('sel.chat')),
              h('button', { className: 'dshCanvas_btn', onClick: () => setSelection(null) }, t('rail.cancel')),
            )

      const noteEditor =
        noteOpen && selection !== null
          ? h(
              'div',
              { className: 'dshCanvas_note' },
              h('textarea', {
                className: 'dshCanvas_noteInput',
                value: noteDraft,
                placeholder: t('note.placeholder'),
                onChange: (event) => setNoteDraft(event.target.value),
              }),
              h(
                'div',
                { className: 'dshCanvas_rowFoot' },
                h('button', { className: 'dshCanvas_btn dshCanvas_btnPrimary', onClick: addComment }, t('note.add')),
                h('button', { className: 'dshCanvas_btn', onClick: () => setNoteOpen(false) }, t('note.cancel')),
              ),
            )
          : null

      const copyBox =
        copyFallback === null
          ? null
          : h(
              'div',
              { className: 'dshCanvas_note' },
              h('input', {
                className: 'dshCanvas_noteInput',
                readOnly: true,
                value: copyFallback,
                onFocus: (event) => event.currentTarget.select?.(),
              }),
              h('button', { className: 'dshCanvas_btn', onClick: () => setCopyFallback(null) }, t('rail.cancel')),
            )

      const rail = h(
        'aside',
        { className: 'dshCanvas_rail' },
        h(
          'div',
          { className: 'dshCanvas_railHead' },
          t('rail.title'),
          h('span', { className: 'dshCanvas_meta' }, t('rail.openCount', { count: openComments })),
          h('span', { className: 'dshCanvas_spacer' }),
          comments.length >= 500 ? h('span', { className: 'dshCanvas_status' }, '500') : null,
        ),
        h(ApplySection, {
          t,
          openComments,
          pending,
          applying: applying && pending === null,
          overview: pending !== null,
          accepted,
          batch: batchId,
          lastResult,
          timeout: prepareTimeout,
          onApply: applyAll,
          onRetry: applyAll,
          onToggle: (id) => {
            const next = new Set(accepted)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            setAccepted(next)
          },
          onCommit: commit,
          onDiscard: discard,
          onUndo: undo,
        }),
        comments.length >= 500 ? h('div', { className: 'dshCanvas_notice dshCanvas_noticeWarn' }, t('rail.limit')) : null,
        h(CommentRail, {
          comments: ordered,
          t,
          selectedId,
          editingId,
          draft: editingDraft,
          reattachId,
          onSelect: (id) => {
            setSelectedId(id)
            const comment = ordered.find((entry) => entry.id === id)
            const node = comment === undefined ? undefined : blockNodes.current.get(comment.blockId)
            if (node !== undefined && node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' })
          },
          onEdit: (id) => {
            const comment = ordered.find((entry) => entry.id === id)
            setEditingId(id)
            setEditingDraft(comment?.note ?? '')
          },
          onDraft: setEditingDraft,
          onSave: (id) => commentAction('update', id, editingDraft),
          onCancel: () => setEditingId(null),
          onDelete: (id) => commentAction('delete', id),
          onResolve: (id) => commentAction('resolve', id),
          onReanchor: (id) => {
            setReattachId((current) => (current === id ? null : id))
            setSelection(null)
            setNotice({ tone: 'info', text: t('rail.reanchorHint') })
          },
        }),
      )

      const body =
        doc === null
          ? h('div', { className: 'dshCanvas_empty' }, loading ? t('notice.loading') : t('doc.empty'))
          : doc.blocks.length === 0
            ? h('div', { className: 'dshCanvas_empty' }, h('div', null, t('doc.empty')), h('div', null, t('doc.emptyHint')))
            : blocksView

      return h(
        'div',
        {
          className: 'dshCanvas_root',
          'data-canvas-root': 'true',
        },
        head,
        ...notices,
        selectionBar,
        noteEditor,
        copyBox,
        h(
          'div',
          { className: 'dshCanvas_body' },
          h(
            'div',
            {
              className: 'dshCanvas_doc',
              onMouseUp: onDocumentMouseUp,
              onKeyUp: onDocumentMouseUp,
              ref: (node) => {
                if (node === null) return
                blockNodes.current.clear()
                for (const child of node.children ?? []) {
                  const id = child.getAttribute?.('data-block-id')
                  if (id !== null && id !== undefined) blockNodes.current.set(id, child)
                }
              },
            },
            body,
          ),
          rail,
        ),
      )
    }

    /** The tab title: «Холст · N открытых», kept in sync through the count store. */
    function CanvasTabTitle(props) {
      const t = translator(props.t)
      const count = React.useSyncExternalStore(openCount.subscribe, openCount.get)
      return h('span', { className: 'dshCanvas_tabTitle' }, count > 0 ? t('tab.titleCount', { count }) : t('tab.title'))
    }

    /** The conversation-header button, with the pending badge and a light poll of its own. */
    function CanvasHeaderButton(props) {
      const t = translator(props.t)
      const count = React.useSyncExternalStore(pendingCount.subscribe, pendingCount.get)
      const runtime = props.runtime
      React.useEffect(() => {
        let disposed = false
        let timer = null
        const tick = async () => {
          if (disposed) return
          try {
            const value = await call('/canvas/apply/pending')
            if (!disposed) pendingCount.set(value?.count ?? 0)
          } catch {
            // The badge is decoration; a failed poll leaves the last count.
          }
          if (!disposed) timer = setTimeout(tick, 5_000)
        }
        tick()
        return () => {
          disposed = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [])
      return h(
        'button',
        {
          className: 'dshCanvas_headBtn',
          'data-canvas-open': 'true',
          title: count > 0 ? t('badge.pending', { count }) : t('openHint'),
          onClick: () => runtime.open(),
        },
        h('span', null, t('open')),
        count > 0 ? h('span', { className: 'dshCanvas_badge' }, String(count)) : null,
      )
    }

    /** The fallback page, used when this build has no right-dock tab registry. */
    function CanvasPage(props) {
      return h('div', { className: 'dshCanvas_page' }, h(CanvasPanel, props))
    }

    /* ---------------------------------------------------------------------- apply */

    /** Browser services this half needs: the slot registry and copy. */
    const inject = ['slots', 'locale']

    /**
     * Install the surfaces.
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = '@local/dsh-canvas'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'canvas: styles')

      ctx.effect(() => ctx.locale.register(NS, { ru: RUSSIAN }), 'canvas: dictionaries')

      /** Opening the tab: the tab registry when it exists, the fallback page otherwise. */
      const runtime = {
        open: () => {
          try {
            if (typeof ctx.get === 'function') {
              const sidebar = ctx.get('sidebarRight')
              if (sidebar !== undefined && typeof sidebar.openTab === 'function') {
                sidebar.openTab(TAB_KIND)
                return
              }
            }
          } catch {
            // A build without the controller falls through to the page.
          }
          try {
            if (typeof ctx.get === 'function') {
              const layout = ctx.get('layout')
              if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel('canvas')
            }
          } catch {
            // Nothing else to open; the header button stays harmless.
          }
        },
      }

      const headerProps = { runtime }
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'canvas-open', order: 50, locale: NS },
          (props) => h(CanvasHeaderButton, { ...props, ...headerProps }),
        ),
      )

      if (typeof ctx.inject !== 'function') {
        installFallback(ctx, runtime)
        return
      }
      let installed = false
      try {
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          installed = true
          scope.effect(
            () =>
              scope.sidebarRightTabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                title: () => (typeof scope.locale?.bind === 'function' ? scope.locale.bind(NS)('tab.title') : RUSSIAN['tab.title']),
                keepMounted: true,
              }),
            'canvas: tab type',
          )
          scope.slots.inject('sidebar.right.pane.tab', () =>
            scope.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, CanvasPanel),
          )
          scope.slots.inject('sidebar.right.pane.tab.title', () =>
            scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS }, CanvasTabTitle),
          )
        })
      } catch (error) {
        installed = false
        console.warn('[canvas] right-dock tab unavailable:', error)
      }
      if (!installed) installFallback(ctx, runtime)
    }

    /**
     * Degrade to a page when the build has no right-dock tab registry: an entry in the sidebar's
     * panel list plus the `main` page it opens. Each registration is independent, so a build that
     * has only one of the two still gets that one.
     * @param ctx - the client root context.
     * @param {object} runtime - the opener.
     */
    function installFallback(ctx, runtime) {
      try {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'canvas-open', order: 60, locale: NS }, (props) => {
            const t = translator(props.t)
            return h(
              'button',
              {
                className: 'dshCanvas_headBtn',
                title: t('openHint'),
                onClick: () => runtime.open(),
              },
              h('span', null, t('open')),
            )
          }),
        )
      } catch (error) {
        console.warn('[canvas] sidebar panel entry unavailable:', error)
      }
      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'canvas', locale: NS }, (props) => h(CanvasPage, props)),
        )
      } catch (error) {
        console.warn('[canvas] main page unavailable:', error)
      }
    }

    return {
      inject,
      apply,
      /** Pure helpers the offline harness pins: typewriter rate, poll cadence, span rendering. */
      __internal: {
        typingPlan,
        pollDelay,
        isNewer,
        spansToHtml,
        serializeSpans,
        sliceSpans,
        escapeHtml,
        dictionaries: { ru: RUSSIAN },
        constants: {
          FAST_WINDOW_MS,
          POLL_FAST_MS,
          POLL_SLOW_MS,
          TAB_ID,
          TAB_KIND,
          TYPEWRITER_MAX_CHARS,
          TYPEWRITER_BUDGET_MS,
        },
      },
    }
  },
})
