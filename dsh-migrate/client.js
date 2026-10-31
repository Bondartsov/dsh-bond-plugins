/**
 * DSH Migrate — browser half.
 *
 * One page, two tabs: «Сессии» (import sessions of Claude Code, Codex, ZCode,
 * KiloCode and OpenCode as native DSH sessions) and «Ассеты» (skills, MCP
 * servers, secrets, plugins and instruction documents). Each tab is the working
 * half of the predecessor plugin, kept verbatim — the shell only adds the tab
 * switcher, the shared entry points and the theme-token styles.
 *
 * Owner-requested UI fixes live in this file:
 *  - Refresh really re-requests the tree (`fresh=1`, spinner, new tree);
 *  - a «Обновлено: ДД.ММ.ГГГГ ЧЧ:ММ:СС» stamp sits next to Refresh and is
 *    updated after every load, both tabs;
 *  - expand arrows of groups/projects are a 24×24 target with a 16 px chevron,
 *    `--dsw-alias-label-secondary` at rest and `--dsw-alias-label-primary` on
 *    hover, on both tabs.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-migrate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Copy namespace of the shell (titles, tabs, entries). */
    const SHELL_NS = 'migrateUI';

    /** Main-panel key, sidebar glyph id and right-dock tab identity. */
    const PANEL_ID = 'dsh-migrate';

    /** Which tab the owner opened last. */
    const TAB_STORAGE_KEY = 'dsh-migrate.tab';

    const SHELL_RUSSIAN = {
      'panel.label': 'Миграция',
      'panel.title': 'Миграция из других агентов',
      'panel.subtitle':
        'Сессии и ассеты Claude Code, Codex, ZCode, KiloCode и OpenCode: импорт сессий в нативные сессии DSH и перенос скилов, MCP-серверов, инструкций и секретов. По умолчанию не выбрано ничего.',
      'header.button': 'Миграция',
      'tab.sessions': 'Сессии',
      'tab.assets': 'Ассеты',
    };

    const SHELL_ENGLISH = {
      'panel.label': 'Migration',
      'panel.title': 'Migration from other agents',
      'panel.subtitle':
        'Sessions and assets of Claude Code, Codex, ZCode, KiloCode and OpenCode: import sessions as native DSH sessions and move skills, MCP servers, instructions and secrets. Nothing is selected by default.',
      'header.button': 'Migration',
      'tab.sessions': 'Sessions',
      'tab.assets': 'Assets',
    };

    const SHELL_DICTIONARIES = { ru: SHELL_RUSSIAN, en: SHELL_ENGLISH };

    /** Browser services reached at click time, so a bare harness cannot throw. */
    const runtime = { selectPanel: null, openSession: null, refreshSessionList: null, bindSessions: null, bindAssets: null };

    /** Shell translator over one slot's `t`, falling back to the Russian copy. */
    function shellTranslator(t) {
      return (key, values) => {
        let text;
        if (typeof t === 'function') {
          try {
            text = t(key);
          } catch {
            text = undefined;
          }
        }
        if (typeof text !== 'string' || text === '' || text === key) text = SHELL_RUSSIAN[key] ?? SHELL_ENGLISH[key] ?? key;
        if (values !== undefined) {
          for (const [name, value] of Object.entries(values)) text = text.replace(new RegExp('\\{' + name + '\\}', 'gu'), String(value));
        }
        return text;
      };
    }

    /** Timestamp in the project's date format (`ДД.ММ.ГГГГ ЧЧ:ММ:СС`). */
    function formatTime(milliseconds) {
      const date = new Date(Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : Date.now());
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '.' + date.getFullYear() + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    /** Remember the active tab across plugin reloads; a bare harness may have no storage. */
    function readStoredTab() {
      try {
        const value = window.localStorage.getItem(TAB_STORAGE_KEY);
        return value === 'assets' ? 'assets' : 'sessions';
      } catch {
        return 'sessions';
      }
    }

    function storeTab(tab) {
      try {
        window.localStorage.setItem(TAB_STORAGE_KEY, tab === 'assets' ? 'assets' : 'sessions');
      } catch {
        /* storage is a convenience, not a contract */
      }
    }

    /** The active tab plus a selector that persists the choice. */
    function useActiveTab() {
      const [tab, setTab] = React.useState(readStoredTab);
      const select = (next) => {
        storeTab(next);
        setTab(next === 'assets' ? 'assets' : 'sessions');
      };
      return [tab, select];
    }

    /**
     * The expand arrow of a project / source / type group.
     *
     * A 16 px chevron inside a 24×24 click target: the row head owns the click,
     * this component only renders the affordance and its colour transitions.
     */
    function Caret({ open }) {
      return h(
        'span',
        { className: 'dshMigrate_caret', 'data-open': open === true ? '1' : '0', 'aria-hidden': 'true' },
        h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'm9 6 6 6-6 6' }),
        ),
      );
    }

    /**
     * Refresh button + «Обновлено» stamp.
     *
     * While a request is in flight the button shows a spinner and the busy
     * label, and is disabled, so a double click cannot start two scans.
     */
    function RefreshControl({ loading, disabled, label, busyLabel, updatedLabel, onRefresh, compact }) {
      return h(
        'span',
        { className: 'dshMigrate_refresh', 'data-refresh': loading === true ? 'loading' : 'idle' },
        h(
          'button',
          {
            className: compact === true ? 'dshMigrate_btn dshMigrate_btnSmall' : 'dshMigrate_btn',
            type: 'button',
            'data-action': 'refresh',
            disabled: disabled === true || loading === true,
            onClick: onRefresh,
          },
          loading === true ? h('span', { className: 'dshMigrate_spinner', 'aria-hidden': 'true' }) : null,
          h('span', null, loading === true ? busyLabel : label),
        ),
        h('span', { className: 'dshMigrate_updated', 'data-role': 'updated' }, updatedLabel),
      );
    }

    /** Tab switcher: the same control in the page header and in the dock pane. */
    function TabBar({ tr, tab, onSelect, compact }) {
      const entries = [
        ['sessions', tr('tab.sessions')],
        ['assets', tr('tab.assets')],
      ];
      return h(
        'div',
        { className: compact === true ? 'dshMigrate_tabs dshMigrate_tabsCompact' : 'dshMigrate_tabs', role: 'tablist' },
        entries.map(([id, text]) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              className: 'dshMigrate_tab',
              'data-tab': id,
              'data-active': tab === id ? '1' : '0',
              'aria-selected': tab === id ? 'true' : 'false',
              onClick: () => onSelect(id),
            },
            text,
          ),
        ),
      );
    }

    /** The glyph of the panel strip and the conversation header button. */
    function MigrateIcon({ size }) {
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
        h('path', { d: 'M4 8h11' }),
        h('path', { d: 'm12 5 3 3-3 3' }),
        h('path', { d: 'M20 16H9' }),
        h('path', { d: 'm12 13-3 3 3 3' }),
        h('path', { d: 'M4 4v16', opacity: 0.45 }),
      );
    }

    /** Conversation header button: the fastest way into the page from a chat. */
    function HeaderButton(props) {
      const tr = shellTranslator(props?.t);
      return h(
        'button',
        {
          className: 'dshMigrate_iconBtn',
          type: 'button',
          title: tr('panel.title'),
          onClick: () => {
            const select = runtime.selectPanel;
            if (typeof select === 'function') select(PANEL_ID);
            else console.warn('[dsh-migrate] layout.selectPanel is unavailable in this build');
          },
        },
        h(MigrateIcon, { size: 14 }),
        h('span', null, tr('header.button')),
      );
    }

    /** Shell styles; only `--dsw-alias-*` theme tokens are used. */
    const CSS = `
      .dshMigrate_page { display:flex; flex-direction:column; gap:10px; height:100%; min-height:0; padding:20px 24px; overflow:hidden; color:var(--dsw-alias-label-primary); }
      .dshMigrate_head { display:flex; align-items:flex-start; gap:14px; flex-wrap:wrap; }
      .dshMigrate_title { font-size:17px; font-weight:650; line-height:1.25; color:var(--dsw-alias-label-primary); }
      .dshMigrate_sub { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:1.5; max-width:820px; margin-top:4px; }
      .dshMigrate_spacer { flex:1 1 auto; }
      .dshMigrate_tabs { display:inline-flex; gap:4px; padding:3px; border-radius:10px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2); }
      .dshMigrate_tabsCompact { padding:2px; }
      .dshMigrate_tab { padding:5px 14px; border:none; border-radius:7px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
      .dshMigrate_tab:hover { color:var(--dsw-alias-label-primary); }
      .dshMigrate_tab[data-active='1'] { background:var(--dsw-alias-interactive-bg-hover-accent); color:var(--dsw-alias-state-business-primary); font-weight:600; }
      .dshMigrate_tab:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }
      .dshMigrate_body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; overflow:auto; }
      .dshMigrate_body > * { min-height:0; }
      .dshMigrate_page .dshAgentImport_page, .dshMigrate_page .dshAssetsImport_page { padding:0; }
      .dshMigrate_pane { display:flex; flex-direction:column; gap:8px; height:100%; min-height:0; overflow:auto; font-size:12px; }
      .dshMigrate_pane > * { min-height:0; }
      .dshMigrate_refresh { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .dshMigrate_btn { display:inline-flex; align-items:center; gap:7px; padding:5px 11px; border:1px solid var(--dsw-alias-border-l3); border-radius:7px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
      .dshMigrate_btn:hover:not([disabled]) { background:var(--dsw-alias-interactive-bg-hover); }
      .dshMigrate_btn[disabled] { opacity:.55; cursor:default; }
      .dshMigrate_btnSmall { padding:3px 8px; font-size:11px; }
      .dshMigrate_updated { font-size:11px; color:var(--dsw-alias-label-tertiary); white-space:nowrap; font-variant-numeric:tabular-nums; }
      .dshMigrate_spinner { display:inline-block; width:11px; height:11px; border:2px solid var(--dsw-alias-border-l3); border-top-color:var(--dsw-alias-state-business-primary); border-radius:50%; animation:dshMigrateSpin .7s linear infinite; }
      @keyframes dshMigrateSpin { to { transform:rotate(360deg); } }
      .dshMigrate_caret { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; min-width:24px; min-height:24px; flex:none; border-radius:6px; color:var(--dsw-alias-label-secondary); transition:color .12s ease, background-color .12s ease; }
      .dshMigrate_caret svg { width:16px; height:16px; display:block; transition:transform .12s ease; }
      .dshMigrate_caret[data-open='1'] svg { transform:rotate(90deg); }
      .dshMigrate_caret:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-hover); }
      .dshAgentImport_projectHead:hover .dshMigrate_caret,
      .dshAssetsImport_srcHead:hover .dshMigrate_caret,
      .dshAssetsImport_groupHead:hover .dshMigrate_caret { color:var(--dsw-alias-label-primary); }
      .dshMigrate_iconBtn { display:inline-flex; align-items:center; gap:6px; padding:4px 9px; border:1px solid var(--dsw-alias-border-l3); border-radius:7px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:11.5px; cursor:pointer; }
      .dshMigrate_iconBtn:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .dshMigrate_progress { display:flex; flex-direction:column; gap:6px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-bg-module-platform); }
      .dshMigrate_progressHead { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .dshMigrate_progressTitle { font-size:12.5px; font-weight:600; color:var(--dsw-alias-label-primary); }
      .dshMigrate_progressCounter, .dshMigrate_progressPercent { font-size:11.5px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; white-space:nowrap; }
      .dshMigrate_progressPercent { color:var(--dsw-alias-state-business-primary); font-weight:600; }
      .dshMigrate_progressTrack { height:6px; border-radius:999px; background:var(--dsw-alias-bg-skeleton); overflow:hidden; }
      .dshMigrate_progressFill { height:100%; background:var(--dsw-alias-state-business-primary); transition:width var(--ds-transition-duration) var(--ds-ease-in-out); }
      .dshMigrate_progressStage { font-size:11px; color:var(--dsw-alias-label-tertiary); }
      .dshMigrate_runLog { display:flex; flex-direction:column; gap:2px; max-height:260px; overflow:auto; }
      .dshMigrate_runRow { display:flex; align-items:center; gap:8px; padding:3px 0; border-top:1px solid var(--dsw-alias-border-l1); font-size:11.5px; color:var(--dsw-alias-label-secondary); }
      .dshMigrate_runRow:first-child { border-top:none; }
      .dshMigrate_runName { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-primary); }
      .dshMigrate_runState { font-size:10.5px; border:1px solid var(--dsw-alias-border-l3); border-radius:5px; padding:0 6px; white-space:nowrap; }
      .dshMigrate_runState[data-state='done'] { border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-state-success-primary); }
      .dshMigrate_runState[data-state='failed'] { border-color:var(--dsw-alias-state-error-secondary); color:var(--dsw-alias-state-error-primary); }
      .dshMigrate_runState[data-state='running'] { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-state-business-primary); }
      .dshMigrate_runMeta { font-size:10.5px; color:var(--dsw-alias-label-caption); white-space:nowrap; }
      .dshMigrate_runWarn { font-size:10.5px; color:var(--dsw-alias-state-warn-label); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px; }
      .dshMigrate_runSummary { display:flex; flex-direction:column; gap:3px; padding-top:6px; border-top:1px solid var(--dsw-alias-border-l1); font-size:11.5px; color:var(--dsw-alias-label-secondary); }
      .dshMigrate_runProjects { display:flex; flex-direction:column; gap:1px; color:var(--dsw-alias-label-tertiary); }
      .dshMigrate_runHint { padding:6px 9px; border-radius:var(--dsw-radius-xs); border:1px solid var(--dsw-alias-state-warn-primary); background:var(--dsw-alias-state-warn-tertiary); color:var(--dsw-alias-state-warn-label); font-size:11.5px; line-height:1.5; }
      .dshMigrate_issue, .dshMigrate_attachWarn { display:flex; align-items:flex-start; gap:8px; flex-wrap:wrap; padding:6px 12px 6px 44px; background:var(--dsw-alias-bg-module-platform); border-top:1px solid var(--dsw-alias-border-l1); }
      .dshMigrate_attachWarn { background:var(--dsw-alias-state-warn-tertiary); }
      .dshMigrate_issueBody { display:flex; flex-direction:column; gap:2px; flex:1 1 240px; }
      .dshMigrate_issueText { flex:1 1 240px; font-size:11.5px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
      .dshMigrate_issueHint { font-size:10.5px; line-height:1.45; color:var(--dsw-alias-label-caption); }
      .dshMigrate_issueActions { display:flex; gap:6px; flex-wrap:wrap; }
      .dshMigrate_runCopy { font-size:11px; color:var(--dsw-alias-label-secondary); }
      .dshMigrate_confirm { display:flex; flex-direction:column; gap:8px; padding:12px 14px; border:1px solid var(--dsw-alias-state-warn-primary); border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-state-warn-tertiary); }
      .dshMigrate_confirmTitle { font-size:13px; font-weight:650; color:var(--dsw-alias-state-warn-label); }
      .dshMigrate_confirmText { font-size:12px; line-height:1.55; color:var(--dsw-alias-label-secondary); }
      .dshMigrate_confirmActions { display:flex; gap:8px; flex-wrap:wrap; }
      .dshMigrate_btnPrimary { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-state-business-primary); }
    `;

    /* ------------------------------------------------------- «Сессии» layer */

    const sessionsUI = (function () {
    const NS = 'migrateSessionsUI';

    /** Main-panel key, sidebar glyph id and right-dock tab identity. */
    const PANEL_ID = 'agent-import';

    /** Same-origin routes registered by the Host half. */
    const ROUTES = {
      tree: '/dsh-migrate/sessions/tree',
      importOne: '/dsh-migrate/sessions/import',
      importBatch: '/dsh-migrate/sessions/run',
      runStatus: '/dsh-migrate/sessions/run-status',
      reimport: '/dsh-migrate/sessions/reimport',
      attach: '/dsh-migrate/sessions/attach',
      repairWatermark: '/dsh-migrate/sessions/repair-watermark',
      update: '/dsh-migrate/sessions/update',
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
      'panel.label': 'Сессии',
      'panel.title': 'Импорт из других агентов',
      'panel.subtitle':
        'Проекты и их сессии из Claude Code, Codex, ZCode, KiloCode и OpenCode. Отметьте галочками проект целиком или отдельные сессии — импорт создаст нативные сессии DSH в этом проекте, и их можно будет продолжить.',
      'header.button': 'Импорт агентов',
      'action.refresh': 'Обновить',
      'refresh.busy': 'Обновление…',
      'updated.at': 'Обновлено: {time}',
      'updated.never': 'Обновлено: —',
      'action.import': 'Импортировать',
      'action.open': 'Открыть',
      'action.update': 'Обновить',
      'action.updateHint': 'Дописать в сессию только то, что появилось в источнике после импорта',
      'update.ok': 'Обновлено: +{messages} сообщений, +{turns} ходов',
      'update.upToDate': 'Источник не изменился — обновлять нечего',
      'update.diverged': 'Источник переписал историю (компакция или правка) — обновление невозможно',
      'update.busy': 'Сессия сейчас выполняется — повторите обновление позже',
      'update.failed': 'Обновление не удалось: {reason}',
      'update.rebuilt': 'Пересобрано: создана новая копия {id}, прежняя ушла в архив',
      'update.upToDateRenamed': 'Сообщений новых нет, имя обновлено: «{title}»',
      'update.rebuiltKept': 'Пересобрано: создана новая копия {id}; прежнюю архивировать не удалось — она осталась в списке',
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
        'При импорте добавить в конец сессии содержимое её субагентных сессий (до 50 транскриптов, не более 400 сообщений на каждую и 5000 суммарно, с пометкой) — чтобы модель при продолжении видела работу субагентов',
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
      'progress.title.running': 'Импорт: {done} из {total}',
      'progress.title.done': 'Импорт завершён: {done} из {total}',
      'progress.title.failed': 'Импорт остановлен',
      'progress.counter': '{done} из {total}',
      'progress.stage.queued': 'в очереди',
      'progress.stage.reading': 'чтение источника',
      'progress.stage.building': 'сборка событий',
      'progress.stage.creating': 'создание сессии',
      'progress.stage.writing': 'запись событий',
      'progress.stage.verifying': 'верификация',
      'progress.stage.deleting': 'перенос старой копии в архив',
      'progress.stage.reimporting': 'переимпорт',
      'progress.stage.done': 'готово',
      'progress.stage.already': 'уже импортирована',
      'progress.stage.skipped': 'пропущено',
      'progress.stage.failed': 'ошибка',
      'progress.stage.now': 'Сейчас: {what}',
      'progress.item.pending': 'в очереди',
      'progress.item.running': 'идёт',
      'progress.item.done': 'готово',
      'progress.item.skipped': 'уже была',
      'progress.item.failed': 'ошибка',
      'progress.meta': 'сообщений: {messages} · ходов: {turns}',
      'progress.events': 'событий: {n}',
      'progress.writing': 'записано событий: {done} из {total}',
      'progress.warnings': 'предупреждений: {n}',
      'progress.summary': 'Импортировано: {imported} · переимпортировано: {reimported} · уже было: {already} · ошибок: {failed}',
      'progress.project': 'в проект {title} импортировано {n} сессий',
      'hint.refresh': 'Сессии появятся в списке после перезагрузки плагинов (⟳) или перезапуска DSH.',
      'hint.refreshed': 'Список сессий обновлён — импортированные сессии должны быть видны.',
      'reimport.button': 'Переимпортировать',
      'reimport.confirmTitle': 'Переимпорт создаст новую копию',
      'reimport.confirmText': 'Копия сессии «{title}», созданная импортом, останется на диске и уйдёт в архив; из источника будет собрана новая копия с отметкой объёма. Данные прежней копии сохраняются. Продолжить?',
      'reimport.confirmOk': 'Да, переимпортировать',
      'reimport.cancel': 'Отмена',
      'reimport.running': 'Переимпорт…',
      'update.needsReimport': 'Дописать только новое нельзя: у копии нет отметки об импортированном объёме. Переимпорт создаст новую копию, а прежняя уйдёт в архив.',
      'update.divergedAction': 'Источник переписал начало истории — копия в DSH отстала. Переимпортируйте её из текущего источника.',
      'attach.warning': 'Сессия не в проекте: DSH показывает её в Ungrouped, хотя каталог проекта у неё записан.',
      'attach.button': 'Привязать к проекту',
      'attach.ok': 'Привязано к проекту «{title}».',
      'attach.already': 'Уже в проекте «{title}».',
      'attach.failed': 'Привязать не удалось: {reason}',
      'repair.button': 'Восстановить отметку',
      'repair.hint': 'Отметку можно доказать по совпадению истории — ничего не удаляется и не импортируется заново.',
      'repair.ok': 'Отметка восстановлена: копия совпала с источником на {n} сообщений.',
      'repair.updated': 'Отметка восстановлена, дописано сообщений: {messages}.',
      'repair.diverged': 'Префикс не сходится — источник переписан. Отметку восстановить нельзя, нужна новая копия (переимпорт).',
      'repair.failed': 'Проверить копию не удалось: {reason}',
      'reimport.doneCopy': 'Создана новая копия {id}',
      'reimport.oldArchived': 'старая копия архивирована',
      'reimport.oldKept': 'старую копию архивировать не удалось — она осталась в списке',
      'reimport.confirmTextCopy': 'Будет создана НОВАЯ копия сессии «{title}» из текущего источника. Старая копия будет архивирована — её данные сохранятся, закрывать сессию не нужно. Продолжить?',
      'time.now': 'сейчас',
      'time.min': '{n} мин',
      'time.hour': '{n} ч',
      'time.day': '{n} д',
    };

    const ENGLISH = {
      'panel.label': 'Sessions',
      'panel.title': 'Import from other agents',
      'panel.subtitle':
        'Projects and their sessions from Claude Code, Codex, ZCode, KiloCode and OpenCode. Tick a whole project or single sessions — the import creates native DSH sessions inside that project, ready to continue.',
      'header.button': 'Agent import',
      'action.refresh': 'Refresh',
      'refresh.busy': 'Refreshing…',
      'updated.at': 'Updated: {time}',
      'updated.never': 'Updated: —',
      'action.import': 'Import',
      'action.open': 'Open',
      'action.update': 'Update',
      'action.updateHint': 'Append only what appeared in the origin after the import',
      'update.ok': 'Updated: +{messages} messages, +{turns} turns',
      'update.upToDate': 'The origin did not change — nothing to update',
      'update.diverged': 'The origin rewrote its history (compaction or edit) — cannot update',
      'update.busy': 'The session is running — retry the update later',
      'update.failed': 'Update failed: {reason}',
      'update.rebuilt': 'Rebuilt: a new copy {id} was created and the old one was archived',
      'update.upToDateRenamed': 'No new messages; the name now follows the source: «{title}»',
      'update.rebuiltKept': 'Rebuilt: a new copy {id} was created; the old one could not be archived and stays in the list',
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
      'progress.title.running': 'Import: {done} of {total}',
      'progress.title.done': 'Import finished: {done} of {total}',
      'progress.title.failed': 'Import stopped',
      'progress.counter': '{done} of {total}',
      'progress.stage.queued': 'queued',
      'progress.stage.reading': 'reading the source',
      'progress.stage.building': 'building events',
      'progress.stage.creating': 'creating the session',
      'progress.stage.writing': 'writing events',
      'progress.stage.verifying': 'verifying',
      'progress.stage.deleting': 'moving the old copy to the archive',
      'progress.stage.reimporting': 're-importing',
      'progress.stage.done': 'done',
      'progress.stage.already': 'already imported',
      'progress.stage.skipped': 'skipped',
      'progress.stage.failed': 'failed',
      'progress.stage.now': 'Now: {what}',
      'progress.item.pending': 'queued',
      'progress.item.running': 'running',
      'progress.item.done': 'done',
      'progress.item.skipped': 'already there',
      'progress.item.failed': 'failed',
      'progress.meta': 'messages: {messages} · turns: {turns}',
      'progress.events': 'events: {n}',
      'progress.writing': 'events written: {done} of {total}',
      'progress.warnings': 'warnings: {n}',
      'progress.summary': 'Imported: {imported} · re-imported: {reimported} · already there: {already} · failed: {failed}',
      'progress.project': 'imported into {title}: {n} sessions',
      'hint.refresh': 'Sessions appear in the list after reloading the plugins (⟳) or restarting DSH.',
      'hint.refreshed': 'The session list was refreshed — the imported sessions should be visible.',
      'reimport.button': 'Re-import',
      'reimport.confirmTitle': 'Re-import creates a new copy',
      'reimport.confirmText': 'The copy of «{title}» created by the import stays on disk and moves to the archive; a new copy with a watermark is built from the source. The old copy keeps its data. Continue?',
      'reimport.confirmOk': 'Yes, re-import',
      'reimport.cancel': 'Cancel',
      'reimport.running': 'Re-importing…',
      'update.needsReimport': 'Only new messages cannot be appended: this copy has no imported-size watermark. Re-import creates a new copy and archives the old one.',
      'update.divergedAction': 'The source rewrote the beginning of its history, so the DSH copy lags behind. Re-import it from the current source.',
      'attach.warning': 'The session is not in a project: DSH shows it as Ungrouped even though its project directory is recorded.',
      'attach.button': 'Attach to project',
      'attach.ok': 'Attached to the project «{title}».',
      'attach.already': 'Already in the project «{title}».',
      'attach.failed': 'Attach failed: {reason}',
      'repair.button': 'Restore the watermark',
      'repair.hint': 'The watermark can be proven from matching history — nothing is deleted or re-imported.',
      'repair.ok': 'Watermark restored: the copy matched the source for {n} messages.',
      'repair.updated': 'Watermark restored; appended messages: {messages}.',
      'repair.diverged': 'The prefix does not match — the source rewrote its history. The watermark cannot be restored; a new copy is needed (re-import).',
      'repair.failed': 'Could not verify the copy: {reason}',
      'reimport.doneCopy': 'Created a new copy {id}',
      'reimport.oldArchived': 'the old copy was archived',
      'reimport.oldKept': 'the old copy could not be archived — it stays in the list',
      'reimport.confirmTextCopy': 'A NEW copy of «{title}» will be created from the current source. The old copy will be archived — its data is kept and the session need not be closed. Continue?',
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
      .dshAgentImport_pageSub { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5; max-width:780px; margin-top:4px; }
      .dshAgentImport_spacer { flex:1; }
      .dshAgentImport_pill { font-size:11px; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l2); border-radius:999px; padding:3px 10px; white-space:nowrap; }
      .dshAgentImport_toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .dshAgentImport_input { flex:1; min-width:200px; padding:7px 11px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:inherit; font-size:13px; }
      .dshAgentImport_btn { padding:5px 11px; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; background:var(--dsw-alias-bg-layer-1); color:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
      .dshAgentImport_btn:hover { border-color:var(--dsw-alias-border-l3); }
      .dshAgentImport_btn[disabled] { opacity:.45; cursor:default; }
      .dshAgentImport_btnPrimary { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-state-business-primary); }
      .dshAgentImport_btnSmall { padding:3px 8px; font-size:11px; }
      .dshAgentImport_bar { display:flex; align-items:center; gap:10px; padding:8px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-layer-1); position:sticky; top:0; z-index:2; }
      .dshAgentImport_barText { font-size:12px; }
      .dshAgentImport_chip { font-size:11px; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:3px 10px; cursor:pointer; white-space:nowrap; background:transparent; }
      .dshAgentImport_chip[data-on='1'] { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-state-business-primary); }
      .dshAgentImport_chip[data-off='1'] { opacity:.45; cursor:default; }
      .dshAgentImport_grid { display:flex; flex-direction:column; gap:8px; }
      .dshAgentImport_card { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; overflow:hidden; }
      .dshAgentImport_projectHead { display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; user-select:none; }
      .dshAgentImport_projectHead:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .dshAgentImport_caret { width:12px; color:var(--dsw-alias-label-secondary); font-size:10px; }
      .dshAgentImport_checkWrap { display:inline-flex; align-items:center; }
      .dshAgentImport_check { width:14px; height:14px; margin:0; cursor:pointer; accent-color:var(--dsw-alias-state-business-primary); }
      .dshAgentImport_check[disabled] { cursor:default; opacity:.4; }
      .dshAgentImport_projectName { font-weight:600; font-size:13px; white-space:nowrap; }
      .dshAgentImport_path { color:var(--dsw-alias-label-secondary); font-size:10.5px; max-width:30%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .dshAgentImport_badges { display:flex; gap:4px; }
      .dshAgentImport_badge { font-size:9.5px; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l2); border-radius:5px; padding:1px 5px; white-space:nowrap; }
      .dshAgentImport_count { color:var(--dsw-alias-label-secondary); font-size:11px; white-space:nowrap; }
      .dshAgentImport_tag { font-size:10.5px; color:var(--dsw-alias-state-business-primary); white-space:nowrap; }
      .dshAgentImport_time { color:var(--dsw-alias-label-secondary); font-size:10.5px; white-space:nowrap; }
      .dshAgentImport_sessions { border-top:1px solid var(--dsw-alias-border-l1); }
      .dshAgentImport_session { display:flex; align-items:center; gap:9px; padding:6px 12px 6px 30px; border-top:1px solid var(--dsw-alias-border-l1); position:relative; }
      .dshAgentImport_session:first-child { border-top:none; }
      .dshAgentImport_session:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .dshAgentImport_session::before { content:''; position:absolute; left:18px; top:0; bottom:0; width:1px; background:var(--dsw-alias-border-l1); }
      .dshAgentImport_sessionDone { opacity:.6; }
      .dshAgentImport_sessionName { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; }
      .dshAgentImport_sessionNameEmpty { color:var(--dsw-alias-label-secondary); font-style:italic; }
      .dshAgentImport_notice { padding:8px 11px; border-radius:8px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2); font-size:12px; }
      .dshAgentImport_noticeError { border-color:var(--dsw-alias-state-error-secondary); color:var(--dsw-alias-state-error-primary); }
      .dshAgentImport_empty { padding:10px 13px; color:var(--dsw-alias-label-secondary); font-size:11.5px; }
      .dshAgentImport_assetRow { display:flex; align-items:center; gap:10px; padding:6px 13px; border-top:1px solid var(--dsw-alias-border-l1); }
      .dshAgentImport_pane { display:flex; flex-direction:column; gap:8px; height:100%; min-height:0; padding:9px; font-size:12px; overflow:auto; }
      .dshAgentImport_iconBtn { display:inline-flex; align-items:center; gap:6px; padding:4px 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; background:transparent; color:inherit; font-size:11.5px; cursor:pointer; }
      .dshAgentImport_iconBtn:hover { border-color:var(--dsw-alias-border-l3); }
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

    /** One log row of a run: name, state, counts, warnings. */
    function RunRow({ tr, item }) {
      const title = item.title === '' ? item.id : item.title;
      const meta = [];
      if (item.messages > 0 || item.turns > 0) meta.push(tr('progress.meta', { messages: item.messages, turns: item.turns }));
      if (item.events > 0) meta.push(tr('progress.events', { n: item.events }));
      if (item.stage === 'writing' && item.writeTotal > 0) meta.push(tr('progress.writing', { done: item.writeDone, total: item.writeTotal }));
      const stateKey = item.status === 'pending' ? 'pending' : item.status === 'running' ? 'running' : item.status === 'skipped' ? 'skipped' : item.status === 'failed' ? 'failed' : 'done';
      return h(
        'div',
        { className: 'dshMigrate_runRow', 'data-item-status': item.status },
        h('span', { className: 'dshMigrate_runName', title: item.title === '' ? item.id : item.title }, title),
        h('span', { className: 'dshMigrate_runState', 'data-state': item.status }, tr('progress.item.' + stateKey)),
        meta.length === 0 ? null : h('span', { className: 'dshMigrate_runMeta' }, meta.join(' · ')),
        item.warnings.length > 0
          ? h('span', { className: 'dshMigrate_runWarn', title: item.warnings.join('; ') }, tr('progress.warnings', { n: item.warnings.length }))
          : null,
        item.error === '' ? null : h('span', { className: 'dshMigrate_runWarn' }, item.error),
      );
    }

    /**
     * The live progress of one import: stage sentence, bar, «i из N», the log of
     * every session and — once settled — the totals, per-project counters and the
     * desktop-only reminder to reload the plugins.
     */
    function ImportProgress({ tr, run }) {
      if (run === null || run === undefined) return null;
      const running = run.status === 'running';
      const title = running ? tr('progress.title.running', { done: run.done, total: run.total }) : run.status === 'failed' ? tr('progress.title.failed') : tr('progress.title.done', { done: run.done, total: run.total });
      const current = run.items.find((item) => item.status === 'running');
      const stageText = current === undefined || current.stage === undefined ? tr('progress.stage.' + (run.stage || 'queued')) : tr('progress.stage.now', { what: tr('progress.stage.' + current.stage) });
      const hint = run.hint === undefined || run.hint === null ? null : run.hint;
      return h(
        'div',
        { className: 'dshMigrate_progress', 'data-run-status': run.status, 'data-run-id': run.id },
        h(
          'div',
          { className: 'dshMigrate_progressHead' },
          h('span', { className: 'dshMigrate_progressTitle' }, title),
          h('span', { className: 'dshMigrate_progressCounter' }, tr('progress.counter', { done: run.done, total: run.total })),
          h('span', { className: 'dshMigrate_spacer' }),
          h('span', { className: 'dshMigrate_progressPercent' }, String(run.percent) + '%'),
        ),
        h('div', { className: 'dshMigrate_progressTrack' }, h('div', { className: 'dshMigrate_progressFill', style: { width: String(Math.max(0, Math.min(100, run.percent))) + '%' } })),
        h('div', { className: 'dshMigrate_progressStage', 'data-role': 'run-stage' }, stageText),
        h('div', { className: 'dshMigrate_runLog', 'data-role': 'run-log' }, run.items.map((item) => h(RunRow, { key: String(item.index), tr, item }))),
        running
          ? null
          : h(
              'div',
              { className: 'dshMigrate_runSummary', 'data-role': 'run-summary' },
              h('div', null, tr('progress.summary', {
                imported: run.summary.imported ?? 0,
                reimported: run.summary.reimported ?? 0,
                already: run.summary.already ?? 0,
                failed: run.summary.failed ?? 0,
              })),
              (run.projects ?? []).length === 0
                ? null
                : h('div', { className: 'dshMigrate_runProjects' }, run.projects.map((project) => h('div', { key: project.path }, tr('progress.project', { title: project.title, n: project.imported })))),
              run.kind === 'reimport' && run.items[0] !== undefined && run.items[0].mode === 'copy' && run.items[0].sessionId !== ''
                ? h(
                    'div',
                    { className: 'dshMigrate_runCopy' },
                    tr('reimport.doneCopy', { id: run.items[0].sessionId }),
                    ' · ',
                    run.items[0].archived === true ? tr('reimport.oldArchived') : tr('reimport.oldKept'),
                  )
                : null,
              hint === null || hint.needed !== true
                ? null
                : h('div', { className: 'dshMigrate_runHint', 'data-role': 'refresh-hint' }, hint.refreshWorked === true ? tr('hint.refreshed') : (hint.text === '' || hint.text === undefined ? tr('hint.refresh') : hint.text)),
            ),
      );
    }

    /**
     * The confirmation of one re-import. Deleting the imported copy is the only
     * destructive action of this panel, so it always asks first.
     */
    function ReimportConfirm({ tr, ask, onConfirm, onCancel }) {
      if (ask === null || ask === undefined) return null;
      const title = ask.session.title === '' ? ask.session.id : ask.session.title;
      return h(
        'div',
        { className: 'dshMigrate_confirm', 'data-confirm': 'reimport' },
        h('div', { className: 'dshMigrate_confirmTitle' }, tr('reimport.confirmTitle')),
        h('div', { className: 'dshMigrate_confirmText' }, tr('reimport.confirmTextCopy', { title })),
        h(
          'div',
          { className: 'dshMigrate_confirmActions' },
          h('button', { className: 'dshMigrate_btn dshMigrate_btnSmall dshMigrate_btnPrimary', type: 'button', 'data-action': 'reimport-confirm', onClick: onConfirm }, tr('reimport.confirmOk')),
          h('button', { className: 'dshMigrate_btn dshMigrate_btnSmall', type: 'button', onClick: onCancel }, tr('reimport.cancel')),
        ),
      );
    }

    /** One session line inside a project folder. */
    function SessionLine({ session, tr, busy, selected, labels, issue, onToggle, onImport, onUpdate, onOpen, onAskReimport, onAttach, onRepair }) {
      const imported = isImported(session);
      const title = session.title === '' ? tr('session.empty') : session.title;
      const label = labels[session.source] ?? SOURCE_SHORT[session.source] ?? session.source;
      return h(
        'div',
        { className: 'dshAgentImport_sessionWrap' },
        h(
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
          h('span', { className: 'dshAgentImport_badge', title: label }, SOURCE_SHORT[session.source] ?? label),
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
                    'data-action': 'update',
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
        ),
        imported === true && session.inWorkspace === false
          ? h(
              'div',
              { className: 'dshMigrate_attachWarn', 'data-attach': 'missing' },
              h('span', { className: 'dshMigrate_issueText' }, tr('attach.warning')),
              h(
                'button',
                { className: 'dshAgentImport_btn dshAgentImport_btnSmall dshAgentImport_btnPrimary', type: 'button', 'data-action': 'attach', disabled: busy === true, onClick: () => onAttach(session) },
                busy === true ? '…' : tr('attach.button'),
              ),
            )
          : null,
        issue === null || issue === undefined
          ? null
          : h(
              'div',
              { className: 'dshMigrate_issue', 'data-issue': issue.status },
              h(
                'div',
                { className: 'dshMigrate_issueBody' },
                h('span', { className: 'dshMigrate_issueText' }, issue.message === '' || issue.message === undefined ? tr(issue.status === 'diverged' ? 'update.divergedAction' : 'update.needsReimport') : issue.message),
                h('span', { className: 'dshMigrate_issueHint' }, tr('repair.hint')),
              ),
              h(
                'span',
                { className: 'dshMigrate_issueActions' },
                h(
                  'button',
                  { className: 'dshAgentImport_btn dshAgentImport_btnSmall dshAgentImport_btnPrimary', type: 'button', 'data-action': 'repair-watermark', disabled: busy === true, onClick: () => onRepair(session, issue) },
                  busy === true ? '…' : tr('repair.button'),
                ),
                h(
                  'button',
                  { className: 'dshAgentImport_btn dshAgentImport_btnSmall', type: 'button', 'data-action': 'ask-reimport', disabled: busy === true, onClick: () => onAskReimport(session, issue) },
                  tr('reimport.button'),
                ),
              ),
            ),
      );
    }

    /** One project folder with its own sessions inside. */
    function ProjectCard({ project, tr, labels, open, onToggleOpen, checked, indeterminate, selectedCount, selectableCount, selectedKeys, busyId, importing, showSubagents, updateIssues, onToggleProject, onImportProject, onToggleSession, onImport, onUpdate, onOpen, onAskReimport, onAttach, onRepair }) {
      return h(
        'div',
        { className: 'dshAgentImport_card' },
        h(
          'div',
          { className: 'dshAgentImport_projectHead', onClick: onToggleOpen },
          h(Caret, { open }),
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
                      issue: updateIssues === undefined || updateIssues === null ? null : updateIssues[keyOf(session)] ?? null,
                      onToggle: onToggleSession,
                      onImport,
                      onUpdate,
                      onOpen,
                      onAskReimport,
                      onAttach,
                      onRepair,
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
          h(Caret, { open }),
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

    /** Poll delay one run answer asks for. */
    function pollDelay(answer) {
      const value = Number(answer?.pollMs);
      return Number.isFinite(value) && value >= 100 ? Math.min(5000, value) : 400;
    }

    /** The project tree, its selection model and its import actions. */
    function useTree(tr) {
      const [query, setQuery] = React.useState('');
      const [debounced, setDebounced] = React.useState('');
      const [filters, setFilters] = React.useState([]);
      const [tree, setTree] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      /** When the tree on screen was received; the stamp next to Refresh shows it. */
      const [lastUpdated, setLastUpdated] = React.useState(0);
      /** Translator in a ref: a fresh function per render must not re-trigger the loader. */
      const trRef = React.useRef(tr);
      trRef.current = tr;
      const [busyId, setBusyId] = React.useState('');
      const [notice, setNotice] = React.useState({ text: '', error: false });
      const [selection, setSelection] = React.useState(() => new Set());
      /** The live run snapshot polled from the Host; null before the first import. */
      const [run, setRun] = React.useState(null);
      /** Per-session update dead ends that need a re-import, keyed by source:id. */
      const [updateIssues, setUpdateIssues] = React.useState({});
      /** The unanswered re-import confirmation. */
      const [reimportAsk, setReimportAsk] = React.useState(null);
      const pollRef = React.useRef(null);
      /** Whether spawned (subagent) sessions appear as their own rows. */
      const [showSubagents, setShowSubagents] = React.useState(false);
      /** Whether an import folds those transcripts into the parent as context. */
      const [includeSubagents, setIncludeSubagents] = React.useState(false);

      React.useEffect(() => {
        const timer = setTimeout(() => setDebounced(query), 350);
        return () => clearTimeout(timer);
      }, [query]);

      React.useEffect(
        () => () => {
          if (pollRef.current !== null) clearTimeout(pollRef.current);
          pollRef.current = null;
        },
        [],
      );

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
            const answer = await readJson(ROUTES.tree + (suffix === '' ? '' : '?' + suffix));
            setTree(answer);
            setLastUpdated(Date.now());
          } catch (error) {
            setNotice({ text: trRef.current('notice.failed', { reason: error?.message ?? String(error) }), error: true });
          } finally {
            setLoading(false);
          }
        },
        [debounced, filters, showSubagents],
      );

      React.useEffect(() => {
        void load(false);
      }, [load]);

      /** Poll one run until it settles, then reload the tree and try to refresh the list. */
      const pollRun = React.useCallback(
        async (runId, delay) => {
          try {
            const answer = await readJson(ROUTES.runStatus + '?run=' + encodeURIComponent(runId));
            const snapshot = answer?.run ?? null;
            if (snapshot === null) {
              pollRef.current = null;
              return;
            }
            setRun(snapshot);
            if (snapshot.status === 'running') {
              pollRef.current = setTimeout(() => {
                void pollRun(runId, pollDelay(answer));
              }, delay);
              return;
            }
            pollRef.current = null;
            await load(true);
            setSelection(new Set());
            // The desktop app has no page to reload: ask the client half to refresh
            // its own session list, and fall back to the plugin-reload hint.
            let refreshed = false;
            if (typeof runtime.refreshSessionList === 'function') {
              try {
                refreshed = runtime.refreshSessionList() === true;
              } catch {
                refreshed = false;
              }
            }
            setRun(Object.assign({}, snapshot, { hint: Object.assign({}, snapshot.hint ?? {}, { refreshWorked: refreshed }) }));
          } catch (error) {
            pollRef.current = null;
            setNotice({ text: trRef.current('notice.failed', { reason: error?.message ?? String(error) }), error: true });
          }
        },
        [load],
      );

      /** Start one Host run and subscribe to its progress. */
      const startRun = React.useCallback(
        async (route, payload) => {
          setNotice({ text: '', error: false });
          try {
            const answer = await readJson(route, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(payload),
            });
            setRun(answer?.run ?? null);
            if (typeof answer?.runId === 'string' && answer.runId !== '') {
              void pollRun(answer.runId, pollDelay(answer));
            } else {
              await load(true);
            }
          } catch (error) {
            setNotice({ text: trRef.current('notice.failed', { reason: error?.message ?? String(error) }), error: true });
          }
        },
        [load, pollRun],
      );

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

      /** Import one explicit list of sessions; the Host reports the progress. */
      const runImport = React.useCallback(
        (items) => {
          if (!Array.isArray(items) || items.length === 0) return;
          setSelection(new Set());
          void startRun(ROUTES.importBatch, { items, includeSubagents });
        },
        [includeSubagents, startRun],
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

      /** Post one update and fold the answer into the row state. */
      const runUpdate = React.useCallback(async (session) => {
        const key = keyOf(session);
        const report = await readJson(ROUTES.update, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ source: session.source, id: session.id, path: session.path }),
        });
        if (report.status === 'needs-reimport' || report.status === 'diverged') {
          setUpdateIssues((current) => Object.assign({}, current, {
            [key]: { status: report.status, reason: report.reason ?? '', message: typeof report.message === 'string' ? report.message : '' },
          }));
          setNotice({ text: '', error: false });
          return report;
        }
        setUpdateIssues((current) => {
          if (current[key] === undefined) return current;
          const next = Object.assign({}, current);
          delete next[key];
          return next;
        });
        // `rebuilt` means the engine could not append, so it created a NEW copy and archived the
        // old one: reporting that as "appended N messages" would be a lie about the session id.
        const text =
          report.rebuilt === true
            ? trRef.current(report.archived === false ? 'update.rebuiltKept' : 'update.rebuilt', {
                id: String(report.sessionId ?? ''),
              })
            : report.status === 'updated'
            ? trRef.current('update.ok', { messages: report.addedMessages ?? 0, turns: report.addedTurns ?? 0 })
            : report.status === 'up-to-date'
              ? trRef.current(report.renamedTitle === undefined ? 'update.upToDate' : 'update.upToDateRenamed', {
                  title: String(report.renamedTitle ?? ''),
                })
              : report.status === 'busy'
                ? trRef.current('update.busy')
                : trRef.current('update.failed', { reason: String(report.status ?? '?') });
        setNotice({ text, error: report.status !== 'updated' && report.status !== 'up-to-date' });
        return report;
      }, []);

      /** Prove the inherited copy against its origin and stamp the watermark (no deletion). */
      const repairWatermarkFor = React.useCallback(async (session) => {
        const id = String(session.importedSessionId ?? '');
        if (id === '') return false;
        const answer = await readJson(ROUTES.repairWatermark, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionIds: [id], refs: [{ sessionId: id, path: session.path }] }),
        });
        const item = Array.isArray(answer?.items) ? answer.items[0] : undefined;
        const status = item?.status ?? 'failed';
        if (status === 'repaired') {
          setNotice({ text: trRef.current('repair.ok', { n: item.matchedMessages ?? 0 }), error: false });
          return true;
        }
        setNotice({
          text: status === 'diverged' ? trRef.current('repair.diverged') : trRef.current('repair.failed', { reason: String(item?.reason ?? '?') }),
          error: true,
        });
        return false;
      }, []);

      /**
       * Append what appeared in the origin since the import.
       *
       * A copy without a watermark is repaired first — the proof runs against the
       * stored history, nothing is deleted — and the update is retried in the same
       * click. Only a real divergence falls through to the re-import proposal.
       */
      const updateSession = React.useCallback(
        async (session) => {
          const key = keyOf(session);
          setBusyId(key);
          try {
            let report = await runUpdate(session);
            if (report.status === 'needs-reimport' && (await repairWatermarkFor(session))) {
              report = await runUpdate(session);
              // A rebuild reports itself through its own wording; do not overwrite it with
              // the "watermark repaired, appended N messages" line.
              if (report.rebuilt !== true && (report.status === 'updated' || report.status === 'up-to-date')) {
                setNotice({ text: trRef.current('repair.updated', { messages: report.addedMessages ?? 0 }), error: false });
              }
            }
            await load(true);
          } catch (error) {
            setNotice({ text: trRef.current('update.failed', { reason: error?.message ?? String(error) }), error: true });
          } finally {
            setBusyId('');
          }
        },
        [load, repairWatermarkFor, runUpdate],
      );

      /** «Восстановить отметку» on the row: prove, stamp, retry the update. */
      const repairSession = React.useCallback(
        async (session) => {
          const key = keyOf(session);
          setBusyId(key);
          try {
            if (await repairWatermarkFor(session)) {
              const report = await runUpdate(session);
              // A rebuild reports itself through its own wording; do not overwrite it with
              // the "watermark repaired, appended N messages" line.
              if (report.rebuilt !== true && (report.status === 'updated' || report.status === 'up-to-date')) {
                setNotice({ text: trRef.current('repair.updated', { messages: report.addedMessages ?? 0 }), error: false });
              }
            }
            await load(true);
          } catch (error) {
            setNotice({ text: trRef.current('repair.failed', { reason: error?.message ?? String(error) }), error: true });
          } finally {
            setBusyId('');
          }
        },
        [load, repairWatermarkFor, runUpdate],
      );

      const importSession = React.useCallback(
        (session) => {
          void startRun(ROUTES.importOne, {
            source: session.source,
            id: session.id,
            path: session.path,
            includeSubagents,
          });
        },
        [includeSubagents, startRun],
      );

      /** Ask to re-import one session: the copy is deleted only after the answer. */
      const askReimport = React.useCallback((session, issue) => setReimportAsk({ session, issue }), []);
      const cancelReimport = React.useCallback(() => setReimportAsk(null), []);
      const confirmReimport = React.useCallback(() => {
        const ask = reimportAsk;
        if (ask === null) return;
        setReimportAsk(null);
        const key = keyOf(ask.session);
        setUpdateIssues((current) => {
          if (current[key] === undefined) return current;
          const next = Object.assign({}, current);
          delete next[key];
          return next;
        });
        void startRun(ROUTES.reimport, {
          source: ask.session.source,
          id: ask.session.id,
          path: ask.session.path,
          title: ask.session.title,
          // Non-destructive: a NEW copy is imported and the old one archived, so
          // an open session is never an obstacle.
          mode: 'copy',
          confirm: true,
          includeSubagents,
        });
      }, [includeSubagents, reimportAsk, startRun]);

      /** Put an imported session into the workspace of its own cwd (Ungrouped repair). */
      const attachSession = React.useCallback(
        async (session) => {
          const id = String(session.importedSessionId ?? '');
          if (id === '') return;
          setBusyId(keyOf(session));
          try {
            const answer = await readJson(ROUTES.attach, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ sessionIds: [id] }),
            });
            const item = Array.isArray(answer?.items) ? answer.items[0] : undefined;
            const status = item?.status ?? 'failed';
            const title = String(item?.workspaceTitle ?? '');
            const text =
              status === 'attached'
                ? trRef.current('attach.ok', { title })
                : status === 'already'
                  ? trRef.current('attach.already', { title })
                  : trRef.current('attach.failed', { reason: String(item?.reason ?? '?') });
            setNotice({ text, error: status === 'failed' });
            await load(true);
          } catch (error) {
            setNotice({ text: trRef.current('attach.failed', { reason: error?.message ?? String(error) }), error: true });
          } finally {
            setBusyId('');
          }
        },
        [load],
      );

      const openSession = React.useCallback((sessionId) => {
        const opener = runtime.openSession;
        if (typeof opener === 'function') {
          try {
            opener(sessionId);
          } catch (error) {
            console.warn('[dsh-migrate] openSession failed:', error);
          }
        }
      }, []);

      const toggleFilter = React.useCallback((id) => {
        setFilters((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
      }, []);

      return {
        query,
        setQuery,
        filters,
        toggleFilter,
        tree,
        loading,
        busyId,
        notice,
        selection,
        progress: run !== null && run.status === 'running' ? { done: run.done, total: run.total } : null,
        run,
        updateIssues,
        reimportAsk,
        lastUpdated,
        showSubagents,
        includeSubagents,
        toggleShowSubagents: () => setShowSubagents((value) => !value),
        toggleIncludeSubagents: () => setIncludeSubagents((value) => !value),
        visibleSelectable,
        reload: () => load(true),
        importSession,
        updateSession,
        importProject,
        importSelection,
        selectAllVisible,
        clearSelection,
        toggleSession,
        toggleProject,
        openSession,
        attachSession,
        repairSession,
        askReimport,
        cancelReimport,
        confirmReimport,
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
            updateIssues: state.updateIssues,
            onAskReimport: state.askReimport,
            onAttach: state.attachSession,
            onRepair: state.repairSession,
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
          props?.embedded === true
            ? null
            : h(
                'div',
                null,
                h('div', { className: 'dshAgentImport_pageTitle' }, tr('panel.title')),
                h('div', { className: 'dshAgentImport_pageSub' }, tr('panel.subtitle')),
              ),
          h('span', { className: 'dshAgentImport_spacer' }),
          stats === '' ? null : h('span', { className: 'dshAgentImport_pill' }, stats),
          h(RefreshControl, {
            loading: state.loading,
            disabled: importing,
            label: tr('action.refresh'),
            busyLabel: tr('refresh.busy'),
            updatedLabel: state.lastUpdated === 0 ? tr('updated.never') : tr('updated.at', { time: formatTime(state.lastUpdated) }),
            onRefresh: () => void state.reload(),
          }),
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
        h(ReimportConfirm, { tr, ask: state.reimportAsk, onConfirm: state.confirmReimport, onCancel: state.cancelReimport }),
        h(ImportProgress, { tr, run: state.run }),
        h(ProjectTree, { tr, state, labels }),
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
          h(RefreshControl, {
            compact: true,
            loading: state.loading,
            disabled: importing,
            label: tr('action.refresh'),
            busyLabel: tr('refresh.busy'),
            updatedLabel: state.lastUpdated === 0 ? tr('updated.never') : tr('updated.at', { time: formatTime(state.lastUpdated) }),
            onRefresh: () => void state.reload(),
          }),
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
        h(ReimportConfirm, { tr, ask: state.reimportAsk, onConfirm: state.confirmReimport, onCancel: state.cancelReimport }),
        h(ImportProgress, { tr, run: state.run }),
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


    return { NS, DICTIONARIES, CSS, Page: ImportPage, Tab: ImportTab, runtime };

    })();

    /* ------------------------------------------------------- «Ассеты» layer */

    const assetsUI = (function () {
    const NS = 'migrateAssetsUI';

    /** Main-panel key, sidebar glyph id and right-dock tab identity. */
    const PANEL_ID = 'assets-import';

    /** Same-origin routes registered by the Host half. */
    const ROUTES = {
      tree: '/dsh-migrate/assets/tree',
      run: '/dsh-migrate/assets/run',
      status: '/dsh-migrate/assets/status',
      preview: '/dsh-migrate/assets/preview',
      instruction: '/dsh-migrate/assets/instruction',
    };

    /** Items per import request; MCP items always travel together. */
    const BATCH_SIZE = 8;

    /** Short type names for badges. */
    const TYPE_SHORT = { skills: 'скил', mcp: 'MCP', secrets: 'секрет', plugins: 'плагин', instructions: 'инструкция' };

    /** Default expanded state of the first source cards. */
    const OPEN_SOURCES = 3;

    /** Russian copy — the owner reads Russian, so it wins. */
    const RUSSIAN = {
      'panel.label': 'Ассеты',
      'panel.title': 'Перенос скилов, MCP и инструкций в DSH',
      'panel.subtitle':
        'Дерево ресурсов Claude Code, Codex, ZCode, ~/.agents, KiloCode и OpenCode. Отметьте галочками то, что нужно перенести: скилы копируются в ~/.dsh/skills, MCP-серверы добавляются в cordis.patch.yml профиля (с бэкапом и без дублей), инструкции кладутся маскированной копией для просмотра. По умолчанию не выбрано ничего.',
      'header.button': 'Ассеты',
      'action.refresh': 'Обновить',
      'refresh.busy': 'Обновление…',
      'updated.at': 'Обновлено: {time}',
      'updated.never': 'Обновлено: —',
      'action.selectAll': 'Выбрать все',
      'action.clearAll': 'Снять всё',
      'action.import': 'Импортировать выбранное ({n})',
      'action.preview': 'Просмотр YAML',
      'action.show': 'Показать',
      'action.hide': 'Скрыть',
      'action.yamlOne': 'YAML',
      'search.placeholder': 'Поиск по имени, пути или описанию',
      'state.loading': 'Сканирую источники…',
      'state.empty': 'Ничего не найдено — измените поиск.',
      'state.noSelection': 'Ничего не выбрано',
      'stats': 'Элементов: {total} · импортируемых: {selectable} · источников: {sources}',
      'stats.types': 'Скилы: {skills} · MCP: {mcp} · секреты: {secrets} · плагины: {plugins} · инструкции: {instructions}',
      'status.new': 'новый',
      'status.update': 'обновит',
      'status.exists': 'уже есть',
      'status.available': 'уже читается',
      'status.duplicate': 'дубль',
      'status.invalid': 'не годится',
      'status.view': 'просмотр',
      'status.runtime': 'только рантайм',
      'status.secret.new': 'новая',
      'status.set': 'уже задана',
      'status.empty': 'пустая',
      'status.conflict': 'конфликт',
      'selection.summary': 'Выбрано: {n}',
      'selection.hint': 'Отметьте галочками элементы, группы или источники целиком',
      'progress.running': 'Импортирую {done} из {total}…',
      'report.title': 'Отчёт импорта',
      'report.dryRun': 'Сухой прогон — ничего не записано',
      'report.summary': 'Скопировано: {copied} · обновлено: {updated} · MCP добавлено: {added} · секретов записано: {secrets} · пропущено: {skipped} · ошибок: {failed}',
      'report.envTitle': 'Переменные окружения пользователя (User scope)',
      'report.envWritten': 'Записано переменных: {n}',
      'report.envFailed': 'Ошибок: {n}',
      'report.envPayload': 'Временный файл со значениями удалён: {state}',
      'report.envAcl': 'Доступ к временному файлу: {state}',
      'report.envVerified': 'Проверка по списку User-scope: {state}',
      'report.envRestart': 'Чтобы DSH увидел новые переменные, нужен перезапуск DSH (он сам запускается заново из окружения пользователя).',
      'secrets.title': 'Секреты',
      'secrets.note':
        'В группу попадают только записи, похожие на учётные данные. Значения не показываются, не логируются и не передаются в браузер: видны только имя, источник и длина. Импорт записывает их в переменные окружения пользователя Windows (User scope), без значения в командной строке.',
      'secrets.overwrite': 'перезаписать уже заданные',
      'secrets.overwriteHint':
        'Без этого флага переменные со статусом «уже задана» не трогаются. С флагом их значения будут заменены значениями из источников.',
      'secrets.length': '{n} симв.',
      'secrets.confirmTitle': 'Импорт изменит переменные окружения пользователя Windows',
      'secrets.confirmText':
        'Будет записано переменных: {n}{overwrite}. Значения переносятся из конфигов чужих агентов в ваши переменные окружения (User scope); в браузер они не попадают. Продолжить?',
      'secrets.confirmOverwrite': ' (из них перезаписываются уже заданные: {n})',
      'secrets.confirmOk': 'Да, записать переменные',
      'secrets.confirmCancel': 'Отмена',
      'secrets.onlyNames': 'значения скрыты',
      'report.mcpWrite': 'Профиль: {path}',
      'report.mcpBackup': 'Бэкап: {path}',
      'report.mcpNoBackup': 'Бэкап не создавался — записи не было',
      'report.restart':
        'Чтобы новые MCP-серверы заработали, нужен перезапуск DSH. Плагин его не выполняет, чтобы не оборвать текущие ходы сессий.',
      'preview.title': 'Предпросмотр изменений',
      'preview.warnProfile': 'Этот фрагмент изменит конфигурацию профиля (cordis.patch.yml). Запись выполняется только по кнопке «Импортировать выбранное» и только после бэкапа.',
      'preview.noProfile': 'Выбор не меняет конфигурацию профиля.',
      'preview.yaml': 'YAML для cordis.patch.yml',
      'preview.envMissing': 'Переменная {name} не задана — сервер не сможет авторизоваться.',
      'targets.title': 'Куда поедет',
      'targets.skills': 'Скилы → {path}',
      'targets.patch': 'MCP → {path}',
      'targets.instructions': 'Инструкции → {path}',
      'targets.environment': 'Секреты → переменные окружения пользователя (сейчас задано: {n})',
      'targets.shared': '~/.agents/skills DSH читает сам, импорт не нужен',
      'preview.warnEnv': 'Предпросмотр секретов: {n} переменных будет записано в окружение пользователя. Значения не показываются — только имена, источники и длины.',
      'group.count': '{n}',
      'notice.failed': 'Не удалось: {reason}',
      'notice.nothingSelected': 'Сначала отметьте галочками то, что нужно перенести.',
      'notice.instruction': '{label} — {note}',
      'notice.yamlCopied': 'Фрагмент выделен — скопируйте через Ctrl+C.',
      'mcp.needsEnv': 'Нужны переменные: {list}',
      'mcp.transport': '{transport}',
      'badge.selectable': 'к импорту: {n}',
      'plugins.note': 'Рантайм плагина не переносится: переносятся только его скилы и MCP-записи — они в соседних разделах дерева.',
      'instructions.note': 'Инструкции и конфиги по умолчанию только для просмотра; в профиль они не пишутся.',
    };

    /** English fallback for a non-Russian locale. */
    const ENGLISH = {
      'panel.label': 'Assets',
      'panel.title': 'Import skills, MCP and instructions into DSH',
      'panel.subtitle':
        'Resource tree of Claude Code, Codex, ZCode, ~/.agents, KiloCode and OpenCode. Tick what should move: skills are copied into ~/.dsh/skills, MCP servers are appended to the profile cordis.patch.yml (with a backup and without duplicates), instructions are stored as a masked copy for review. Nothing is selected by default.',
      'header.button': 'Assets',
      'action.refresh': 'Refresh',
      'refresh.busy': 'Refreshing…',
      'updated.at': 'Updated: {time}',
      'updated.never': 'Updated: —',
      'action.selectAll': 'Select all',
      'action.clearAll': 'Clear all',
      'action.import': 'Import selection ({n})',
      'action.preview': 'YAML preview',
      'action.show': 'Show',
      'action.hide': 'Hide',
      'action.yamlOne': 'YAML',
      'search.placeholder': 'Search by name, path or description',
      'state.loading': 'Scanning sources…',
      'state.empty': 'Nothing found — change the search.',
      'stats': 'Items: {total} · importable: {selectable} · sources: {sources}',
      'stats.types': 'Skills: {skills} · MCP: {mcp} · secrets: {secrets} · plugins: {plugins} · instructions: {instructions}',
      'status.new': 'new',
      'status.update': 'will update',
      'status.exists': 'already there',
      'status.available': 'already read',
      'status.duplicate': 'duplicate',
      'status.invalid': 'unusable',
      'status.view': 'view only',
      'status.runtime': 'runtime only',
      'status.secret.new': 'new',
      'status.set': 'already set',
      'status.empty': 'empty',
      'status.conflict': 'conflict',
      'selection.summary': 'Selected: {n}',
      'selection.hint': 'Tick items, groups or whole sources',
      'progress.running': 'Importing {done} of {total}…',
      'report.title': 'Import report',
      'report.dryRun': 'Dry run — nothing was written',
      'report.summary': 'Copied: {copied} · updated: {updated} · MCP added: {added} · secrets written: {secrets} · skipped: {skipped} · failed: {failed}',
      'report.envTitle': 'User environment variables (User scope)',
      'report.envWritten': 'Variables written: {n}',
      'report.envFailed': 'Failed: {n}',
      'report.envPayload': 'Temporary value file removed: {state}',
      'report.envAcl': 'Temporary file access: {state}',
      'report.envVerified': 'User-scope verification: {state}',
      'report.envRestart': 'DSH must be restarted to see the new variables.',
      'secrets.title': 'Secrets',
      'secrets.note':
        'Only credential-looking records appear here. Values are never shown, logged or sent to the browser: only the name, the origin and the length. Import writes them into the Windows user environment (User scope) without a value on any command line.',
      'secrets.overwrite': 'overwrite already set',
      'secrets.overwriteHint': 'Without this flag, variables with status “already set” are left alone. With it, their values are replaced by the origin values.',
      'secrets.length': '{n} chars',
      'secrets.confirmTitle': 'The import will change the Windows user environment',
      'secrets.confirmText': 'Variables to write: {n}{overwrite}. Values move from the foreign configs into your user environment (User scope); they never reach the browser. Continue?',
      'secrets.confirmOverwrite': ' ({n} of them overwrite existing ones)',
      'secrets.confirmOk': 'Yes, write variables',
      'secrets.confirmCancel': 'Cancel',
      'secrets.onlyNames': 'values hidden',
      'report.mcpWrite': 'Profile: {path}',
      'report.mcpBackup': 'Backup: {path}',
      'report.mcpNoBackup': 'No backup — nothing was written',
      'report.restart': 'New MCP servers need a DSH restart. The plugin never restarts it, so running turns are not interrupted.',
      'preview.title': 'Preview of changes',
      'preview.warnProfile': 'This fragment changes the profile configuration (cordis.patch.yml). It is written only by “Import selection”, and only after a backup.',
      'preview.noProfile': 'This selection does not change the profile.',
      'preview.yaml': 'YAML for cordis.patch.yml',
      'preview.envMissing': 'Variable {name} is not set — the server cannot authenticate.',
      'targets.title': 'Where it goes',
      'targets.skills': 'Skills → {path}',
      'targets.patch': 'MCP → {path}',
      'targets.instructions': 'Instructions → {path}',
      'targets.environment': 'Secrets → user environment variables (currently set: {n})',
      'targets.shared': 'DSH already reads ~/.agents/skills, no import needed',
      'preview.warnEnv': 'Secret preview: {n} variables will be written into the user environment. Values are not shown — names, origins and lengths only.',
      'notice.failed': 'Failed: {reason}',
      'notice.nothingSelected': 'Tick what should move first.',
      'notice.instruction': '{label} — {note}',
      'mcp.needsEnv': 'Needs variables: {list}',
      'badge.selectable': 'importable: {n}',
      'plugins.note': 'A plugin runtime is not portable: only its skills and MCP servers travel — they sit in the neighbouring tree groups.',
      'instructions.note': 'Instructions and configs are view-only by default; they are never written into the profile.',
    };

    const DICTIONARIES = { ru: RUSSIAN, en: ENGLISH };

    /** Styles, injected once. Only `--dsw-alias-*` theme tokens are used. */
    const CSS = `
      .dshAssetsImport_page { display:flex; flex-direction:column; gap:12px; height:100%; min-height:0; padding:20px 24px; overflow:auto; }
      .dshAssetsImport_pane { display:flex; flex-direction:column; gap:8px; height:100%; min-height:0; padding:9px; font-size:12px; overflow:auto; }
      .dshAssetsImport_head { display:flex; align-items:flex-start; gap:14px; }
      .dshAssetsImport_title { font-size:17px; font-weight:650; line-height:1.25; color:var(--dsw-alias-label-primary); }
      .dshAssetsImport_sub { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:1.5; max-width:820px; margin-top:4px; }
      .dshAssetsImport_spacer { flex:1 1 auto; }
      .dshAssetsImport_pill { font-size:11px; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l3); border-radius:999px; padding:3px 10px; white-space:nowrap; }
      .dshAssetsImport_toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .dshAssetsImport_input { flex:1 1 200px; min-width:180px; padding:7px 11px; border:1px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:13px; font-family:inherit; }
      .dshAssetsImport_input:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }
      .dshAssetsImport_btn { padding:5px 11px; border:1px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-xs); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:12px; font-family:inherit; cursor:pointer; white-space:nowrap; }
      .dshAssetsImport_btn:hover:not([disabled]) { background:var(--dsw-alias-interactive-bg-hover); }
      .dshAssetsImport_btn[disabled] { opacity:.45; cursor:default; }
      .dshAssetsImport_btnPrimary { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-state-business-primary); }
      .dshAssetsImport_btnPrimary:hover:not([disabled]) { background:var(--dsw-alias-interactive-bg-hover-accent); }
      .dshAssetsImport_btnSmall { padding:3px 8px; font-size:11px; }
      .dshAssetsImport_bar { display:flex; align-items:center; gap:10px; padding:8px 12px; border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-bg-module-platform); position:sticky; top:0; z-index:2; flex-wrap:wrap; }
      .dshAssetsImport_barText { font-size:12px; color:var(--dsw-alias-label-secondary); }
      .dshAssetsImport_grid { display:flex; flex-direction:column; gap:8px; }
      .dshAssetsImport_card { border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-sm); overflow:hidden; background:var(--dsw-alias-bg-layer-1); }
      .dshAssetsImport_srcHead { display:flex; align-items:center; gap:8px; padding:8px 12px; cursor:pointer; user-select:none; }
      .dshAssetsImport_srcHead:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .dshAssetsImport_caret { width:12px; color:var(--dsw-alias-label-caption); font-size:10px; flex:none; }
      .dshAssetsImport_checkWrap { display:inline-flex; align-items:center; flex:none; }
      .dshAssetsImport_check { width:14px; height:14px; margin:0; cursor:pointer; accent-color:var(--dsw-alias-state-business-primary); }
      .dshAssetsImport_check[disabled] { cursor:default; opacity:.4; }
      .dshAssetsImport_srcName { font-weight:600; font-size:13px; white-space:nowrap; color:var(--dsw-alias-label-primary); }
      .dshAssetsImport_path { color:var(--dsw-alias-label-caption); font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:34%; }
      .dshAssetsImport_count { color:var(--dsw-alias-label-tertiary); font-size:11px; white-space:nowrap; }
      .dshAssetsImport_tag { font-size:10.5px; color:var(--dsw-alias-state-business-primary); white-space:nowrap; }
      .dshAssetsImport_group { border-top:1px solid var(--dsw-alias-border-l1); }
      .dshAssetsImport_groupHead { display:flex; align-items:center; gap:8px; padding:6px 12px 6px 26px; cursor:pointer; user-select:none; }
      .dshAssetsImport_groupHead:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .dshAssetsImport_groupName { font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); }
      .dshAssetsImport_row { display:flex; align-items:center; gap:8px; padding:5px 12px 5px 44px; border-top:1px solid var(--dsw-alias-border-l1); position:relative; }
      .dshAssetsImport_row:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .dshAssetsImport_rowMain { display:flex; flex-direction:column; min-width:0; flex:1 1 auto; gap:1px; }
      .dshAssetsImport_rowName { font-size:12.5px; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .dshAssetsImport_rowSub { font-size:10.5px; color:var(--dsw-alias-label-caption); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .dshAssetsImport_target { font-size:10.5px; color:var(--dsw-alias-label-tertiary); max-width:34%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .dshAssetsImport_arrow { color:var(--dsw-alias-label-caption); font-size:10px; flex:none; }
      .dshAssetsImport_status { font-size:10px; border-radius:5px; padding:1px 6px; white-space:nowrap; flex:none; border:1px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-secondary); }
      .dshAssetsImport_status[data-s='new'] { border-color:var(--dsw-alias-state-business-primary); color:var(--dsw-alias-state-business-primary); }
      .dshAssetsImport_status[data-s='update'] { border-color:var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-state-warn-label); }
      .dshAssetsImport_status[data-s='exists'] { border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-state-success-primary); }
      .dshAssetsImport_status[data-s='available'] { border-color:var(--dsw-alias-state-success-secondary); color:var(--dsw-alias-state-success-secondary); }
      .dshAssetsImport_status[data-s='duplicate'] { opacity:.7; }
      .dshAssetsImport_status[data-s='invalid'] { border-color:var(--dsw-alias-state-error-secondary); color:var(--dsw-alias-state-error-primary); }
      .dshAssetsImport_notice { padding:8px 11px; border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-bg-module-platform); border:1px solid var(--dsw-alias-border-l2); font-size:12px; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; }
      .dshAssetsImport_noticeError { border-color:var(--dsw-alias-state-error-secondary); color:var(--dsw-alias-state-error-primary); }
      .dshAssetsImport_warn { padding:8px 11px; border-radius:var(--dsw-radius-sm); border:1px solid var(--dsw-alias-state-warn-primary); color:var(--dsw-alias-state-warn-label); background:var(--dsw-alias-state-warn-tertiary); font-size:12px; line-height:1.5; }
      .dshAssetsImport_empty { padding:10px 13px; color:var(--dsw-alias-label-tertiary); font-size:11.5px; }
      .dshAssetsImport_progress { height:4px; border-radius:999px; background:var(--dsw-alias-bg-skeleton); overflow:hidden; }
      .dshAssetsImport_progressFill { height:100%; background:var(--dsw-alias-state-business-primary); transition:width var(--ds-transition-duration) var(--ds-ease-in-out); }
      .dshAssetsImport_pre { margin:0; padding:10px 12px; border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-markdown-code-block); color:var(--dsw-alias-label-primary); font-family:var(--ds-font-family-code); font-size:11px; line-height:1.55; overflow:auto; max-height:340px; white-space:pre; }
      .dshAssetsImport_report { border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-sm); overflow:hidden; }
      .dshAssetsImport_reportHead { display:flex; align-items:center; gap:8px; padding:7px 12px; background:var(--dsw-alias-bg-module-platform); font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); }
      .dshAssetsImport_reportRow { display:flex; align-items:center; gap:8px; padding:4px 12px; border-top:1px solid var(--dsw-alias-border-l1); font-size:11.5px; }
      .dshAssetsImport_reportAction { font-family:var(--ds-font-family-code); font-size:10.5px; padding:1px 6px; border-radius:5px; border:1px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-secondary); flex:none; }
      .dshAssetsImport_reportAction[data-ok='1'] { border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-state-success-primary); }
      .dshAssetsImport_reportAction[data-bad='1'] { border-color:var(--dsw-alias-state-error-secondary); color:var(--dsw-alias-state-error-primary); }
      .dshAssetsImport_iconBtn { display:inline-flex; align-items:center; gap:6px; padding:4px 9px; border:1px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-xs); background:transparent; color:var(--dsw-alias-label-primary); font-size:11.5px; font-family:inherit; cursor:pointer; }
      .dshAssetsImport_iconBtn:hover { background:var(--dsw-alias-interactive-bg-hover); }
      .dshAssetsImport_targets { border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-sm); padding:7px 11px; font-size:11px; color:var(--dsw-alias-label-tertiary); display:flex; flex-direction:column; gap:2px; }
      .dshAssetsImport_linkish { color:var(--dsw-alias-link); }
      .dshAssetsImport_groupNote { padding:4px 12px 4px 44px; font-size:10.5px; line-height:1.5; color:var(--dsw-alias-label-caption); }
      .dshAssetsImport_confirm { display:flex; flex-direction:column; gap:8px; padding:12px 14px; border:1px solid var(--dsw-alias-state-warn-primary); border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-state-warn-tertiary); }
      .dshAssetsImport_confirmTitle { font-size:13px; font-weight:650; color:var(--dsw-alias-state-warn-label); }
      .dshAssetsImport_confirmText { font-size:12px; line-height:1.55; color:var(--dsw-alias-label-secondary); }
      .dshAssetsImport_row[data-secret='1'] { background:var(--dsw-alias-bg-module-platform); }
    `;

    /** Client services reached at click time, so a bare harness cannot throw. */
    const runtime = { selectPanel: null, copy: null };

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
        if (typeof text !== 'string' || text === '' || text === key) text = RUSSIAN[key] ?? ENGLISH[key] ?? key;
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

    /** Item identity: the same key the Host resolves. */
    const keyOf = (item) => `${item.type}:${item.source}:${item.name}`;

    /** Whether a row can be imported at all. */
    const isSelectable = (item) => item?.selectable === true;

    /** Human size of a skill directory. */
    function formatSize(bytes) {
      const value = Number(bytes ?? 0);
      if (!Number.isFinite(value) || value <= 0) return '';
      if (value < 1024) return `${value} Б`;
      if (value < 1024 * 1024) return `${Math.round(value / 1024)} КиБ`;
      return `${(value / (1024 * 1024)).toFixed(1)} МиБ`;
    }

    /** Short path: everything before the user's home is dropped. */
    function shortPath(path, home) {
      const text = String(path ?? '');
      if (text === '') return '';
      if (typeof home === 'string' && home !== '' && text.toLowerCase().startsWith(home.toLowerCase())) return `~${text.slice(home.length)}`;
      return text;
    }

    /** Inline glyph of the panel and header button. */
    function AssetsIcon({ size }) {
      const dimension = Number.isFinite(size) ? size : 18;
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
        },
        h('rect', { x: 3.2, y: 4.2, width: 7, height: 7, rx: 1.4 }),
        h('rect', { x: 13.8, y: 4.2, width: 7, height: 7, rx: 1.4 }),
        h('rect', { x: 3.2, y: 14.8, width: 7, height: 5, rx: 1.4 }),
        h('path', { d: 'M13.8 17.3h7' }),
        h('path', { d: 'M17.3 14.2v6.2' }),
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
        className: 'dshAssetsImport_check',
        type: 'checkbox',
        checked: checked === true,
        disabled: disabled === true,
        title,
        onChange: (event) => onChange(event.target.checked),
      });
    }

    /** One status badge. */
    function StatusBadge({ status, tr, note, type }) {
      const key = type === 'secrets' && status === 'new' ? 'status.secret.new' : `status.${status}`;
      return h('span', { className: 'dshAssetsImport_status', 'data-s': status, title: note ?? tr(key) }, tr(key));
    }

    /** One item row: checkbox, name, source sub-line, status and the destination. */
    function ItemRow({ item, tr, home, selected, busy, onToggle, onPreview, onShowInstruction }) {
      const selectable = isSelectable(item);
      const isSecret = item.type === 'secrets';
      // A secret row shows the variable NAME, where it comes from and how long the
      // value is. The value itself is not part of this object at all.
      const sub = isSecret
        ? `${shortPath(item.originPath ?? '', home)}${item.server === '' || item.server === undefined ? '' : ` · сервер ${item.server}`} · ${tr('secrets.length', { n: item.valueLength ?? 0 })} · ${item.masked === '' ? '—' : item.masked}`
        : item.description !== undefined && item.description !== ''
          ? item.description
          : item.type === 'mcp'
            ? `${item.transport}${item.command !== undefined && item.command !== '' ? ` · ${item.command}` : ''}${item.url !== undefined && item.url !== '' ? ` · ${item.url}` : ''}`
            : `${shortPath(item.path, home)}${formatSize(item.sizeBytes) === '' ? '' : ` · ${formatSize(item.sizeBytes)}`}`;
      const needsEnv = Array.isArray(item.needsEnv) ? item.needsEnv : [];
      const target = isSecret ? item.target : shortPath(item.target ?? '', home);
      return h(
        'div',
        { className: 'dshAssetsImport_row', 'data-item': item.id, 'data-secret': isSecret ? '1' : '0' },
        h(
          'span',
          { className: 'dshAssetsImport_checkWrap' },
          h(TriCheckbox, {
            checked: selected,
            disabled: !selectable || busy,
            title: item.note ?? (selectable ? '' : tr(`status.${item.status}`)),
            onChange: () => onToggle(item),
          }),
        ),
        h(
          'div',
          { className: 'dshAssetsImport_rowMain' },
          h('span', { className: 'dshAssetsImport_rowName', title: item.name }, item.name),
          h('span', { className: 'dshAssetsImport_rowSub', title: sub }, sub),
          needsEnv.length > 0
            ? h('span', { className: 'dshAssetsImport_rowSub', title: needsEnv.join(', ') }, tr('mcp.needsEnv', { list: needsEnv.join(', ') }))
            : null,
        ),
        h(StatusBadge, { status: item.status, tr, note: item.note, type: item.type }),
        item.target !== undefined && item.target !== ''
          ? h(
              'span',
              { className: 'dshAssetsImport_checkWrap' },
              h('span', { className: 'dshAssetsImport_arrow' }, '→'),
              h('span', { className: 'dshAssetsImport_target', title: item.target }, target),
            )
          : null,
        item.type === 'mcp'
          ? h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall', type: 'button', disabled: busy, onClick: () => onPreview(item) }, tr('action.yamlOne'))
          : null,
        item.type === 'instructions' && item.previewable === true
          ? h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall', type: 'button', disabled: busy, onClick: () => onShowInstruction(item) }, tr('action.show'))
          : null,
      );
    }

    /** Count selectable items of a group. */
    function selectableOf(items) {
      return items.filter(isSelectable);
    }

    /** Checkbox state of a set of items. */
    function groupState(items, selection) {
      const selectable = selectableOf(items);
      if (selectable.length === 0) return { checked: false, indeterminate: false, selected: 0, selectable: 0 };
      const selected = selectable.filter((item) => selection.has(keyOf(item))).length;
      return { checked: selected === selectable.length, indeterminate: selected > 0 && selected < selectable.length, selected, selectable: selectable.length };
    }

    /** One type group inside a source card. */
    function TypeGroup({ group, tr, home, selection, busy, open, onToggleOpen, onToggleGroup, onToggleItem, onPreview, onShowInstruction, overwriteSecrets, onToggleOverwrite }) {
      const state = groupState(group.items, selection);
      const isSecrets = group.type === 'secrets';
      return h(
        'div',
        { className: 'dshAssetsImport_group' },
        h(
          'div',
          { className: 'dshAssetsImport_groupHead', onClick: onToggleOpen },
          h(Caret, { open }),
          h(
            'span',
            { className: 'dshAssetsImport_checkWrap' },
            h(TriCheckbox, {
              checked: state.checked,
              indeterminate: state.indeterminate,
              disabled: state.selectable === 0 || busy,
              title: tr('badge.selectable', { n: state.selectable }),
              onChange: (next) => onToggleGroup(group, next),
            }),
          ),
          h('span', { className: 'dshAssetsImport_groupName' }, group.label),
          h('span', { className: 'dshAssetsImport_count' }, tr('group.count', { n: group.items.length })),
          state.selectable > 0 ? h('span', { className: 'dshAssetsImport_tag' }, tr('badge.selectable', { n: state.selectable })) : null,
          h('span', { className: 'dshAssetsImport_spacer' }),
          isSecrets
            ? h(
                'label',
                { className: 'dshAssetsImport_chip', 'data-on': overwriteSecrets ? '1' : '0', title: tr('secrets.overwriteHint'), onClick: (event) => event.stopPropagation() },
                h('input', {
                  type: 'checkbox',
                  className: 'dshAssetsImport_check',
                  checked: overwriteSecrets === true,
                  disabled: busy,
                  onChange: (event) => {
                    event.stopPropagation();
                    onToggleOverwrite(event.target.checked);
                  },
                }),
                tr('secrets.overwrite'),
              )
            : null,
          group.type === 'skills' && group.counts.available > 0 ? h(StatusBadge, { status: 'available', tr }) : null,
          group.counts.exists > 0 ? h(StatusBadge, { status: 'exists', tr }) : null,
          group.counts.update > 0 ? h(StatusBadge, { status: 'update', tr }) : null,
          group.counts.set > 0 ? h(StatusBadge, { status: 'set', tr, type: 'secrets' }) : null,
          group.counts.conflict > 0 ? h(StatusBadge, { status: 'conflict', tr, type: 'secrets' }) : null,
          group.counts.new > 0 ? h(StatusBadge, { status: 'new', tr, type: group.type }) : null,
        ),
        open
          ? h(
              'div',
              null,
              isSecrets ? h('div', { className: 'dshAssetsImport_groupNote' }, tr('secrets.note')) : null,
              group.items.map((item) =>
                h(ItemRow, {
                  key: item.id,
                  item,
                  tr,
                  home,
                  selected: selection.has(keyOf(item)),
                  busy,
                  onToggle: onToggleItem,
                  onPreview,
                  onShowInstruction,
                }),
              ),
            )
          : null,
      );
    }

    /** One source card with its type groups. */
    function SourceCard({ source, tr, home, selection, busy, open, onToggleOpen, onToggleSource, typeOpen, onToggleType, onToggleGroup, onToggleItem, onPreview, onShowInstruction, overwriteSecrets, onToggleOverwrite }) {
      const items = source.types.flatMap((group) => group.items);
      const state = groupState(items, selection);
      return h(
        'div',
        { className: 'dshAssetsImport_card', 'data-source': source.id },
        h(
          'div',
          { className: 'dshAssetsImport_srcHead', onClick: onToggleOpen },
          h(Caret, { open }),
          h(
            'span',
            { className: 'dshAssetsImport_checkWrap' },
            h(TriCheckbox, {
              checked: state.checked,
              indeterminate: state.indeterminate,
              disabled: state.selectable === 0 || busy,
              title: tr('badge.selectable', { n: state.selectable }),
              onChange: (next) => onToggleSource(source, next),
            }),
          ),
          h(AssetsIcon, { size: 14 }),
          h('span', { className: 'dshAssetsImport_srcName', title: source.label }, source.label),
          h('span', { className: 'dshAssetsImport_count' }, tr('group.count', { n: source.counts.total })),
          state.selectable > 0 ? h('span', { className: 'dshAssetsImport_tag' }, tr('badge.selectable', { n: state.selectable })) : null,
          h('span', { className: 'dshAssetsImport_spacer' }),
          source.types.map((group) => h('span', { key: group.type, className: 'dshAssetsImport_count' }, `${TYPE_SHORT[group.type] ?? group.type}: ${group.items.length}`)),
        ),
        open
          ? h(
              'div',
              null,
              source.types.map((group) =>
                h(TypeGroup, {
                  key: `${source.id}:${group.type}`,
                  group,
                  tr,
                  home,
                  selection,
                  busy,
                  open: typeOpen[`${source.id}:${group.type}`] !== false,
                  onToggleOpen: () => onToggleType(`${source.id}:${group.type}`),
                  onToggleGroup,
                  onToggleItem,
                  onPreview,
                  onShowInstruction,
                  overwriteSecrets,
                  onToggleOverwrite,
                }),
              ),
            )
          : null,
      );
    }

    /** The selection bar with the three required buttons. */
    function ActionBar({ tr, state }) {
      const count = state.selection.size;
      const busy = state.progress !== null;
      const secretCount = state.selectedSecrets.length;
      return h(
        'div',
        { className: 'dshAssetsImport_bar' },
        h(
          'span',
          { className: 'dshAssetsImport_barText' },
          count === 0 ? tr('selection.hint') : `${tr('selection.summary', { n: count })}${secretCount > 0 ? ` · ${tr('secrets.title')}: ${secretCount}` : ''}`,
        ),
        busy ? h('span', { className: 'dshAssetsImport_barText' }, tr('progress.running', { done: state.progress.done, total: state.progress.total })) : null,
        h('span', { className: 'dshAssetsImport_spacer' }),
        h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall', type: 'button', disabled: busy || state.selectableTotal === 0, onClick: state.selectAll }, tr('action.selectAll')),
        h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall', type: 'button', disabled: busy || count === 0, onClick: state.clearAll }, tr('action.clearAll')),
        h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall', type: 'button', disabled: busy || count === 0, onClick: () => void state.loadPreview() }, tr('action.preview')),
        h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall dshAssetsImport_btnPrimary', type: 'button', disabled: busy || count === 0, onClick: () => void state.run() }, tr('action.import', { n: count })),
      );
    }

    /**
     * Confirmation before writing to the user's environment.
     *
     * Nothing is written until this is answered: the environment is the owner's
     * machine-wide state, not a file this plugin may create silently.
     */
    function ConfirmEnv({ tr, state }) {
      const pending = state.pendingConfirm;
      if (pending === null) return null;
      const overwriteCount = pending.overwriteCount ?? 0;
      return h(
        'div',
        { className: 'dshAssetsImport_confirm', 'data-confirm': 'environment' },
        h('div', { className: 'dshAssetsImport_confirmTitle' }, tr('secrets.confirmTitle')),
        h(
          'div',
          { className: 'dshAssetsImport_confirmText' },
          tr('secrets.confirmText', { n: pending.secrets, overwrite: overwriteCount > 0 ? tr('secrets.confirmOverwrite', { n: overwriteCount }) : '' }),
        ),
        h(
          'div',
          { className: 'dshAssetsImport_toolbar' },
          h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall dshAssetsImport_btnPrimary', type: 'button', onClick: () => void state.confirmRun() }, tr('secrets.confirmOk')),
          h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall', type: 'button', onClick: state.cancelConfirm }, tr('secrets.confirmCancel')),
        ),
      );
    }

    /** The progress bar. */
    function Progress({ progress }) {
      if (progress === null) return null;
      const ratio = progress.total === 0 ? 0 : Math.min(1, progress.done / progress.total);
      return h('div', { className: 'dshAssetsImport_progress' }, h('div', { className: 'dshAssetsImport_progressFill', style: { width: `${Math.round(ratio * 100)}%` } }));
    }

    /** Destination paths of the import. */
    function Targets({ tr, targets }) {
      if (targets === undefined || targets === null) return null;
      return h(
        'div',
        { className: 'dshAssetsImport_targets' },
        h('span', null, tr('targets.title')),
        h('span', { className: 'dshAssetsImport_linkish' }, tr('targets.skills', { path: targets.skills })),
        h('span', { className: 'dshAssetsImport_linkish' }, tr('targets.patch', { path: targets.profilePatch })),
        h('span', { className: 'dshAssetsImport_linkish' }, tr('targets.instructions', { path: targets.instructions })),
        h('span', { className: 'dshAssetsImport_linkish' }, tr('targets.environment', { path: targets.environment, n: targets.userEnvCount ?? 0 })),
        h('span', null, tr('targets.shared')),
      );
    }

    /** The import report: one line per item plus the MCP writeback. */
    function Report({ tr, report }) {
      if (report === null) return null;
      const summary = report.summary ?? {};
      const writeback = report.writeback;
      return h(
        'div',
        { className: 'dshAssetsImport_report' },
        h(
          'div',
          { className: 'dshAssetsImport_reportHead' },
          h('span', null, summary.dryRun === true ? tr('report.dryRun') : tr('report.title')),
          h('span', { className: 'dshAssetsImport_spacer' }),
          h('span', { className: 'dshAssetsImport_count' }, tr('report.summary', { copied: summary.copied ?? 0, updated: summary.updated ?? 0, added: summary.added ?? 0, skipped: summary.skipped ?? 0, failed: summary.failed ?? 0 })),
        ),
        (report.items ?? []).map((item, index) =>
          h(
            'div',
            { className: 'dshAssetsImport_reportRow', key: `${item.id ?? index}:${index}` },
            h(
              'span',
              { className: 'dshAssetsImport_reportAction', 'data-ok': item.action === 'copied' || item.action === 'updated' || item.action === 'added' ? '1' : '0', 'data-bad': item.action === 'failed' ? '1' : '0' },
              item.action,
            ),
            h('span', { className: 'dshAssetsImport_rowName' }, `${item.type ?? ''}/${item.name ?? ''}`),
            item.target !== undefined && item.target !== '' ? h('span', { className: 'dshAssetsImport_target', title: item.target }, item.target) : null,
            item.reason !== undefined && item.reason !== '' ? h('span', { className: 'dshAssetsImport_rowSub', title: item.reason }, item.reason) : null,
          ),
        ),
        writeback !== null && writeback !== undefined
          ? h(
              'div',
              { className: 'dshAssetsImport_reportRow', style: { flexDirection: 'column', alignItems: 'flex-start', gap: '2px' } },
              h('span', null, tr('report.mcpWrite', { path: writeback.path })),
              h('span', null, writeback.backupPath === '' || writeback.backupPath === undefined ? tr('report.mcpNoBackup') : tr('report.mcpBackup', { path: writeback.backupPath })),
              writeback.fragment !== '' && summary.dryRun !== true ? h('pre', { className: 'dshAssetsImport_pre' }, writeback.fragment) : null,
            )
          : null,
        report.environment !== null && report.environment !== undefined
          ? h(
              'div',
              { className: 'dshAssetsImport_reportRow', style: { flexDirection: 'column', alignItems: 'flex-start', gap: '2px' } },
              h('span', { className: 'dshAssetsImport_reportHead', style: { background: 'transparent', padding: '0' } }, tr('report.envTitle')),
              h('span', null, tr('report.envWritten', { n: report.environment.written?.length ?? 0 }), report.environment.failed?.length > 0 ? ` · ${tr('report.envFailed', { n: report.environment.failed.length })}` : ''),
              h('span', null, tr('report.envPayload', { state: report.environment.payloadDeleted === true ? 'да' : 'НЕТ' })),
              h('span', null, tr('report.envAcl', { state: report.environment.acl?.applied === true ? 'только пользователь' : 'НЕ применён' })),
              h('span', null, tr('report.envVerified', { state: report.environment.verified === true ? 'ок' : 'НЕ пройдена' })),
              report.environment.error !== '' && report.environment.error !== undefined ? h('span', { className: 'dshAssetsImport_rowSub' }, report.environment.error) : null,
              h('span', { className: 'dshAssetsImport_rowSub' }, tr('report.envRestart')),
            )
          : null,
        summary.dryRun !== true && (summary.added ?? 0) > 0 ? h('div', { className: 'dshAssetsImport_warn', style: { margin: '8px' } }, tr('report.restart')) : null,
      );
    }

    /** YAML preview of the selection. */
    function PreviewPanel({ tr, preview, onClose }) {
      if (preview === null) return null;
      return h(
        'div',
        { className: 'dshAssetsImport_report' },
        h(
          'div',
          { className: 'dshAssetsImport_reportHead' },
          h('span', null, tr('preview.title')),
          h('span', { className: 'dshAssetsImport_spacer' }),
          h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall', type: 'button', onClick: onClose }, tr('action.hide')),
        ),
        h(
          'div',
          { style: { padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          preview.changesProfile === true ? h('div', { className: 'dshAssetsImport_warn' }, tr('preview.warnProfile')) : null,
          preview.changesEnvironment === true
            ? h(
                'div',
                { className: 'dshAssetsImport_warn' },
                tr('preview.warnEnv', { n: preview.environment?.variables?.length ?? 0 }),
                (preview.environment?.variables ?? []).slice(0, 20).map((entry) =>
                  h('div', { key: entry.name, className: 'dshAssetsImport_rowSub' }, `${entry.name} · ${tr('secrets.length', { n: entry.valueLength })} · ${entry.origin}`),
                ),
              )
            : null,
          preview.changesProfile !== true && preview.changesEnvironment !== true ? h('div', { className: 'dshAssetsImport_notice' }, tr('preview.noProfile')) : null,
          (preview.warnings ?? []).map((warning) => h('div', { className: 'dshAssetsImport_warn', key: warning }, warning)),
          preview.yaml !== '' && preview.yaml !== undefined
            ? h('div', null, h('div', { className: 'dshAssetsImport_count', style: { marginBottom: '4px' } }, tr('preview.yaml')), h('pre', { className: 'dshAssetsImport_pre' }, preview.yaml))
            : null,
          (preview.previews ?? []).map((entry) =>
            h(
              'div',
              { className: 'dshAssetsImport_reportRow', key: entry.id },
              h('span', { className: 'dshAssetsImport_reportAction' }, entry.action),
              h('span', { className: 'dshAssetsImport_rowName' }, entry.id),
              entry.reason !== undefined && entry.reason !== '' ? h('span', { className: 'dshAssetsImport_rowSub' }, entry.reason) : null,
            ),
          ),
        ),
      );
    }

    /** The tree body shared by the page and the dock tab. */
    function TreeBody({ tr, state, home }) {
      if (state.tree === null) {
        return state.loading ? h('div', { className: 'dshAssetsImport_empty' }, tr('state.loading')) : null;
      }
      const sources = state.visibleSources;
      if (sources.length === 0) return h('div', { className: 'dshAssetsImport_empty' }, tr('state.empty'));
      return h(
        'div',
        { className: 'dshAssetsImport_grid' },
        sources.map((source, index) =>
          h(SourceCard, {
            key: source.id,
            source,
            tr,
            home,
            selection: state.selection,
            busy: state.progress !== null,
            open: state.sourceOpen[source.id] !== undefined ? state.sourceOpen[source.id] : index < OPEN_SOURCES,
            onToggleOpen: () => state.toggleSourceOpen(source.id),
            onToggleSource: state.toggleSource,
            typeOpen: state.typeOpen,
            onToggleType: state.toggleTypeOpen,
            onToggleGroup: state.toggleGroup,
            onToggleItem: state.toggleItem,
            onPreview: (item) => void state.loadPreview([item]),
            onShowInstruction: (item) => void state.showInstruction(item),
            overwriteSecrets: state.overwriteSecrets,
            onToggleOverwrite: state.toggleOverwrite,
          }),
        ),
      );
    }

    /** The whole page. */
    function AssetsPage(props) {
      const tr = makeTranslator(props?.t);
      const state = useAssets(tr);
      const tree = state.tree;
      return h(
        'div',
        { className: 'dshAssetsImport_page', 'data-assets-import': 'page' },
        h(
          'div',
          { className: 'dshAssetsImport_head' },
          props?.embedded === true
            ? null
            : h(
                'div',
                null,
                h('div', { className: 'dshAssetsImport_title' }, tr('panel.title')),
                h('div', { className: 'dshAssetsImport_sub' }, tr('panel.subtitle')),
              ),
          h('span', { className: 'dshAssetsImport_spacer' }),
          tree === null ? null : h('span', { className: 'dshAssetsImport_pill' }, tr('stats', tree.totals)),
          h(RefreshControl, {
            loading: state.loading,
            disabled: state.progress !== null,
            label: tr('action.refresh'),
            busyLabel: tr('refresh.busy'),
            updatedLabel: state.lastUpdated === 0 ? tr('updated.never') : tr('updated.at', { time: formatTime(state.lastUpdated) }),
            onRefresh: () => void state.reload(true),
          }),
        ),
        h(
          'div',
          { className: 'dshAssetsImport_toolbar' },
          h('input', {
            className: 'dshAssetsImport_input',
            type: 'search',
            placeholder: tr('search.placeholder'),
            value: state.query,
            onChange: (event) => state.setQuery(event.target.value),
          }),
        ),
        tree === null ? null : h('span', { className: 'dshAssetsImport_count' }, tr('stats.types', tree.totals.byType)),
        h(ActionBar, { tr, state }),
        h(Progress, { progress: state.progress }),
        h(ConfirmEnv, { tr, state }),
        state.notice.text === ''
          ? null
          : h('div', { className: state.notice.error ? 'dshAssetsImport_notice dshAssetsImport_noticeError' : 'dshAssetsImport_notice' }, state.notice.text),
        state.instruction === null
          ? null
          : h(
              'div',
              { className: 'dshAssetsImport_report' },
              h(
                'div',
                { className: 'dshAssetsImport_reportHead' },
                h('span', null, state.instruction.label),
                h('span', { className: 'dshAssetsImport_spacer' }),
                h('span', { className: 'dshAssetsImport_count' }, state.instruction.note),
                h('button', { className: 'dshAssetsImport_btn dshAssetsImport_btnSmall', type: 'button', onClick: state.closeInstruction }, tr('action.hide')),
              ),
              h('pre', { className: 'dshAssetsImport_pre' }, state.instruction.content),
            ),
        h(Targets, { tr, targets: tree?.targets }),
        h(TreeBody, { tr, state, home: state.home }),
        h(PreviewPanel, { tr, preview: state.preview, onClose: state.closePreview }),
        h(Report, { tr, report: state.report }),
      );
    }

    /** The right-dock tab: the same tree in a narrow column. */
    function AssetsTab(props) {
      const tr = makeTranslator(props?.t);
      const state = useAssets(tr);
      return h(
        'div',
        { className: 'dshAssetsImport_pane', 'data-assets-import': 'tab' },
        h(
          'div',
          { className: 'dshAssetsImport_toolbar' },
          h('span', { className: 'dshAssetsImport_srcName' }, tr('panel.label')),
          h('span', { className: 'dshAssetsImport_spacer' }),
          h(RefreshControl, {
            compact: true,
            loading: state.loading,
            disabled: state.progress !== null,
            label: tr('action.refresh'),
            busyLabel: tr('refresh.busy'),
            updatedLabel: state.lastUpdated === 0 ? tr('updated.never') : tr('updated.at', { time: formatTime(state.lastUpdated) }),
            onRefresh: () => void state.reload(true),
          }),
        ),
        h('input', {
          className: 'dshAssetsImport_input',
          type: 'search',
          placeholder: tr('search.placeholder'),
          value: state.query,
          onChange: (event) => state.setQuery(event.target.value),
        }),
        h(ActionBar, { tr, state }),
        h(Progress, { progress: state.progress }),
        h(ConfirmEnv, { tr, state }),
        state.notice.text === '' ? null : h('div', { className: state.notice.error ? 'dshAssetsImport_notice dshAssetsImport_noticeError' : 'dshAssetsImport_notice' }, state.notice.text),
        h(TreeBody, { tr, state, home: state.home }),
        h(PreviewPanel, { tr, preview: state.preview, onClose: state.closePreview }),
        h(Report, { tr, report: state.report }),
      );
    }

    /** Conversation header button: the fastest way into the page. */
    function HeaderButton(props) {
      const tr = makeTranslator(props?.t);
      return h(
        'button',
        {
          className: 'dshAssetsImport_iconBtn',
          type: 'button',
          title: tr('panel.title'),
          onClick: () => {
            const select = runtime.selectPanel;
            if (typeof select === 'function') select(PANEL_ID);
            else console.warn('[assets-import] layout.selectPanel is unavailable in this build');
          },
        },
        h(AssetsIcon, { size: 14 }),
        h('span', null, tr('header.button')),
      );
    }

    /**
     * The tree, the selection model and the import actions.
     *
     * Selection is a set of printable keys (`type:source:name`); the Host resolves
     * those keys against a fresh scan, so the page never sends a path.
     */
    function useAssets(tr) {
      const [tree, setTree] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      /** When the tree on screen was received; the stamp next to Refresh shows it. */
      const [lastUpdated, setLastUpdated] = React.useState(0);
      /** Translator in a ref: a fresh function per render must not re-trigger the loader. */
      const trRef = React.useRef(tr);
      trRef.current = tr;
      const [query, setQuery] = React.useState('');
      const [selection, setSelection] = React.useState(() => new Set());
      const [sourceOpen, setSourceOpen] = React.useState({});
      const [typeOpen, setTypeOpen] = React.useState({});
      const [progress, setProgress] = React.useState(null);
      const [report, setReport] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [instruction, setInstruction] = React.useState(null);
      const [notice, setNotice] = React.useState({ text: '', error: false });
      const [home, setHome] = React.useState('');
      /** Whether already-set secrets may be overwritten (the tree computes statuses from it). */
      const [overwriteSecrets, setOverwriteSecrets] = React.useState(false);
      /** The unanswered environment confirmation, if any. */
      const [pendingConfirm, setPendingConfirm] = React.useState(null);

      const load = React.useCallback(
        async (fresh) => {
          setLoading(true);
          try {
            const params = new URLSearchParams();
            if (fresh === true) params.set('fresh', '1');
            if (overwriteSecrets === true) params.set('overwriteSecrets', '1');
            const suffix = params.toString();
            const answer = await readJson(ROUTES.tree + (suffix === '' ? '' : '?' + suffix));
            setTree(answer);
            setLastUpdated(Date.now());
            setSelection((current) => {
              // Keep a selection only for rows that are still importable.
              const selectable = new Set();
              for (const source of answer.sources ?? []) {
                for (const group of source.types) for (const item of group.items) if (isSelectable(item)) selectable.add(keyOf(item));
              }
              const next = new Set();
              for (const key of current) if (selectable.has(key)) next.add(key);
              return next;
            });
            const skills = answer.targets?.skills ?? '';
            const at = String(skills).toLowerCase().lastIndexOf('\\');
            if (at > 0) setHome(String(skills).slice(0, at));
          } catch (error) {
            setNotice({ text: trRef.current('notice.failed', { reason: error?.message ?? String(error) }), error: true });
          } finally {
            setLoading(false);
          }
        },
        [overwriteSecrets],
      );

      React.useEffect(() => {
        void load(false);
      }, [load]);

      /** Every importable item, flattened. */
      const allItems = React.useMemo(() => {
        const items = [];
        for (const source of tree?.sources ?? []) for (const group of source.types) for (const item of group.items) if (isSelectable(item)) items.push(item);
        return items;
      }, [tree]);

      /** Sources filtered by the search box. */
      const visibleSources = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle === '') return tree?.sources ?? [];
        const matched = [];
        for (const source of tree?.sources ?? []) {
          const types = [];
          for (const group of source.types) {
            const items = group.items.filter((item) => {
              const haystack = `${item.name} ${item.path ?? ''} ${item.description ?? ''} ${item.target ?? ''}`.toLowerCase();
              return haystack.includes(needle);
            });
            if (items.length > 0) types.push({ ...group, items });
          }
          if (types.length > 0) matched.push({ ...source, types });
          else if (source.label.toLowerCase().includes(needle)) matched.push(source);
        }
        return matched;
      }, [tree, query]);

      const toggleItem = React.useCallback((item) => {
        const key = keyOf(item);
        setSelection((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else if (isSelectable(item)) next.add(key);
          return next;
        });
      }, []);

      const toggleItems = React.useCallback((items, next) => {
        const keys = items.filter(isSelectable).map(keyOf);
        setSelection((current) => {
          const result = new Set(current);
          for (const key of keys) {
            if (next === true) result.add(key);
            else result.delete(key);
          }
          return result;
        });
      }, []);

      const toggleSource = React.useCallback(
        (source, next) => {
          toggleItems(source.types.flatMap((group) => group.items), next);
        },
        [toggleItems],
      );

      const toggleGroup = React.useCallback((group, next) => toggleItems(group.items, next), [toggleItems]);

      const selectAll = React.useCallback(() => setSelection(new Set(allItems.map(keyOf))), [allItems]);
      const clearAll = React.useCallback(() => setSelection(new Set()), []);

      const toggleSourceOpen = React.useCallback((id) => {
        setSourceOpen((current) => ({ ...current, [id]: current[id] === true ? false : true }));
      }, []);
      const toggleTypeOpen = React.useCallback((id) => {
        setTypeOpen((current) => ({ ...current, [id]: current[id] === false ? true : false }));
      }, []);

      const closePreview = React.useCallback(() => setPreview(null), []);
      const closeInstruction = React.useCallback(() => setInstruction(null), []);

      /** Resolve the selected rows back into request payloads. */
      const selectedItems = React.useCallback(() => allItems.filter((item) => selection.has(keyOf(item))), [allItems, selection]);

      /** The selected secret rows (the confirmation and the report treat them apart). */
      const selectedSecrets = allItems.filter((item) => item.type === 'secrets' && selection.has(keyOf(item)));

      /** Turn the overwrite flag on or off: the Host recomputes secret statuses. */
      const toggleOverwrite = React.useCallback(
        (next) => {
          setOverwriteSecrets(next === true);
          setSelection((current) => {
            if (next === true) return current;
            // Dropping the flag drops the selections it made legal.
            const result = new Set();
            for (const key of current) {
              const item = allItems.find((candidate) => keyOf(candidate) === key);
              if (item !== undefined && item.type === 'secrets' && item.status === 'set') continue;
              result.add(key);
            }
            return result;
          });
        },
        [allItems],
      );

      /** Ask the Host what the selection would do (MCP: the exact YAML fragment). */
      const loadPreview = React.useCallback(
        async (explicit) => {
          const items = Array.isArray(explicit) ? explicit : selectedItems();
          if (items.length === 0) {
            setNotice({ text: tr('notice.nothingSelected'), error: false });
            return;
          }
          try {
            const answer = await readJson(ROUTES.preview, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({
                items: items.map((item) => ({ type: item.type, source: item.source, name: item.name })),
                overwriteSecrets,
              }),
            });
            setPreview(answer);
          } catch (error) {
            setNotice({ text: tr('notice.failed', { reason: error?.message ?? String(error) }), error: true });
          }
        },
        [overwriteSecrets, selectedItems, tr],
      );

      /** Show one instruction document, masked by the Host. */
      const showInstruction = React.useCallback(
        async (item) => {
          const hostId = typeof item.hostId === 'string' && item.hostId !== '' ? item.hostId : item.id.split(':').slice(1).join(':');
          try {
            const answer = await readJson(`${ROUTES.instruction}?id=${encodeURIComponent(hostId)}`);
            if (answer.ok !== true) throw new Error(answer.error ?? 'документ не читается');
            setInstruction({ label: answer.label, note: answer.note, content: answer.content });
          } catch (error) {
            setNotice({ text: tr('notice.failed', { reason: error?.message ?? String(error) }), error: true });
          }
        },
        [tr],
      );

      /** Run the import: skills/instructions in small batches, MCP and secrets in one call each. */
      const run = React.useCallback(
        async (payload) => {
          const items = Array.isArray(payload) ? payload : selectedItems();
          if (items.length === 0) {
            setNotice({ text: tr('notice.nothingSelected'), error: false });
            return;
          }
          const secretItems = items.filter((item) => item.type === 'secrets');
          // Anything that touches the Windows environment asks first.
          if (secretItems.length > 0 && pendingConfirm === null) {
            setPendingConfirm({
              items,
              secrets: secretItems.length,
              overwriteCount: secretItems.filter((item) => item.status === 'set').length,
            });
            return;
          }
          setPendingConfirm(null);
          const mcpItems = items.filter((item) => item.type === 'mcp');
          const rest = items.filter((item) => item.type !== 'mcp' && item.type !== 'secrets');
          const chunks = [];
          for (let index = 0; index < rest.length; index += BATCH_SIZE) chunks.push(rest.slice(index, index + BATCH_SIZE));
          if (secretItems.length > 0) chunks.push(secretItems);
          if (mcpItems.length > 0) chunks.push(mcpItems);
          const total = items.length;
          let done = 0;
          const collected = [];
          let summary = { requested: 0, copied: 0, updated: 0, added: 0, secrets: 0, skipped: 0, failed: 0, dryRun: false };
          let writeback = null;
          let environment = null;
          setProgress({ done: 0, total });
          setReport(null);
          setPreview(null);
          setNotice({ text: '', error: false });
          for (const chunk of chunks) {
            try {
              const answer = await readJson(ROUTES.run, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify({
                  items: chunk.map((item) => ({ type: item.type, source: item.source, name: item.name })),
                  overwriteSecrets,
                }),
              });
              collected.push(...(answer.items ?? []));
              summary = {
                requested: summary.requested + (answer.summary.requested ?? 0),
                copied: summary.copied + (answer.summary.copied ?? 0),
                updated: summary.updated + (answer.summary.updated ?? 0),
                added: summary.added + (answer.summary.added ?? 0),
                secrets: summary.secrets + (answer.summary.secrets ?? 0),
                skipped: summary.skipped + (answer.summary.skipped ?? 0),
                failed: summary.failed + (answer.summary.failed ?? 0),
                dryRun: false,
              };
              if (answer.writeback !== null && answer.writeback !== undefined) writeback = answer.writeback;
              if (answer.environment !== null && answer.environment !== undefined) environment = answer.environment;
            } catch (error) {
              summary.failed += chunk.length;
              collected.push(...chunk.map((item) => ({ id: keyOf(item), type: item.type, name: item.name, action: 'failed', reason: error?.message ?? String(error) })));
            }
            done += chunk.length;
            setProgress({ done, total });
          }
          setProgress(null);
          setReport({ summary, items: collected, writeback, environment });
          await load(true);
        },
        [load, overwriteSecrets, pendingConfirm, selectedItems, tr],
      );

      const confirmRun = React.useCallback(() => {
        const pending = pendingConfirm;
        if (pending === null) return;
        void run(pending.items);
      }, [pendingConfirm, run]);

      const cancelConfirm = React.useCallback(() => setPendingConfirm(null), []);

      return {
        tree,
        loading,
        lastUpdated,
        query,
        setQuery,
        selection,
        sourceOpen,
        typeOpen,
        progress,
        report,
        preview,
        instruction,
        notice,
        home,
        visibleSources,
        selectableTotal: allItems.length,
        selectedSecrets,
        overwriteSecrets,
        toggleOverwrite,
        pendingConfirm,
        confirmRun,
        cancelConfirm,
        toggleItem,
        toggleSource,
        toggleGroup,
        toggleSourceOpen,
        toggleTypeOpen,
        selectAll,
        clearAll,
        closePreview,
        closeInstruction,
        loadPreview,
        showInstruction,
        run,
        reload: load,
      };
    }


    return { NS, DICTIONARIES, CSS, Page: AssetsPage, Tab: AssetsTab, runtime };

    })();

    /* ---------------------------------------------------------------- shell */

    /** The tab body of the active tab, with the layer's own copy namespace bound. */
    function tabBody(tab) {
      const bound = tab === 'assets' ? runtime.bindAssets : runtime.bindSessions;
      const translator = typeof bound === 'function' ? bound() : undefined;
      return tab === 'assets' ? h(assetsUI.Page, { t: translator, embedded: true }) : h(sessionsUI.Page, { t: translator, embedded: true });
    }

    /** The full page: title, the tab switcher and the active tab. */
    function MigratePage(props) {
      const tr = shellTranslator(props?.t);
      const [tab, selectTab] = useActiveTab();
      return h(
        'div',
        { className: 'dshMigrate_page', 'data-dsh-migrate': 'page' },
        h(
          'div',
          { className: 'dshMigrate_head' },
          h('div', null, h('div', { className: 'dshMigrate_title' }, tr('panel.title')), h('div', { className: 'dshMigrate_sub' }, tr('panel.subtitle'))),
          h('span', { className: 'dshMigrate_spacer' }),
          h(TabBar, { tr, tab, onSelect: selectTab }),
        ),
        h('div', { className: 'dshMigrate_body', 'data-active-tab': tab }, tabBody(tab)),
      );
    }

    /** The right-dock tab: the tab switcher and the active tab in a narrow column. */
    function MigrateTab(props) {
      const tr = shellTranslator(props?.t);
      const [tab, selectTab] = useActiveTab();
      return h(
        'div',
        { className: 'dshMigrate_pane', 'data-dsh-migrate': 'tab' },
        h(TabBar, { tr, tab, onSelect: selectTab, compact: true }),
        h('div', { className: 'dshMigrate_body', 'data-active-tab': tab }, tabBody(tab)),
      );
    }

    /** Browser services this half needs: the slot registry and copy. */
    const inject = ['slots', 'locale'];

    /**
     * Install every surface of the plugin.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-migrate';
        tag.textContent = [CSS, sessionsUI.CSS, assetsUI.CSS].join('\n');
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'dsh-migrate: styles');

      ctx.effect(() => {
        const disposers = [
          ctx.locale.register(SHELL_NS, SHELL_DICTIONARIES),
          ctx.locale.register(sessionsUI.NS, sessionsUI.DICTIONARIES),
          ctx.locale.register(assetsUI.NS, assetsUI.DICTIONARIES),
        ];
        return () => {
          for (const dispose of disposers) {
            try {
              if (typeof dispose === 'function') dispose();
            } catch {
              /* dictionaries already gone */
            }
          }
        };
      }, 'dsh-migrate: dictionaries');

      const lookup = (serviceName) => {
        try {
          return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined;
        } catch {
          return undefined;
        }
      };

      /**
       * The panel speaks Russian regardless of the app locale: the owner works in Russian, and a
       * stray `locale: en` in the profile must not switch migration screens to English.
       */
      const binder = (namespace, dictionaries) => () => {
        const dict = dictionaries.ru ?? {};
        const fallback = dictionaries.en ?? {};
        return (key, params) => {
          const template = dict[key] ?? fallback[key] ?? key;
          if (params === undefined || params === null) return template;
          return String(template).replace(/\{(\w+)\}/g, (whole, name) => (
            params[name] === undefined ? whole : String(params[name])
          ));
        };
      };
      const bindShell = binder(SHELL_NS, SHELL_DICTIONARIES);
      runtime.bindSessions = binder(sessionsUI.NS, sessionsUI.DICTIONARIES);
      runtime.bindAssets = binder(assetsUI.NS, assetsUI.DICTIONARIES);

      const openSession = (sessionId) => {
        const workspace = lookup('uiWorkspace');
        if (workspace !== undefined && workspace !== null && typeof workspace.openSession === 'function') {
          workspace.openSession(sessionId);
        }
      };
      runtime.openSession = openSession;
      runtime.selectPanel = (panelId) => {
        const layout = lookup('layout');
        if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
          layout.selectPanel(panelId);
          return;
        }
        console.warn('[dsh-migrate] layout.selectPanel is unavailable; open the panel from the left strip');
      };
      /**
       * Ask the client half to re-read its own session list.
       *
       * The desktop build has no page to reload, so after an import the plugin
       * probes the workspace services for a refresh entry point; when none is
       * published the panel honestly points at the plugin reload (⟳).
       */
      runtime.refreshSessionList = () => {
        const candidates = [lookup('uiWorkspace'), lookup('workspace'), lookup('uiSidebar'), lookup('layout')];
        for (const service of candidates) {
          if (service === undefined || service === null) continue;
          for (const method of ['refreshSessions', 'reloadSessions', 'reloadSessionList', 'refreshSessionList']) {
            if (typeof service[method] === 'function') {
              try {
                service[method]();
                return true;
              } catch (error) {
                console.warn('[dsh-migrate] session list refresh failed:', error);
              }
            }
          }
        }
        return false;
      };

      // Both layers keep their own click-time runtime object; wire them to the shell.
      sessionsUI.runtime.openSession = openSession;
      sessionsUI.runtime.selectPanel = runtime.selectPanel;
      assetsUI.runtime.selectPanel = runtime.selectPanel;

      // The full page, exactly like the shipped plugin manager and schedule pages.
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: SHELL_NS, inject: () => ({ open: () => runtime.selectPanel?.(PANEL_ID) }) }, MigratePage),
      );

      // The panel strip entry: the row the user clicks in the left sidebar.
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: SHELL_NS, label: () => bindShell()('panel.label') }, MigrateIcon),
      );

      // One-click entry from any conversation.
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-migrate-open', order: 45, locale: SHELL_NS }, HeaderButton),
      );

      // The narrow side view, where the build provides the right dock.
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
            scope.effect(
              () => scope.sidebarRightTabs.register({ id: PANEL_ID, kind: PANEL_ID, title: () => bindShell()('panel.label') }),
              'dsh-migrate: dock tab type',
            );
            scope.slots.inject('sidebar.right.pane.tab', () =>
              scope.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID, locale: SHELL_NS }, MigrateTab),
            );
            scope.effect(() => {
              runtime.openDockTab = () => {
                try {
                  scope.sidebarRight.openTab(PANEL_ID);
                } catch (error) {
                  console.warn('[dsh-migrate] dock tab could not open:', error);
                }
              };
              return () => {
                runtime.openDockTab = null;
              };
            }, 'dsh-migrate: dock tab opener');
          });
        } catch (error) {
          console.warn('[dsh-migrate] right dock unavailable:', error);
        }
      }
    }

    return { inject, apply };
  },
});
