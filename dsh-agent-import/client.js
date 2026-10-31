/**
 * Agent Import — browser half.
 *
 * The onboarding page mirrors how the origin agents present their work: a tree
 * of **projects (folders)**, each holding its own sessions. Every folder and
 * every session carries a checkbox, so a project imports whole or in part:
 *
 *  - checking a session marks its parent folder (a session never imports outside
 *    its project — the folder is what becomes the DSH workspace);
 *  - checking a folder selects all of its sessions, and single sessions can then
 *    be unchecked again;
 *  - the folder header states the state of its sessions (`all` / `part` / none),
 *    and the action bar imports exactly the selection in small batches with
 *    visible progress.
 *
 * The user-facing entry point for migration is the `dsh-migrate` tab, which drives
 * the Host routes of this package. This client half keeps only the `main` page as a
 * deep-link target: the left panel row, the conversation header button and the
 * right-dock tab were removed so the owner never sees two importers.
 *
 * Every read and write goes through the same-origin routes the Host half
 * registers, so the page keeps no Host state and survives a Host restart.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-agent-import',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Copy namespace this bundle owns. */
    const NS = 'agentImportUI';

    /** Main-panel key, sidebar glyph id and right-dock tab identity. */
    const PANEL_ID = 'agent-import';

    /** Same-origin routes registered by the Host half. */
    const ROUTES = {
      tree: '/agent-import/tree',
      importOne: '/agent-import/import',
      importBatch: '/agent-import/import-batch',
      update: '/agent-import/update',
      assets: '/agent-import/assets',
      mcpPlan: '/agent-import/mcp-plan',
      skills: '/agent-import/skills',
    };

    /** Sessions imported per HTTP request; keeps progress moving on big projects. */
    const BATCH_SIZE = 4;

    /**
     * Sessions a project shows. The folder is the unit of import, so the page must
     * hold every session of a realistic project — a capped page would silently
     * import only the visible part of the folder.
     */
    const PROJECT_PAGE = 500;

    /** Short badge per source, used when a project mixes several agents. */
    const SOURCE_SHORT = {
      'claude-code': 'Claude',
      codex: 'Codex',
      'zcode-cli': 'ZCode',
      'zcode-v2': 'ZCode v2',
      kilo: 'Kilo',
      opencode: 'OpenCode',
    };

    /** Russian copy; the owner reads Russian, so it wins by default. */
    const RUSSIAN = {
      'panel.label': 'Импорт агентов',
      'panel.title': 'Импорт из других агентов',
      'panel.subtitle':
        'Проекты и их сессии из Claude Code, Codex, ZCode, KiloCode и OpenCode. Отметьте галочками проект целиком или отдельные сессии — импорт создаст нативные сессии DSH в этом проекте, и их можно будет продолжить.',
      'header.button': 'Импорт агентов',
      'action.refresh': 'Обновить',
      'action.import': 'Импортировать',
      'action.open': 'Открыть',
      'action.update': 'Обновить',
      'action.updateHint': 'Дописать в сессию только то, что появилось в источнике после импорта',
      'update.ok': 'Обновлено: +{messages} сообщений, +{turns} ходов',
      'update.upToDate': 'Источник не изменился — обновлять нечего',
      'update.diverged': 'Источник переписал историю (компакция или правка) — обновление невозможно',
      'update.busy': 'Сессия сейчас выполняется — повторите обновление позже',
      'update.failed': 'Обновление не удалось: {reason}',
      'action.importProject': 'Импортировать проект ({n})',
      'action.importSelected': 'Импортировать выбранное ({n})',
      'action.clearSelection': 'Снять выбор',
      'action.selectAll': 'Выбрать все видимые',
      'action.mcpPlan': 'MCP-предложение',
      'action.copySkill': 'Копировать',
      'state.scanning': 'Сканирую проекты…',
      'state.empty': 'Ничего не найдено — измените поиск или фильтр.',
      'search.placeholder': 'Поиск по проекту или имени сессии',
      'stats': 'Проектов: {projects} · Сессий: {sessions} · Импортировано: {imported}',
      'filter.all': 'Все источники',
      'filter.subagentsHidden': 'Субагентные: скрыты',
      'filter.subagentsShown': 'Субагентные: показаны',
      'option.subagents': 'Контекст субагентных',
      'option.subagentsHint':
        'При импорте добавить в конец сессии содержимое её субагентных сессий (до 10, с пометкой) — чтобы модель при продолжении видела работу субагентов',
      'badge.subagent': 'субагент',
      'project.subagents': '+{n} субагентных',
      'project.subagentsShown': '{n} субагентных',
      'project.sessions': '{n} сессий',
      'project.imported': '{n} уже импортировано',
      'project.hidden': 'ещё {n} — уточните поиск',
      'project.selected': 'выбрано {n} из {m}',
      'selection.summary': 'Выбрано сессий: {sessions} · проектов: {projects}',
      'selection.none': 'Отметьте галочками проект или отдельные сессии',
      'progress.importing': 'Импортирую {done} из {total}…',
      'import.batch': 'Импортировано: {imported} · уже было: {already} · ошибок: {failed}',
      'import.ok': 'Импортирована как {id} — она уже в списке сессий слева',
      'import.duplicate': 'Уже импортирована как {id}',
      'import.failed': 'Импорт не удался: {reason}',
      'session.already': 'уже импортирована',
      'session.empty': '(без имени)',
      'section.assets': 'Скилы, плагины, MCP, конфиги',
      'assets.note':
        'Скилы копируются в ~/.dsh/skills. MCP-серверы предлагаются готовым фрагментом патча профиля: плагин не правит профиль сам, секреты остаются ссылками на переменные окружения.',
      'assets.skills': 'Скилы',
      'assets.plugins': 'Плагины',
      'assets.mcp': 'MCP-серверы',
      'assets.configs': 'Конфиги',
      'assets.already': 'уже в DSH',
      'assets.configured': 'уже настроен',
      'notice.mcpPlan': 'Фрагмент записан: {path}',
      'notice.skillCopied': 'Скопировано в ~/.dsh/skills: {count}',
      'notice.failed': 'Не удалось: {reason}',
      'time.now': 'сейчас',
      'time.min': '{n} мин',
      'time.hour': '{n} ч',
      'time.day': '{n} д',
    };

    const ENGLISH = {
      'panel.label': 'Agent import',
      'panel.title': 'Import from other agents',
      'panel.subtitle':
        'Projects and their sessions from Claude Code, Codex, ZCode, KiloCode and OpenCode. Tick a whole project or single sessions — the import creates native DSH sessions inside that project, ready to continue.',
      'header.button': 'Agent import',
      'action.refresh': 'Refresh',
      'action.import': 'Import',
      'action.open': 'Open',
      'action.update': 'Update',
      'action.updateHint': 'Append only what appeared in the origin after the import',
      'update.ok': 'Updated: +{messages} messages, +{turns} turns',
      'update.upToDate': 'The origin did not change — nothing to update',
      'update.diverged': 'The origin rewrote its history (compaction or edit) — cannot update',
      'update.busy': 'The session is running — retry the update later',
      'update.failed': 'Update failed: {reason}',
      'action.importProject': 'Import project ({n})',
      'action.importSelected': 'Import selection ({n})',
      'action.clearSelection': 'Clear selection',
      'action.selectAll': 'Select all visible',
      'action.mcpPlan': 'MCP proposal',
      'action.copySkill': 'Copy',
      'state.scanning': 'Scanning projects…',
      'state.empty': 'Nothing found — change the search or the filter.',
      'search.placeholder': 'Search by project or session name',
      'stats': 'Projects: {projects} · Sessions: {sessions} · Imported: {imported}',
      'filter.all': 'All sources',
      'filter.subagentsHidden': 'Subagents: hidden',
      'filter.subagentsShown': 'Subagents: shown',
      'option.subagents': 'Subagent context',
      'option.subagentsHint':
        'Append the content of the session\'s subagent sessions to the imported log (up to 10, clearly marked), so the model sees what the spawned runs did',
      'badge.subagent': 'subagent',
      'project.subagents': '+{n} subagents',
      'project.subagentsShown': '{n} subagents',
      'project.sessions': '{n} sessions',
      'project.imported': '{n} imported',
      'project.hidden': '{n} more — narrow the search',
      'project.selected': '{n} of {m} selected',
      'selection.summary': 'Selected sessions: {sessions} · projects: {projects}',
      'selection.none': 'Tick a project or single sessions',
      'progress.importing': 'Importing {done} of {total}…',
      'import.batch': 'Imported: {imported} · already there: {already} · failed: {failed}',
      'import.ok': 'Imported as {id} — it is already in the session list',
      'import.duplicate': 'Already imported as {id}',
      'import.failed': 'Import failed: {reason}',
      'session.already': 'already imported',
      'session.empty': '(unnamed)',
      'section.assets': 'Skills, plugins, MCP, configs',
      'assets.note':
        'Skills are copied into ~/.dsh/skills. MCP servers are proposed as a ready-to-paste profile patch fragment: the plugin never edits the profile and secrets stay environment references.',
      'assets.skills': 'Skills',
      'assets.plugins': 'Plugins',
      'assets.mcp': 'MCP servers',
      'assets.configs': 'Configs',
      'assets.already': 'already in DSH',
      'assets.configured': 'already configured',
      'notice.mcpPlan': 'Fragment written: {path}',
      'notice.skillCopied': 'Copied into ~/.dsh/skills: {count}',
      'notice.failed': 'Failed: {reason}',
      'time.now': 'now',
      'time.min': '{n} min',
      'time.hour': '{n} h',
      'time.day': '{n} d',
    };

    const DICTIONARIES = { ru: RUSSIAN, en: ENGLISH };

    /** Styles, injected once. */
    const CSS = `
      .dshAgentImport_page { display:flex; flex-direction:column; gap:12px; height:100%; min-height:0; padding:20px 24px; overflow:auto; }
      .dshAgentImport_pageHead { display:flex; align-items:flex-start; gap:14px; }
      .dshAgentImport_pageTitle { font-size:17px; font-weight:650; line-height:1.25; }
      .dshAgentImport_pageSub { color:var(--text-secondary,#8b8b93); font-size:12px; line-height:1.5; max-width:780px; margin-top:4px; }
      .dshAgentImport_spacer { flex:1; }
      .dshAgentImport_pill { font-size:11px; color:var(--text-secondary,#8b8b93); border:1px solid var(--border-default,#333); border-radius:999px; padding:3px 10px; white-space:nowrap; }
      .dshAgentImport_toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .dshAgentImport_input { flex:1; min-width:200px; padding:7px 11px; border:1px solid var(--border-default,#333); border-radius:8px; background:var(--surface-raised,#16161a); color:inherit; font-size:13px; }
      .dshAgentImport_btn { padding:5px 11px; border:1px solid var(--border-default,#333); border-radius:7px; background:var(--surface-raised,#16161a); color:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
      .dshAgentImport_btn:hover { border-color:var(--border-strong,#555); }
      .dshAgentImport_btn[disabled] { opacity:.45; cursor:default; }
      .dshAgentImport_btnPrimary { border-color:var(--accent,#4c8bf5); color:var(--accent,#4c8bf5); }
      .dshAgentImport_btnSmall { padding:3px 8px; font-size:11px; }
      .dshAgentImport_bar { display:flex; align-items:center; gap:10px; padding:8px 12px; border:1px solid var(--border-default,#333); border-radius:9px; background:var(--surface-raised,#16161a); position:sticky; top:0; z-index:2; }
      .dshAgentImport_barText { font-size:12px; }
      .dshAgentImport_chip { font-size:11px; color:var(--text-secondary,#8b8b93); border:1px solid var(--border-default,#2a2a2e); border-radius:999px; padding:3px 10px; cursor:pointer; white-space:nowrap; background:transparent; }
      .dshAgentImport_chip[data-on='1'] { border-color:var(--accent,#4c8bf5); color:var(--accent,#4c8bf5); }
      .dshAgentImport_chip[data-off='1'] { opacity:.45; cursor:default; }
      .dshAgentImport_grid { display:flex; flex-direction:column; gap:8px; }
      .dshAgentImport_card { border:1px solid var(--border-default,#2a2a2e); border-radius:10px; overflow:hidden; }
      .dshAgentImport_projectHead { display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; user-select:none; }
      .dshAgentImport_projectHead:hover { background:var(--surface-hover,#1c1c21); }
      .dshAgentImport_caret { width:12px; color:var(--text-secondary,#8b8b93); font-size:10px; }
      .dshAgentImport_checkWrap { display:inline-flex; align-items:center; }
      .dshAgentImport_check { width:14px; height:14px; margin:0; cursor:pointer; accent-color:var(--accent,#4c8bf5); }
      .dshAgentImport_check[disabled] { cursor:default; opacity:.4; }
      .dshAgentImport_projectName { font-weight:600; font-size:13px; white-space:nowrap; }
      .dshAgentImport_path { color:var(--text-secondary,#8b8b93); font-size:10.5px; max-width:30%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .dshAgentImport_badges { display:flex; gap:4px; }
      .dshAgentImport_badge { font-size:9.5px; color:var(--text-secondary,#8b8b93); border:1px solid var(--border-default,#2f2f35); border-radius:5px; padding:1px 5px; white-space:nowrap; }
      .dshAgentImport_count { color:var(--text-secondary,#8b8b93); font-size:11px; white-space:nowrap; }
      .dshAgentImport_tag { font-size:10.5px; color:var(--accent,#4c8bf5); white-space:nowrap; }
      .dshAgentImport_time { color:var(--text-secondary,#8b8b93); font-size:10.5px; white-space:nowrap; }
      .dshAgentImport_sessions { border-top:1px solid var(--border-default,#222); }
      .dshAgentImport_session { display:flex; align-items:center; gap:9px; padding:6px 12px 6px 30px; border-top:1px solid var(--border-default,#1f1f24); position:relative; }
      .dshAgentImport_session:first-child { border-top:none; }
      .dshAgentImport_session:hover { background:var(--surface-hover,#1c1c21); }
      .dshAgentImport_session::before { content:''; position:absolute; left:18px; top:0; bottom:0; width:1px; background:var(--border-default,#2a2a2e); }
      .dshAgentImport_sessionDone { opacity:.6; }
      .dshAgentImport_sessionName { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; }
      .dshAgentImport_sessionNameEmpty { color:var(--text-secondary,#8b8b93); font-style:italic; }
      .dshAgentImport_notice { padding:8px 11px; border-radius:8px; background:var(--surface-raised,#16161a); border:1px solid var(--border-default,#333); font-size:12px; }
      .dshAgentImport_noticeError { border-color:var(--danger,#a33); color:var(--danger,#d66); }
      .dshAgentImport_empty { padding:10px 13px; color:var(--text-secondary,#8b8b93); font-size:11.5px; }
      .dshAgentImport_assetRow { display:flex; align-items:center; gap:10px; padding:6px 13px; border-top:1px solid var(--border-default,#222); }
      .dshAgentImport_pane { display:flex; flex-direction:column; gap:8px; height:100%; min-height:0; padding:9px; font-size:12px; overflow:auto; }
      .dshAgentImport_iconBtn { display:inline-flex; align-items:center; gap:6px; padding:4px 9px; border:1px solid var(--border-default,#333); border-radius:7px; background:transparent; color:inherit; font-size:11.5px; cursor:pointer; }
      .dshAgentImport_iconBtn:hover { border-color:var(--border-strong,#555); }
    `;

    /** Client services reached at click time, so a bare harness cannot throw. */
    const runtime = { selectPanel: null, openSession: null };

    /** Stable identity of one foreign session. */
    const keyOf = (session) => `${session.source}:${session.id}`;

    /** Whether a row is already a DSH session. */
    const isImported = (session) => typeof session.importedSessionId === 'string' && session.importedSessionId !== '';

    /** Timestamp in the project's date format. */
    function formatTime(milliseconds) {
      const date = new Date(Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : Date.now());
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** ZCode-style short age: `сейчас`, `12 мин`, `3 ч`, `5 д`, then the date. */
    function relativeTime(milliseconds, tr) {
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
      const diff = Date.now() - milliseconds;
      if (diff < 60_000) return tr('time.now');
      if (diff < 3_600_000) return tr('time.min', { n: Math.round(diff / 60_000) });
      if (diff < 86_400_000) return tr('time.hour', { n: Math.round(diff / 3_600_000) });
      if (diff < 30 * 86_400_000) return tr('time.day', { n: Math.round(diff / 86_400_000) });
      return formatTime(milliseconds).slice(0, 10);
    }

    /** Translator over one slot's `t`, falling back to the Russian labels. */
    function makeTranslator(t) {
      return (key, values) => {
        let text;
        if (typeof t === 'function') {
          try {
            text = t(key);
          } catch {
            text = undefined;
          }
        }
        if (typeof text !== 'string' || text === '' || text === key) text = RUSSIAN[key] ?? key;
        if (values !== undefined) {
          for (const [name, value] of Object.entries(values)) text = text.replace(new RegExp(`\\{${name}\\}`, 'gu'), String(value));
        }
        return text;
      };
    }

    /** Read one route as JSON, surfacing the Host's error text. */
    async function readJson(url, init) {
      const response = await window.fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        ...(init ?? {}),
      });
      if (!response.ok) {
        let detail = `${response.status}`;
        try {
          const payload = await response.json();
          if (typeof payload?.error === 'string') detail = payload.error;
        } catch {
          /* keep the status */
        }
        throw new Error(detail);
      }
      return await response.json();
    }

    /** Inline glyph; the panel strip renders whatever node it gets. */
    function AgentImportIcon({ size }) {
      const dimension = Number.isFinite(size) ? size : 18;
      return h(
        'svg',
        {
          width: dimension,
          height: dimension,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3 7.5 12 3l9 4.5-9 4.5-9-4.5Z' }),
        h('path', { d: 'M3 12.2 12 16.7l9-4.5', opacity: 0.55 }),
        h('path', { d: 'M3 16.8 12 21.3l9-4.5', opacity: 0.3 }),
        h('path', { d: 'M16.4 8.9v4.1' }),
        h('path', { d: 'm14.9 11.6 1.5 1.6 1.5-1.6' }),
      );
    }

    /** Folder glyph of one project row. */
    function FolderIcon({ size }) {
      const dimension = Number.isFinite(size) ? size : 14;
      return h(
        'svg',
        {
          width: dimension,
          height: dimension,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { opacity: 0.75 },
        },
        h('path', { d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17V7.5Z' }),
      );
    }

    /** Tri-state checkbox: `indeterminate` needs a DOM property, not an attribute. */
    function TriCheckbox({ checked, indeterminate, disabled, title, onChange }) {
      const ref = React.useRef(null);
      React.useEffect(() => {
        if (ref.current !== null) ref.current.indeterminate = indeterminate === true;
      }, [indeterminate]);
      return h('input', {
        ref,
        className: 'dshAgentImport_check',
        type: 'checkbox',
        checked: checked === true,
        disabled: disabled === true,
        title,
        onChange: (event) => onChange(event.target.checked),
      });
    }

    /** Checkbox inside a clickable row: the click must not toggle the row. */
    function CheckSlot({ children }) {
      return h('span', { className: 'dshAgentImport_checkWrap', onClick: (event) => event.stopPropagation() }, children);
    }

    /** One session line inside a project folder. */
    function SessionLine({ session, tr, busy, selected, labels, onToggle, onImport, onUpdate, onOpen }) {
      const imported = isImported(session);
      const title = session.title === '' ? tr('session.empty') : session.title;
      const label = labels[session.source] ?? SOURCE_SHORT[session.source] ?? session.source;
      return h(
        'div',
        { className: imported ? 'dshAgentImport_session dshAgentImport_sessionDone' : 'dshAgentImport_session' },
        h(
          'span',
          { className: 'dshAgentImport_checkWrap' },
          h(TriCheckbox, {
            checked: selected === true,
            disabled: imported === true,
            title: imported === true ? tr('session.already') : title,
            onChange: () => onToggle(session),
          }),
        ),
        h(
          'span',
          { className: 'dshAgentImport_badge', title: label },
          SOURCE_SHORT[session.source] ?? label,
        ),
        session.child === true ? h('span', { className: 'dshAgentImport_tag' }, tr('badge.subagent')) : null,
        h(
          'span',
          { className: session.title === '' ? 'dshAgentImport_sessionName dshAgentImport_sessionNameEmpty' : 'dshAgentImport_sessionName', title },
          title,
        ),
        h('span', { className: 'dshAgentImport_time' }, relativeTime(session.updatedAt, tr)),
        imported
          ? h(
              'span',
              { className: 'dshAgentImport_toolbar' },
              h(
                'button',
                {
                  className: 'dshAgentImport_btn dshAgentImport_btnSmall',
                  type: 'button',
                  disabled: busy === true,
                  title: tr('action.updateHint'),
                  onClick: () => onUpdate(session),
                },
                busy === true ? '…' : tr('action.update'),
              ),
              h(
                'button',
                { className: 'dshAgentImport_btn dshAgentImport_btnSmall', type: 'button', title: session.importedSessionId, onClick: () => onOpen(session.importedSessionId) },
                tr('action.open'),
              ),
            )
          : h(
              'button',
              {
                className: 'dshAgentImport_btn dshAgentImport_btnSmall dshAgentImport_btnPrimary',
                type: 'button',
                disabled: busy === true,
                onClick: () => onImport(session),
              },
              busy === true ? '…' : tr('action.import'),
            ),
      );
    }

    /** One project folder with its own sessions inside. */
    function ProjectCard({ project, tr, labels, open, onToggleOpen, checked, indeterminate, selectedCount, selectableCount, selectedKeys, busyId, importing, showSubagents, onToggleProject, onImportProject, onToggleSession, onImport, onUpdate, onOpen }) {
      return h(
        'div',
        { className: 'dshAgentImport_card' },
        h(
          'div',
          { className: 'dshAgentImport_projectHead', onClick: onToggleOpen },
          h('span', { className: 'dshAgentImport_caret' }, open ? '▾' : '▸'),
          h(
            'span',
            { className: 'dshAgentImport_checkWrap' },
            h(TriCheckbox, {
              checked,
              indeterminate,
              disabled: selectableCount === 0 || importing === true,
              title: tr('project.selected', { n: selectedCount, m: selectableCount }),
              onChange: (next) => onToggleProject(project, next),
            }),
          ),
          h(FolderIcon, { size: 14 }),
          h('span', { className: 'dshAgentImport_projectName', title: project.path }, project.name),
          h('span', { className: 'dshAgentImport_path', title: project.path }, project.path),
          h(
            'span',
            { className: 'dshAgentImport_badges' },
            project.sources.map((source) =>
              h('span', { className: 'dshAgentImport_badge', key: source, title: labels[source] ?? source }, SOURCE_SHORT[source] ?? source),
            ),
          ),
          h('span', { className: 'dshAgentImport_count' }, tr('project.sessions', { n: project.sessionCount })),
          project.importedCount > 0 ? h('span', { className: 'dshAgentImport_tag' }, tr('project.imported', { n: project.importedCount })) : null,
          project.subagentCount > 0
            ? h(
                'span',
                { className: 'dshAgentImport_count', title: tr('option.subagentsHint') },
                tr(showSubagents ? 'project.subagentsShown' : 'project.subagents', { n: project.subagentCount }),
              )
            : null,
          selectedCount > 0 ? h('span', { className: 'dshAgentImport_tag' }, tr('project.selected', { n: selectedCount, m: selectableCount })) : null,
          h('span', { className: 'dshAgentImport_spacer' }),
          h('span', { className: 'dshAgentImport_time' }, relativeTime(project.updatedAt, tr)),
          h(
            'span',
            { className: 'dshAgentImport_checkWrap' },
            h(
              'button',
              {
                className: 'dshAgentImport_btn dshAgentImport_btnSmall dshAgentImport_btnPrimary',
                type: 'button',
                disabled: selectableCount === 0 || importing === true,
                title: tr('action.importProject', { n: selectableCount }),
                onClick: () => onImportProject(project),
              },
              tr('action.importProject', { n: selectableCount }),
            ),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'dshAgentImport_sessions' },
              project.sessions.length === 0
                ? h('div', { className: 'dshAgentImport_empty' }, tr('state.empty'))
                : project.sessions.map((session) =>
                    h(SessionLine, {
                      key: keyOf(session),
                      session,
                      tr,
                      labels,
                      selected: selectedKeys.has(keyOf(session)),
                      busy: busyId === keyOf(session),
                      onToggle: onToggleSession,
                      onImport,
                      onUpdate,
                      onOpen,
                    }),
                  ),
              project.truncated === true
                ? h('div', { className: 'dshAgentImport_empty' }, tr('project.hidden', { n: project.hiddenCount }))
                : null,
            )
          : null,
      );
    }

    /** Skills / plugins / MCP / configs block. */
    function AssetsSection({ tr, assets, loading, onOpen, onMcpPlan, onCopySkill }) {
      const [open, setOpen] = React.useState(false);
      const ready = assets !== null && assets !== undefined;
      return h(
        'div',
        { className: 'dshAgentImport_card' },
        h(
          'div',
          {
            className: 'dshAgentImport_projectHead',
            onClick: () => {
              setOpen((value) => {
                const next = !value;
                if (next) onOpen();
                return next;
              });
            },
          },
          h('span', { className: 'dshAgentImport_caret' }, open ? '▾' : '▸'),
          h('span', { className: 'dshAgentImport_projectName' }, tr('section.assets')),
          ready ? h('span', { className: 'dshAgentImport_count' }, `${assets.skills.items.length + assets.plugins.items.length + assets.mcp.items.length}`) : null,
        ),
        open
          ? h(
              'div',
              null,
              h('div', { className: 'dshAgentImport_empty' }, tr('assets.note')),
              !ready
                ? h('div', { className: 'dshAgentImport_empty' }, loading ? tr('state.scanning') : '')
                : h(
                    'div',
                    null,
                    h(
                      'div',
                      { className: 'dshAgentImport_assetRow' },
                      h('span', { className: 'dshAgentImport_sessionName' }, `${tr('assets.skills')}: ${assets.skills.items.length}`),
                      h('span', { className: 'dshAgentImport_count' }, `${tr('assets.already')}: ${assets.skills.items.filter((skill) => skill.alreadyInDsh).length}`),
                    ),
                    assets.skills.items
                      .filter((skill) => !skill.alreadyInDsh)
                      .slice(0, 40)
                      .map((skill) =>
                        h(
                          'div',
                          { className: 'dshAgentImport_assetRow', key: `${skill.source}:${skill.name}` },
                          h('span', { className: 'dshAgentImport_sessionName', title: skill.target ?? skill.path }, `${skill.name} (${skill.source})`),
                          h('button', { className: 'dshAgentImport_btn dshAgentImport_btnSmall', type: 'button', onClick: () => onCopySkill(skill.name) }, tr('action.copySkill')),
                        ),
                      ),
                    h(
                      'div',
                      { className: 'dshAgentImport_assetRow' },
                      h('span', { className: 'dshAgentImport_sessionName' }, `${tr('assets.mcp')}: ${assets.mcp.items.length}`),
                      h('button', { className: 'dshAgentImport_btn dshAgentImport_btnSmall', type: 'button', onClick: onMcpPlan }, tr('action.mcpPlan')),
                    ),
                    assets.mcp.items.slice(0, 40).map((server) =>
                      h(
                        'div',
                        { className: 'dshAgentImport_assetRow', key: `${server.source}:${server.name}` },
                        h('span', { className: 'dshAgentImport_sessionName' }, server.name),
                        h('span', { className: 'dshAgentImport_count' }, server.source),
                        server.alreadyConfigured === true ? h('span', { className: 'dshAgentImport_count' }, tr('assets.configured')) : null,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dshAgentImport_assetRow' },
                      h('span', { className: 'dshAgentImport_sessionName' }, `${tr('assets.plugins')}: ${assets.plugins.items.length}`),
                    ),
                    h(
                      'div',
                      { className: 'dshAgentImport_assetRow' },
                      h('span', { className: 'dshAgentImport_sessionName' }, `${tr('assets.configs')}: ${assets.configs.filter((config) => config.present).length}`),
                    ),
                  ),
            )
          : null,
      );
    }

    /** The project tree, its selection model and its import actions. */
    function useTree(tr) {
      const [query, setQuery] = React.useState('');
      const [debounced, setDebounced] = React.useState('');
      const [filters, setFilters] = React.useState([]);
      const [tree, setTree] = React.useState(null);
      const [assets, setAssets] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [assetsLoading, setAssetsLoading] = React.useState(false);
      const [busyId, setBusyId] = React.useState('');
      const [notice, setNotice] = React.useState({ text: '', error: false });
      const [selection, setSelection] = React.useState(() => new Set());
      const [progress, setProgress] = React.useState(null);
      /** Whether spawned (subagent) sessions appear as their own rows. */
      const [showSubagents, setShowSubagents] = React.useState(false);
      /** Whether an import folds those transcripts into the parent as context. */
      const [includeSubagents, setIncludeSubagents] = React.useState(false);

      React.useEffect(() => {
        const timer = setTimeout(() => setDebounced(query), 350);
        return () => clearTimeout(timer);
      }, [query]);

      const load = React.useCallback(
        async (fresh) => {
          setLoading(true);
          try {
            const params = new URLSearchParams();
            params.set('perProject', String(PROJECT_PAGE));
            params.set('includeChildren', showSubagents ? '1' : '0');
            if (debounced !== '') params.set('query', debounced);
            for (const id of filters) params.append('source', id);
            if (fresh === true) params.set('fresh', '1');
            const suffix = params.toString();
            setTree(await readJson(`${ROUTES.tree}${suffix === '' ? '' : `?${suffix}`}`));
          } catch (error) {
            setNotice({ text: tr('notice.failed', { reason: error?.message ?? String(error) }), error: true });
          } finally {
            setLoading(false);
          }
        },
        [debounced, filters, showSubagents, tr],
      );

      React.useEffect(() => {
        void load(false);
      }, [load]);

      const loadAssets = React.useCallback(async () => {
        if (assets !== null) return;
        setAssetsLoading(true);
        try {
          setAssets(await readJson(ROUTES.assets));
        } catch (error) {
          setNotice({ text: tr('notice.failed', { reason: error?.message ?? String(error) }), error: true });
        } finally {
          setAssetsLoading(false);
        }
      }, [assets, tr]);

      /** Every selectable (not yet imported) session currently on screen. */
      const visibleSelectable = React.useMemo(() => {
        const rows = [];
        for (const project of tree?.projects ?? []) {
          for (const session of project.sessions) {
            if (isImported(session)) continue;
            rows.push(session);
          }
        }
        return rows;
      }, [tree]);

      const toggleSession = React.useCallback((session) => {
        const key = keyOf(session);
        setSelection((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }, []);

      /**
       * Check or uncheck one whole folder. Checking a folder selects every
       * session it shows; unchecking clears them, and single sessions stay
       * selectable/unselectable afterwards.
       */
      const toggleProject = React.useCallback((project, next) => {
        setSelection((current) => {
          const result = new Set(current);
          for (const session of project.sessions) {
            if (isImported(session)) continue;
            const key = keyOf(session);
            if (next === true) result.add(key);
            else result.delete(key);
          }
          return result;
        });
      }, []);

      const selectAllVisible = React.useCallback(() => {
        setSelection(new Set(visibleSelectable.map(keyOf)));
      }, [visibleSelectable]);

      const clearSelection = React.useCallback(() => setSelection(new Set()), []);

      /** Import one explicit list of sessions, in small batches, with progress. */
      const runImport = React.useCallback(
        async (items) => {
          if (items.length === 0) return;
          setProgress({ done: 0, total: items.length });
          const totals = { imported: 0, already: 0, failed: 0 };
          for (let index = 0; index < items.length; index += BATCH_SIZE) {
            const chunk = items.slice(index, index + BATCH_SIZE);
            try {
              const answer = await readJson(ROUTES.importBatch, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({ items: chunk, includeSubagents }),
              });
              totals.imported += answer.summary.imported;
              totals.already += answer.summary.already;
              totals.failed += answer.summary.failed;
            } catch (error) {
              totals.failed += chunk.length;
              console.warn('[agent-import] batch failed:', error);
            }
            setProgress({ done: Math.min(index + BATCH_SIZE, items.length), total: items.length });
          }
          setProgress(null);
          setSelection(new Set());
          setNotice({ text: tr('import.batch', totals), error: totals.failed > 0 });
          await load(true);
        },
        [includeSubagents, load, tr],
      );

      const importSelection = React.useCallback(() => {
        const items = [];
        for (const project of tree?.projects ?? []) {
          for (const session of project.sessions) {
            if (!selection.has(keyOf(session))) continue;
            items.push({ source: session.source, id: session.id, path: session.path });
          }
        }
        void runImport(items);
      }, [runImport, selection, tree]);

      const importProject = React.useCallback(
        (project) => {
          const items = project.sessions.filter((session) => !isImported(session)).map((session) => ({ source: session.source, id: session.id, path: session.path }));
          void runImport(items);
        },
        [runImport],
      );

      /** Append what appeared in the origin since the import; keeps the session id. */
      const updateSession = React.useCallback(
        async (session) => {
          setBusyId(keyOf(session));
          try {
            const report = await readJson(ROUTES.update, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ source: session.source, id: session.id, path: session.path }),
            });
            const text =
              report.status === 'updated'
                ? tr('update.ok', { messages: report.addedMessages ?? 0, turns: report.addedTurns ?? 0 })
                : report.status === 'up-to-date'
                  ? tr('update.upToDate')
                  : report.status === 'diverged'
                    ? tr('update.diverged')
                    : report.status === 'busy'
                      ? tr('update.busy')
                      : tr('update.failed', { reason: String(report.status ?? '?') });
            setNotice({ text, error: report.status !== 'updated' && report.status !== 'up-to-date' });
            await load(true);
          } catch (error) {
            setNotice({ text: tr('update.failed', { reason: error?.message ?? String(error) }), error: true });
          } finally {
            setBusyId('');
          }
        },
        [load, tr],
      );

      const importSession = React.useCallback(
        async (session) => {
          setBusyId(keyOf(session));
          try {
            const report = await readJson(ROUTES.importOne, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ source: session.source, id: session.id, path: session.path, includeSubagents }),
            });
            setNotice({
              text:
                report.status === 'already-imported'
                  ? tr('import.duplicate', { id: report.sessionId })
                  : tr('import.ok', { id: report.sessionId }),
              error: report.verified === false,
            });
            await load(true);
          } catch (error) {
            setNotice({ text: tr('import.failed', { reason: error?.message ?? String(error) }), error: true });
          } finally {
            setBusyId('');
          }
        },
        [includeSubagents, load, tr],
      );

      const openSession = React.useCallback((sessionId) => {
        const opener = runtime.openSession;
        if (typeof opener === 'function') {
          try {
            opener(sessionId);
          } catch (error) {
            console.warn('[agent-import] openSession failed:', error);
          }
        }
      }, []);

      const writeMcpPlan = React.useCallback(async () => {
        try {
          const result = await readJson(ROUTES.mcpPlan, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' } });
          setNotice({ text: tr('notice.mcpPlan', { path: result.path }), error: false });
        } catch (error) {
          setNotice({ text: tr('notice.failed', { reason: error?.message ?? String(error) }), error: true });
        }
      }, [tr]);

      const copySkill = React.useCallback(
        async (name) => {
          try {
            const result = await readJson(ROUTES.skills, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ names: [name] }),
            });
            setNotice({ text: tr('notice.skillCopied', { count: result.copied.length }), error: result.failed.length > 0 });
            setAssets(null);
            await loadAssets();
          } catch (error) {
            setNotice({ text: tr('notice.failed', { reason: error?.message ?? String(error) }), error: true });
          }
        },
        [loadAssets, tr],
      );

      const toggleFilter = React.useCallback((id) => {
        setFilters((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
      }, []);

      return {
        query,
        setQuery,
        filters,
        toggleFilter,
        tree,
        assets,
        loading,
        assetsLoading,
        busyId,
        notice,
        selection,
        progress,
        showSubagents,
        includeSubagents,
        toggleShowSubagents: () => setShowSubagents((value) => !value),
        toggleIncludeSubagents: () => setIncludeSubagents((value) => !value),
        visibleSelectable,
        reload: () => load(true),
        loadAssets,
        importSession,
        updateSession,
        importProject,
        importSelection,
        selectAllVisible,
        clearSelection,
        toggleSession,
        toggleProject,
        openSession,
        writeMcpPlan,
        copySkill,
      };
    }

    /** Source filter chips, with the reasons of unavailable agents. */
    function SourceFilters({ tr, state, labels }) {
      if (state.tree === null) return null;
      return h(
        'div',
        { className: 'dshAgentImport_toolbar' },
        h(
          'button',
          {
            className: 'dshAgentImport_chip',
            type: 'button',
            'data-on': state.filters.length === 0 ? '1' : '0',
            onClick: () => {
              for (const id of [...state.filters]) state.toggleFilter(id);
            },
          },
          tr('filter.all'),
        ),
        state.tree.sources.map((source) =>
          h(
            'button',
            {
              key: source.id,
              className: 'dshAgentImport_chip',
              type: 'button',
              'data-on': state.filters.includes(source.id) ? '1' : '0',
              'data-off': source.available === true ? '0' : '1',
              title: source.available === true ? `${source.label}: ${source.total}` : `${source.label}: ${source.reason}`,
              onClick: () => {
                if (source.available === true) state.toggleFilter(source.id);
              },
            },
            `${labels[source.id] ?? source.label}${source.available === true ? ` · ${source.total}` : ''}`,
          ),
        ),
        h(
          'button',
          {
            className: 'dshAgentImport_chip',
            type: 'button',
            'data-on': state.showSubagents ? '1' : '0',
            title: tr('option.subagentsHint'),
            onClick: state.toggleShowSubagents,
          },
          state.showSubagents ? tr('filter.subagentsShown') : tr('filter.subagentsHidden'),
        ),
      );
    }

    /** The selection bar: how much is selected, and the one import button. */
    function SelectionBar({ tr, state }) {
      const selected = state.selection.size;
      const importing = state.progress !== null;
      if (selected === 0 && !importing) return null;
      const projects = new Set();
      for (const project of state.tree?.projects ?? []) {
        if (project.sessions.some((session) => state.selection.has(keyOf(session)))) projects.add(project.path);
      }
      return h(
        'div',
        { className: 'dshAgentImport_bar' },
        h(
          'span',
          { className: 'dshAgentImport_barText' },
          importing
            ? tr('progress.importing', { done: state.progress.done, total: state.progress.total })
            : tr('selection.summary', { sessions: selected, projects: projects.size }),
        ),
        h('span', { className: 'dshAgentImport_spacer' }),
        h(
          'button',
          { className: 'dshAgentImport_btn dshAgentImport_btnSmall', type: 'button', disabled: importing, onClick: state.clearSelection },
          tr('action.clearSelection'),
        ),
        h(
          'button',
          { className: 'dshAgentImport_btn dshAgentImport_btnSmall dshAgentImport_btnPrimary', type: 'button', disabled: importing || selected === 0, onClick: state.importSelection },
          tr('action.importSelected', { n: selected }),
        ),
      );
    }

    /** The tree body: project folders with their sessions and checkboxes. */
    function ProjectTree({ tr, state, labels }) {
      const [collapsed, setCollapsed] = React.useState({});
      if (state.tree === null) {
        return state.loading ? h('div', { className: 'dshAgentImport_empty' }, tr('state.scanning')) : null;
      }
      if (state.tree.projects.length === 0) {
        return h('div', { className: 'dshAgentImport_empty' }, tr('state.empty'));
      }
      const importing = state.progress !== null;
      return h(
        'div',
        { className: 'dshAgentImport_grid' },
        state.tree.projects.map((project, index) => {
          const key = project.path;
          const open = collapsed[key] !== undefined ? collapsed[key] === false : index < 3;
          const selectable = project.sessions.filter((session) => !isImported(session));
          const selected = selectable.filter((session) => state.selection.has(keyOf(session)));
          return h(ProjectCard, {
            key,
            project,
            tr,
            labels,
            open,
            onToggleOpen: () => setCollapsed((current) => ({ ...current, [key]: open })),
            checked: selectable.length > 0 && selected.length === selectable.length,
            indeterminate: selected.length > 0 && selected.length < selectable.length,
            selectedCount: selected.length,
            selectableCount: selectable.length,
            selectedKeys: state.selection,
            busyId: state.busyId,
            importing,
            showSubagents: state.showSubagents,
            onToggleProject: state.toggleProject,
            onImportProject: state.importProject,
            onToggleSession: state.toggleSession,
            onImport: state.importSession,
            onUpdate: state.updateSession,
            onOpen: state.openSession,
          });
        }),
      );
    }

    /** The full-page onboarding panel. */
    function ImportPage(props) {
      const tr = makeTranslator(props?.t);
      const state = useTree(tr);
      const tree = state.tree;
      const labels = {};
      for (const source of tree?.sources ?? []) labels[source.id] = source.label;
      const stats = tree === null ? '' : tr('stats', tree.totals);
      const importing = state.progress !== null;

      return h(
        'div',
        { className: 'dshAgentImport_page', 'data-agent-import': 'page' },
        h(
          'div',
          { className: 'dshAgentImport_pageHead' },
          h(
            'div',
            null,
            h('div', { className: 'dshAgentImport_pageTitle' }, tr('panel.title')),
            h('div', { className: 'dshAgentImport_pageSub' }, tr('panel.subtitle')),
          ),
          h('span', { className: 'dshAgentImport_spacer' }),
          stats === '' ? null : h('span', { className: 'dshAgentImport_pill' }, stats),
          h('button', { className: 'dshAgentImport_btn', type: 'button', disabled: importing, onClick: () => void state.reload() }, tr('action.refresh')),
        ),
        h(
          'div',
          { className: 'dshAgentImport_toolbar' },
          h('input', {
            className: 'dshAgentImport_input',
            type: 'search',
            placeholder: tr('search.placeholder'),
            value: state.query,
            onChange: (event) => state.setQuery(event.target.value),
          }),
          h(
            'button',
            { className: 'dshAgentImport_btn dshAgentImport_btnSmall', type: 'button', disabled: importing || state.visibleSelectable.length === 0, onClick: state.selectAllVisible },
            tr('action.selectAll'),
          ),
          h(
            'label',
            {
              className: 'dshAgentImport_chip',
              'data-on': state.includeSubagents ? '1' : '0',
              title: tr('option.subagentsHint'),
              style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
            },
            h('input', {
              type: 'checkbox',
              className: 'dshAgentImport_check',
              checked: state.includeSubagents,
              disabled: importing,
              onChange: state.toggleIncludeSubagents,
            }),
            tr('option.subagents'),
          ),
        ),
        h(SourceFilters, { tr, state, labels }),
        h(SelectionBar, { tr, state }),
        state.notice.text === ''
          ? null
          : h(
              'div',
              { className: state.notice.error ? 'dshAgentImport_notice dshAgentImport_noticeError' : 'dshAgentImport_notice' },
              state.notice.text,
            ),
        h(ProjectTree, { tr, state, labels }),
        h(AssetsSection, {
          tr,
          assets: state.assets,
          loading: state.assetsLoading,
          onOpen: () => void state.loadAssets(),
          onMcpPlan: () => void state.writeMcpPlan(),
          onCopySkill: (name) => void state.copySkill(name),
        }),
      );
    }

    /** The right-dock tab: the same tree in a narrow column. */
    function ImportTab(props) {
      const tr = makeTranslator(props?.t);
      const state = useTree(tr);
      const labels = {};
      for (const source of state.tree?.sources ?? []) labels[source.id] = source.label;
      const importing = state.progress !== null;
      return h(
        'div',
        { className: 'dshAgentImport_pane', 'data-agent-import': 'tab' },
        h(
          'div',
          { className: 'dshAgentImport_toolbar' },
          h('span', { className: 'dshAgentImport_projectName' }, tr('panel.label')),
          h('span', { className: 'dshAgentImport_spacer' }),
          h('button', { className: 'dshAgentImport_btn dshAgentImport_btnSmall', type: 'button', disabled: importing, onClick: () => void state.reload() }, tr('action.refresh')),
        ),
        h('input', {
          className: 'dshAgentImport_input',
          type: 'search',
          placeholder: tr('search.placeholder'),
          value: state.query,
          onChange: (event) => state.setQuery(event.target.value),
        }),
        h(SelectionBar, { tr, state }),
        state.notice.text === ''
          ? null
          : h(
              'div',
              { className: state.notice.error ? 'dshAgentImport_notice dshAgentImport_noticeError' : 'dshAgentImport_notice' },
              state.notice.text,
            ),
        h(ProjectTree, { tr, state, labels }),
      );
    }

    /** Conversation header button: the fastest way into the page from a chat. */
    function HeaderButton(props) {
      const tr = makeTranslator(props?.t);
      return h(
        'button',
        {
          className: 'dshAgentImport_iconBtn',
          type: 'button',
          title: tr('panel.title'),
          onClick: () => {
            const select = runtime.selectPanel;
            if (typeof select === 'function') select(PANEL_ID);
            else console.warn('[agent-import] layout.selectPanel is unavailable in this build');
          },
        },
        h(AgentImportIcon, { size: 14 }),
        h('span', null, tr('header.button')),
      );
    }

    /** Browser services this half needs: the slot registry and copy. */
    const inject = ['slots', 'locale'];

    /**
     * Install every surface of this plugin.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-agent-import';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'agent-import: styles');

      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'agent-import: dictionaries');

      const lookup = (serviceName) => {
        try {
          return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined;
        } catch {
          return undefined;
        }
      };
      runtime.openSession = (sessionId) => {
        const workspace = lookup('uiWorkspace');
        if (workspace !== undefined && workspace !== null && typeof workspace.openSession === 'function') {
          workspace.openSession(sessionId);
        }
      };
      runtime.selectPanel = (panelId) => {
        const layout = lookup('layout');
        if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
          layout.selectPanel(panelId);
          return;
        }
        console.warn('[agent-import] layout.selectPanel is unavailable; open the panel from the left strip');
      };

      const bind = () => {
        try {
          return ctx.locale.bind(NS);
        } catch {
          return (key) => RUSSIAN[key] ?? key;
        }
      };

      // The full page, kept only as a deep-link target: the single user-facing
      // entry point for migration is the `dsh-migrate` tab, which drives these
      // Host routes. The sidebar row, the conversation header button and the
      // right-dock tab were removed so the owner does not see two importers.
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ open: () => runtime.selectPanel?.(PANEL_ID) }) }, ImportPage),
      );
    }

    return { inject, apply };
  },
});


