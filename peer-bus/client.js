/**
 * Peer Bus — browser half.
 *
 * One board (`GET /peer-bus/board`, contract v2) feeds four surfaces, none of
 * which assumes a package-private service, so the UI keeps working across a
 * Host restart: the board is read over the same-origin route and the last good
 * reading stays on screen.
 *
 *  - a crown in a Session row's 16px leading cell when that session holds the
 *    master role and the row is idle (that cell belongs to the row's own status
 *    dot while it runs), repeated as a line on the row's hover card;
 *  - a crown marker in the row's action strip for a *running* master, the one
 *    case the leading cell cannot draw;
 *  - "Сделать мастером" in the row's "…" menu for every row that is not the
 *    master: `POST /peer-bus/master` and the board is re-read;
 *  - "Доска сессий" in the Session header's utility strip, the way the board is
 *    found: every session shows it, and it opens the right-dock tab;
 *  - the board itself, and only there, as a tab in the right dock
 *    (`sidebarRight.openTab`): counts by state, the colour legend, a project
 *    filter and the spawn tree, where a subagent hangs *under* the session
 *    that created it, indented behind a connector and dimmed. Registered
 *    only when the build provides the tab type registry; without it nothing
 *    of the tab is installed and every other surface is untouched.
 *
 * The board has no second home on purpose: the composer dock used to mirror
 * it over the transcript, which read as transparent text over the chat and
 * as a duplicate of the tab.
 *
 * Clicking a tree node opens that session through the `uiWorkspace` client
 * service (`openSession(target: SessionTarget)`, `SessionTarget = SessionId |
 * SubagentAddress`, so a plain session id is the argument — see
 * dsh-client-ui-workspace/lib/client.js: `uiWorkspace.openSession(sessionId)`).
 *
 * Slot contracts this file relies on (read from the live slot tree and the
 * client slot catalog):
 *  - `sidebar.session.row.leading` / `sidebar.session.row.hover` are `list`
 *    slots whose entries receive `{ sessionId }`;
 *  - `sidebar.workspaces.session.menu.item` is a `list` slot whose entries
 *    receive `{ sessionId, displayTitle }` plus the injected
 *    `useMenuOpenState` hook; each entry renders one `role="menuitem"` button;
 *  - `sidebar.workspaces.session.row.action` is a `list` slot whose entries
 *    receive `{ sessionId, displayTitle }` and render one icon button;
 *  - `conversation.session.header.utilities` is a session-scoped `list` slot
 *    rendered with `{}`; the framework hands the component `sessionId` and the
 *    bound `t`, so nothing has to be injected;
 *  - `sidebar.right.pane.tab` is a keyed `list` slot sewn to a tab type
 *    registered with `ctx.sidebarRightTabs.register({ id, kind, title })`.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-peer-bus',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Copy namespace this bundle owns. */
    const NS = 'peerBusUI';

    /** Board route the Host half registers; same origin as this page. */
    const ROUTE = '/peer-bus/board';

    /** Master appointment route (`POST`, JSON body `{ sessionId }`). */
    const MASTER_ROUTE = '/peer-bus/master';

    /** One board read per this many milliseconds while the page is open. */
    const POLL_MS = 6000;

    /** Tree height ceiling, so a wide fan-out never eats the conversation. */
    const TREE_MAX_HEIGHT = 220;

    /** Claim chips drawn inline on a node before the rest collapse to `+N`. */
    const CLAIM_CHIPS = 3;

    /** Right-dock tab type this bundle contributes. */
    const TAB_ID = '@local/dsh-peer-bus/board';
    const TAB_KIND = 'peerBusBoard';

    /** English wording. */
    const ENGLISH = {
      'mark.master': 'Master session',
      'mark.masterRunning': 'Master session — open the board',
      'hover.master': 'Master session of this workspace',
      'menu.makeMaster': 'Make master',
      'menu.releaseMaster': 'Release master',
      'notice.masterSet': 'Master role assigned',
      'notice.masterCleared': 'Master role released',
      'notice.masterFailed': 'Could not change the master role',
      'dock.title': 'Peer sessions',
      'dock.counts': '{running} running · {idle} idle · {closed} closed',
      'dock.updated': 'updated {time}',
      'dock.refresh': 'Refresh',
      'dock.collapse': 'Collapse the peer tree',
      'dock.expand': 'Expand the peer tree',
      'dock.empty': 'No peer sessions yet',
      'dock.emptyHint': 'Peers of this project appear here as soon as another session runs.',
      'dock.master': 'master',
      'dock.sub': 'subagent',
      'dock.worker': 'worker',
      'dock.dnd': 'do not disturb',
      'dock.claims': 'Claimed resources',
      'dock.claimUntil': 'until {time}',
      'dock.openThreads': 'threads: {count}',
      'dock.cost': 'Cost: {value}',
      'dock.openSession': 'Open session {name}',
      'dock.openBoard': 'Session board',
      'dock.filter': 'Project',
      'dock.filterAll': 'All projects',
      'dock.subagentOf': 'subagent of «{name}»',
      'dock.asks': 'asks: {count}',
      'dock.stateRunning': '{count} working',
      'dock.stateIdle': '{count} idle',
      'dock.stateNeedsYou': '{count} asking you',
      'dock.stateDone': '{count} done',
      'dock.stateError': '{count} failed',
      'dock.stateClosed': '{count} closed',
      'dock.agoNow': 'just now',
      'dock.agoMinutes': '{count} min ago',
      'dock.agoHours': '{count} h ago',
      'dock.agoDays': '{count} d ago',
      'legend.running': 'working',
      'legend.idle': 'idle',
      'legend.needs_you': 'asks you',
      'legend.done': 'done',
      'legend.error': 'failed',
      'legend.closed': 'closed',
      'footer.master': 'Master: {name}',
      'tab.title': 'Session board',
    };

    /** Russian wording — what this owner reads. */
    const RUSSIAN = {
      'mark.master': 'Сессия-мастер',
      'mark.masterRunning': 'Сессия-мастер — открыть доску',
      'hover.master': 'Сессия-мастер этого проекта',
      'menu.makeMaster': 'Сделать мастером',
      'menu.releaseMaster': 'Снять мастера',
      'notice.masterSet': 'Роль мастера назначена',
      'notice.masterCleared': 'Роль мастера снята',
      'notice.masterFailed': 'Не удалось изменить роль мастера',
      'dock.title': 'Сессии проекта',
      'dock.counts': '{running} работает · {idle} ждёт · {closed} закрыто',
      'dock.updated': 'обновлено {time}',
      'dock.refresh': 'Обновить',
      'dock.collapse': 'Свернуть дерево сессий',
      'dock.expand': 'Развернуть дерево сессий',
      'dock.empty': 'Пока нет других сессий',
      'dock.emptyHint': 'Сессии этого проекта появятся здесь, как только запустятся.',
      'dock.master': 'мастер',
      'dock.sub': 'субагент',
      'dock.worker': 'воркер',
      'dock.dnd': 'не беспокоить',
      'dock.claims': 'Захваченные ресурсы',
      'dock.claimUntil': 'до {time}',
      'dock.openThreads': 'тредов: {count}',
      'dock.cost': 'Стоимость: {value}',
      'dock.openSession': 'Открыть сессию {name}',
      'dock.openBoard': 'Доска сессий',
      'dock.filter': 'Проект',
      'dock.filterAll': 'Все проекты',
      'dock.subagentOf': 'субагент сессии «{name}»',
      'dock.asks': 'вопросов: {count}',
      'dock.stateRunning': '{count} работает',
      'dock.stateIdle': '{count} ждёт',
      'dock.stateNeedsYou': '{count} спрашивает',
      'dock.stateDone': '{count} готово',
      'dock.stateError': '{count} с ошибкой',
      'dock.stateClosed': '{count} закрыто',
      'dock.agoNow': 'только что',
      'dock.agoMinutes': '{count} мин назад',
      'dock.agoHours': '{count} ч назад',
      'dock.agoDays': '{count} дн назад',
      'legend.running': 'работает',
      'legend.idle': 'простой',
      'legend.needs_you': 'ждёт вас',
      'legend.done': 'готово',
      'legend.error': 'ошибка',
      'legend.closed': 'закрыта',
      'footer.master': 'Мастер: {name}',
      'tab.title': 'Доска сессий',
    };

    /**
     * One dictionary per locale id. The page reports `ru` for this owner and
     * falls back to `en` elsewhere; both carry the same key set, mirrored in
     * this package's `locale/en.json` and `locale/ru.json`.
     */
    const DICTIONARIES = { en: ENGLISH, ru: RUSSIAN };

    /** Host tokens only — no literal colour, so both themes follow the app. */
    const CSS = [
      /* --- sidebar row mark: the 16px leading cell the row reserves --- */
      '.dshPeerBus_mark{display:inline-flex;align-items:center;justify-content:center;',
      'width:16px;height:20px;flex:none;',
      // The appointed master is gold wherever it appears: an outline-only leading cell read as
      // "not really master" next to the gold crown of a running row.
      'color:var(--dsw-alias-state-warn-primary)}',
      '.dshPeerBus_mark svg path{fill:currentColor;stroke:currentColor;stroke-width:1.1;stroke-linejoin:round}',
      '.dshPeerBus_mark svg{width:12px;height:12px;display:block}',

      /* --- sidebar row action strip: the mark a running master needs --- */
      '.dshPeerBus_rowMark{box-sizing:border-box;display:inline-flex;align-items:center;',
      'justify-content:center;flex:none;width:22px;height:22px;padding:0;margin:0;',
      'border:none;background:0 0;border-radius:var(--dsw-radius-sm);cursor:pointer;',
      'color:var(--dsw-alias-brand-primary)}',
      '.dshPeerBus_rowMark:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshPeerBus_rowMark:focus-visible{outline:1px solid var(--dsw-alias-brand-primary)}',
      '.dshPeerBus_rowMark svg{width:12px;height:12px;display:block}',

      /* --- board button in the row action strip: a panel glyph, never a crown --- */
      '.dshPeerBus_rowActions{display:inline-flex;align-items:center;gap:2px;flex:none}',
      '.dshPeerBus_crownInline{box-sizing:border-box;display:inline-flex;align-items:center;',
      'justify-content:center;flex:none;width:18px;height:18px;',
      'color:var(--dsw-alias-state-warn-primary)}',
      '.dshPeerBus_crownInline svg{width:12px;height:12px;display:block;fill:currentColor}',
      '.dshPeerBus_treeCrown{display:inline-flex;align-items:center;justify-content:center;',
      'flex:none;align-self:center;line-height:0;margin:0 1px 0 2px;position:relative;top:1.5px;',
      'color:var(--dsw-alias-state-warn-primary)}',
      '.dshPeerBus_treeCrown svg{width:12px;height:12px;display:block;fill:currentColor}',

      /* --- master indicator in the sidebar footer: always visible, pulses while working --- */
      '.dshPeerBus_footerChip{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;',
      'max-width:100%;min-width:0;margin:0;padding:3px 6px;border:none;background:0 0;',
      'border-radius:var(--dsw-radius-sm);cursor:pointer;font:inherit;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshPeerBus_footerChip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshPeerBus_footerCrown{display:inline-flex;align-items:center;flex:none;line-height:0;',
      'color:var(--dsw-alias-state-warn-primary)}',
      '.dshPeerBus_footerCrown svg{width:12px;height:12px;display:block;fill:currentColor}',
      '.dshPeerBus_footerChip[data-running=true] .dshPeerBus_footerCrown{',
      'animation:dshPeerBusCrownPulse 1.6s ease-in-out infinite}',
      '.dshPeerBus_footerName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:12px;line-height:16px}',
      '@keyframes dshPeerBusCrownPulse{0%,100%{opacity:.55;transform:scale(.94);filter:brightness(1)}',
      '50%{opacity:1;transform:scale(1.12);filter:brightness(1.25)}}',
      '@media (prefers-reduced-motion: reduce){',
      '.dshPeerBus_footerChip[data-running=true] .dshPeerBus_footerCrown{animation:none!important}}',
      '.dshPeerBus_boardMark{box-sizing:border-box;display:inline-flex;align-items:center;',
      'justify-content:center;flex:none;width:22px;height:22px;padding:0;margin:0;border:none;',
      'background:0 0;border-radius:var(--dsw-radius-sm);cursor:pointer;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshPeerBus_boardMark:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshPeerBus_boardMark:focus-visible{outline:1px solid var(--dsw-alias-brand-primary)}',
      '.dshPeerBus_boardMark svg{width:13px;height:13px;display:block}',

      /* --- hover card line --- */
      '.dshPeerBus_hoverLine{display:flex;align-items:center;gap:6px;',
      'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dshPeerBus_hoverLine svg{width:12px;height:12px;flex:none;',
      'color:var(--dsw-alias-brand-primary)}',

      /* --- "…" menu row --- */
      '.dshPeerBus_menuItem{box-sizing:border-box;display:flex;align-items:center;gap:8px;',
      'width:100%;margin:0;padding:6px 10px;border:none;background:0 0;',
      'border-radius:var(--dsw-radius-sm);cursor:pointer;font:inherit;text-align:start;',
      'color:var(--dsw-alias-label-primary)}',
      '.dshPeerBus_menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshPeerBus_menuItem:focus-visible{outline:1px solid var(--dsw-alias-brand-primary)}',
      '.dshPeerBus_menuItem svg{width:12px;height:12px;flex:none;',
      'color:var(--dsw-alias-brand-primary)}',

      '.dshPeerBus_refresh{box-sizing:border-box;flex:none;width:20px;height:20px;padding:0;',
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;',
      'border:none;background:0 0;border-radius:var(--dsw-radius-sm);',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dshPeerBus_refresh:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshPeerBus_refresh svg{width:13px;height:13px}',
      '.dshPeerBus_tree{list-style:none;margin:2px 0 4px;padding:0;overflow:auto;',
      'max-height:' + TREE_MAX_HEIGHT + 'px}',
      '.dshPeerBus_tree[data-grow=true]{flex:1;min-height:0;max-height:none}',
      '.dshPeerBus_branch{list-style:none;margin:0;padding:0 0 0 14px;',
      'border-left:1px solid var(--dsw-alias-border-l2)}',
      '.dshPeerBus_node{padding:5px 0;min-width:0}',
      '.dshPeerBus_node + .dshPeerBus_node{border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.dshPeerBus_nodeHead{display:flex;align-items:baseline;gap:6px;min-width:0;',
      'box-sizing:border-box;width:100%;margin:0 -3px;padding:0 3px;border:none;',
      'background:0 0;border-radius:var(--dsw-radius-xs);text-align:start;',
      'font:inherit;color:inherit;cursor:pointer}',
      '.dshPeerBus_nodeHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshPeerBus_nodeHead:focus-visible{outline:1px solid var(--dsw-alias-brand-primary)}',
      /* --- state dot: blue = working/idle, green = finished/asks you, red = failed --- */
      '.dshPeerBus_dot{flex:none;width:7px;height:7px;border-radius:50%;align-self:center;',
      'background:var(--dsw-alias-label-caption)}',
      '.dshPeerBus_dot[data-state=running]{background:var(--dsw-alias-state-business-primary);',
      'animation:dshPeerBusPulse 1.4s ease-in-out infinite}',
      '.dshPeerBus_dot[data-state=idle]{background:var(--dsw-alias-state-business-primary)}',
      '.dshPeerBus_dot[data-state=needs_you]{background:var(--dsw-alias-state-success-primary);',
      'animation:dshPeerBusRing 1.6s ease-out infinite}',
      '.dshPeerBus_dot[data-state=done]{background:var(--dsw-alias-state-success-primary)}',
      '.dshPeerBus_dot[data-state=error]{background:var(--dsw-alias-state-error-primary,#d9534f)}',
      '.dshPeerBus_dot[data-state=closed]{background:transparent;',
      'box-shadow:inset 0 0 0 1px var(--dsw-alias-label-dimmed)}',
      '@keyframes dshPeerBusPulse{0%,100%{opacity:.45;transform:scale(.82);filter:brightness(1)}',
      '50%{opacity:1;transform:scale(1.18);filter:brightness(1.22)}}',
      '@keyframes dshPeerBusRing{0%{box-shadow:0 0 0 0 var(--dsw-alias-state-success-secondary,#4ed17e)}',
      '70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}',
      '@media (prefers-reduced-motion: reduce){',
      '.dshPeerBus_dot[data-state=running],.dshPeerBus_dot[data-state=needs_you]{animation:none!important}}',
      '.dshPeerBus_name{min-width:0;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;line-height:18px}',
      '.dshPeerBus_name[data-muted=true]{color:var(--dsw-alias-label-tertiary)}',
      '.dshPeerBus_chip{box-sizing:border-box;flex:none;padding:0 4px;',
      'border-radius:var(--dsw-radius-xs);font-size:10px;line-height:14px;',
      'color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l3)}',
      '.dshPeerBus_chip[data-tone=master]{color:var(--dsw-alias-brand-primary);',
      'border-color:var(--dsw-alias-brand-primary)}',
      '.dshPeerBus_chip[data-tone=dnd]{color:var(--dsw-alias-state-warn-primary);',
      'border-color:var(--dsw-alias-state-warn-primary)}',
      '.dshPeerBus_chip[data-tone=claim]{color:var(--dsw-alias-label-secondary)}',
      '.dshPeerBus_chip[data-tone=cost]{color:var(--dsw-alias-label-caption)}',
      '.dshPeerBus_nodeMeta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;',
      'min-width:0;margin:0 0 1px 12px}',
      '.dshPeerBus_intent{margin:0 0 1px 12px;color:var(--dsw-alias-label-tertiary);',
      'font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap}',
      '.dshPeerBus_empty{margin:2px 0 4px 22px;color:var(--dsw-alias-label-tertiary);',
      'line-height:17px}',

      /* --- claimed resources block, above the tree --- */
      '.dshPeerBus_claims{box-sizing:border-box;margin:2px 0 4px;padding:4px 6px;',
      'border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.dshPeerBus_claimsHead{color:var(--dsw-alias-label-tertiary)}',
      '.dshPeerBus_claimRow{display:flex;align-items:baseline;gap:6px;min-width:0}',
      '.dshPeerBus_claimResource{flex:none;color:var(--dsw-alias-label-primary)}',
      '.dshPeerBus_claimHolder{min-width:0;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.dshPeerBus_claimUntil{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary)}',

      /* --- right-dock tab --- */
      '.dshPeerBus_pane{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;',
      'height:100%;min-height:0;padding:8px 10px;overflow:auto;font-size:12px;',
      'color:var(--dsw-alias-label-primary);font-family:inherit}',
      '.dshPeerBus_paneHead{display:flex;align-items:center;gap:8px;min-width:0;',
      'color:var(--dsw-alias-label-tertiary);line-height:20px}',
      '.dshPeerBus_paneTitle{flex:none;color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.dshPeerBus_paneMeta{min-width:0;overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;flex:1}',
      '.dshPeerBus_filterRow{display:flex;align-items:center;gap:6px;min-width:0;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dshPeerBus_filterLabel{flex:none}',
      '.dshPeerBus_filter{box-sizing:border-box;min-width:0;max-width:100%;padding:1px 4px;',
      'border-radius:var(--dsw-radius-xs);border:.5px solid var(--dsw-alias-border-l3);',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);',
      'font:inherit}',

      /* --- solid pane background: the board is its own panel, never over the transcript --- */
      '.dshPeerBus_pane{background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-l1))}',
      '.dshPeerBus_legend{display:flex;align-items:center;gap:10px;flex-wrap:wrap;',
      'color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dshPeerBus_legendItem{display:inline-flex;align-items:center;gap:4px}',
      '.dshPeerBus_legendItem .dshPeerBus_dot{align-self:center}',

      /* --- subagents hang under their session: dimmer, tighter, with a connector --- */
      '.dshPeerBus_branch[data-sub=true]{border-left-style:dashed}',
      '.dshPeerBus_node[data-sub=true] .dshPeerBus_name{font-size:11px;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.dshPeerBus_node[data-sub=true] .dshPeerBus_intent{font-size:10px;line-height:14px}',
    ].join('');

    /* --------------------------------------------------------------- glyphs */

    /** Crown: the "this one is appointed" mark. */
    function Crown() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
        h('path', {
          d: 'M2.4 11.4 1.6 5.2l3.2 2.2L8 3.6l3.2 3.8 3.2-2.2-.8 6.2H2.4Z',
          fill: 'currentColor',
        }),
      );
    }

    /** Reload glyph. */
    function RefreshMark() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.6V6h-3.4',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      );
    }

    /** Panel glyph: "show the whole board in the right dock". */
    function PanelMark() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
        h('rect', {
          x: 2,
          y: 3,
          width: 12,
          height: 10,
          rx: 1.5,
          stroke: 'currentColor',
          'stroke-width': 1.3,
        }),
        h('path', { d: 'M9.6 3.4v9.2', stroke: 'currentColor', 'stroke-width': 1.3 }),
      );
    }

    /* ---------------------------------------------------------------- board */

    /** A node's status, narrowed to the three values this UI draws. */
    function statusOf(node) {
      return node?.status === 'running' || node?.status === 'idle' ? node.status : 'closed';
    }

    /** Every state the Host can report for a node, in the order the legend lists them. */
    const NODE_STATES = ['running', 'idle', 'needs_you', 'done', 'error', 'closed'];

    /**
     * The state a node is drawn in. The Host's `state` is authoritative; a board from an older
     * Host (no `state`) still renders, degraded to the two values that existed then.
     */
    function stateOfNode(node) {
      const raw = node?.state;
      if (typeof raw === 'string' && NODE_STATES.includes(raw)) return raw;
      if (node?.status === 'running') return 'running';
      if (node?.status === 'idle') return 'idle';
      return 'closed';
    }

    /** A node's role, narrowed to the two values the contract names. */
    function roleOf(raw) {
      if (raw.role === 'master' || raw.role === 'worker') return raw.role;
      return raw.master === true ? 'master' : 'worker';
    }

    /**
     * A node's cost, or `null` — the contract allows `cost: null` whenever the
     * Host's cost service is unavailable, and every surface quietly drops it.
     */
    function costOf(raw) {
      if (raw === null || typeof raw !== 'object') return null;
      const total = typeof raw.total === 'number' && Number.isFinite(raw.total) ? raw.total : null;
      if (total === null) return null;
      return { total, currency: typeof raw.currency === 'string' ? raw.currency : '' };
    }

    /** Resource names a node holds, as plain non-empty strings. */
    function claimsOf(raw) {
      const out = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        if (typeof item !== 'string') continue;
        const resource = item.trim();
        if (resource === '' || out.includes(resource)) continue;
        out.push(resource);
      }
      return out;
    }

    /** One entry of the board's project-wide claim list. */
    function boardClaimOf(raw) {
      if (raw === null || typeof raw !== 'object') return null;
      const resource = typeof raw.resource === 'string' ? raw.resource.trim() : '';
      if (resource === '') return null;
      return {
        resource,
        holder: typeof raw.holder === 'string' ? raw.holder : '',
        holderName: typeof raw.holderName === 'string' ? raw.holderName : '',
        since: Number.isFinite(raw.since) ? raw.since : 0,
        expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : 0,
        note: typeof raw.note === 'string' ? raw.note : '',
      };
    }

    /** One entry of the board's thread list — counted, never interpreted. */
    function threadOf(raw) {
      if (raw === null || typeof raw !== 'object') return null;
      const id = typeof raw.id === 'string' ? raw.id : '';
      if (id === '') return null;
      return {
        id,
        subject: typeof raw.subject === 'string' ? raw.subject : '',
        status: typeof raw.status === 'string' ? raw.status : '',
        messages: Number.isFinite(raw.messages) ? raw.messages : 0,
      };
    }

    /**
     * Narrow one Host payload to what these surfaces draw, tolerating a Host
     * mid-restart, a payload shape this half does not know, and a v1 board that
     * carries none of the v2 fields.
     * @param payload - parsed JSON from the board route.
     * @returns the projection; `nodes`, `claims`, `threads`, `projects` are always arrays.
     */
    function normalizeBoard(payload) {
      const source = payload !== null && typeof payload === 'object' ? payload : {};
      const nodes = [];
      const seen = new Set();
      for (const raw of Array.isArray(source.nodes) ? source.nodes : []) {
        if (raw === null || typeof raw !== 'object') continue;
        if (typeof raw.id !== 'string' || raw.id === '' || seen.has(raw.id)) continue;
        seen.add(raw.id);
        nodes.push({
          id: raw.id,
          short: typeof raw.short === 'string' && raw.short !== '' ? raw.short : raw.id.slice(-6),
          name: typeof raw.name === 'string' ? raw.name : '',
          title: typeof raw.title === 'string' ? raw.title : '',
          label: typeof raw.label === 'string' ? raw.label : '',
          status: statusOf(raw),
          state: stateOfNode(raw),
          pendingQuestions: Number.isFinite(raw.pendingQuestions) && raw.pendingQuestions > 0
            ? Math.floor(raw.pendingQuestions)
            : 0,
          role: roleOf(raw),
          master: raw.master === true,
          subagent: raw.subagent === true,
          dnd: raw.dnd === true,
          intent: typeof raw.intent === 'string' ? raw.intent : '',
          last: typeof raw.last === 'string' ? raw.last : '',
          parent: typeof raw.parent === 'string' && raw.parent !== raw.id ? raw.parent : null,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
          project: typeof raw.project === 'string' ? raw.project : '',
          claims: claimsOf(raw.claims),
          openThreads: Number.isFinite(raw.openThreads) && raw.openThreads > 0 ? Math.floor(raw.openThreads) : 0,
          cost: costOf(raw.cost),
          lastActivity: Number.isFinite(raw.lastActivity) ? raw.lastActivity : 0,
        });
      }
      const claims = [];
      for (const raw of Array.isArray(source.claims) ? source.claims : []) {
        const claim = boardClaimOf(raw);
        if (claim !== null) claims.push(claim);
      }
      const threads = [];
      for (const raw of Array.isArray(source.threads) ? source.threads : []) {
        const thread = threadOf(raw);
        if (thread !== null) threads.push(thread);
      }
      const projects = [];
      for (const raw of Array.isArray(source.projects) ? source.projects : []) {
        if (raw === null || typeof raw !== 'object') continue;
        if (typeof raw.root !== 'string' || raw.root === '') continue;
        projects.push({ root: raw.root, master: typeof raw.master === 'string' ? raw.master : null });
      }
      const declared = typeof source.master === 'string' && seen.has(source.master) ? source.master : null;
      return {
        version: Number.isFinite(source.version) ? source.version : 1,
        master: declared,
        project: typeof source.project === 'string' ? source.project : '',
        claims,
        threads,
        projects,
        nodes,
        updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : Date.now(),
      };
    }

    /** An empty board, used before the first successful read. */
    function emptyBoard() {
      return {
        version: 1,
        master: null,
        project: '',
        claims: [],
        threads: [],
        projects: [],
        nodes: [],
        updatedAt: 0,
      };
    }

    /**
     * Whether one session holds its project's master role on this board.
     *
     * The node's own fields decide when the node is present (`master`, `role`,
     * both v2); the v1 top-level `master` and the v2 `projects[].master` are the
     * fallbacks for a node the projection dropped.
     * @param board - normalized board.
     * @param sessionId - the row's session.
     * @returns true when that session is the master.
     */
    function isMasterOf(board, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      const node = board.nodes.find((candidate) => candidate.id === sessionId);
      if (node !== undefined) return node.master || node.role === 'master';
      if (board.master === sessionId) return true;
      return board.projects.some((project) => project.master === sessionId);
    }

    /** The status this board reports for one session, or `null` when it names none. */
    function statusOfSession(board, sessionId) {
      const node = board.nodes.find((candidate) => candidate.id === sessionId);
      return node === undefined ? null : node.status;
    }

    /**
     * Group nodes into the spawn tree.
     *
     * A node whose `parent` names nobody on this board is a root — the ordinary
     * case once the parent session was archived — and a parent that names itself
     * is a root too; a longer cycle, which the Host never writes, still cannot
     * hang the render because each level is emitted once.
     * @param nodes - normalized nodes of one project.
     * @returns roots carrying `children`, each level ordered master, running, idle, name.
     */
    function buildForest(nodes) {
      const entries = new Map();
      for (const node of nodes) entries.set(node.id, { node, children: [] });
      const roots = [];
      for (const node of nodes) {
        const entry = entries.get(node.id);
        const parent = node.parent === null ? undefined : entries.get(node.parent);
        if (parent === undefined || parent === entry) roots.push(entry);
        else parent.children.push(entry);
      }
      const rank = (entry) =>
        entry.node.master ? 0 : entry.node.status === 'running' ? 1 : entry.node.status === 'idle' ? 2 : 3;
      const sort = (list) =>
        list.sort(
          (left, right) =>
            rank(left) - rank(right) ||
            (left.node.name || left.node.short).localeCompare(right.node.name || right.node.short),
        );
      sort(roots);
      for (const entry of entries.values()) sort(entry.children);
      return roots;
    }

    /**
     * Board reader shared by every surface on this page: one poll loop, one
     * cached snapshot object, `useSyncExternalStore` underneath.
     * @param fetchImpl - `window.fetch`.
     * @returns subscribe, cached snapshot, start/stop, manual refresh, and the
     *   write paths the master appointment uses.
     */
    function createBoardStore(fetchImpl) {
      let snapshot = {
        board: emptyBoard(),
        failed: false,
      };
      const listeners = new Set();
      const publish = (next) => {
        snapshot = next;
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.error('[peer-bus] board listener failed:', error);
          }
        }
      };
      let timer = null;
      let inflight = false;

      const read = async () => {
        if (inflight) return;
        inflight = true;
        try {
          const response = await fetchImpl(ROUTE, {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          publish({ board: normalizeBoard(await response.json()), failed: false });
        } catch {
          // A stopped or restarting Host keeps the last good reading on screen.
          publish({ board: snapshot.board, failed: snapshot.board.nodes.length === 0 });
        } finally {
          inflight = false;
        }
      };

      return {
        /** @param listener - called after every snapshot change. */
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        /** @returns the cached snapshot; identity changes only on a change. */
        getSnapshot() {
          return snapshot;
        },
        /** Begin polling, idempotently. */
        start() {
          if (timer !== null) return;
          void read();
          timer = window.setInterval(() => {
            if (document.visibilityState === 'hidden') return;
            void read();
          }, POLL_MS);
        },
        /** Stop polling; the snapshot stays readable. */
        stop() {
          if (timer === null) return;
          window.clearInterval(timer);
          timer = null;
        },
        /** Read now, keeping the poll schedule. */
        refresh: read,
        /** Adopt a board the Host returned from an action, without a second round trip. */
        publishBoard(board) {
          publish({ board, failed: false });
        },
        /** Re-publish the current snapshot so surfaces re-read a changed service. */
        rerender() {
          publish({ board: snapshot.board, failed: snapshot.failed });
        },
      };
    }

    /**
     * The page's one board reader. Created with the factory (no polling yet —
     * `apply` starts it inside an effect) so every surface shares one snapshot.
     */
    const store = createBoardStore((input, init) => window.fetch(input, init));

    /**
     * Client services this bundle reaches at click time, or `null` where the
     * build or profile does not provide them. Set in `apply`; components never
     * touch a service directly, which keeps them renderable in a bare harness.
     */
    const runtime = { openSession: null, openBoardTab: null };

    /* --------------------------------------------------------------- notices */

    /**
     * A transient line of feedback for a click that changed the role. The board
     * alone is weak feedback: a running row keeps its crown in the hover actions,
     * so the click would otherwise look like a no-op.
     */
    const noticeState = { text: '', listeners: new Set(), timer: null };

    function notifyListeners() {
      for (const listener of noticeState.listeners) {
        try {
          listener();
        } catch (error) {
          console.warn('[peer-bus] notice listener failed:', error);
        }
      }
    }

    /**
     * Show one notice for a few seconds, replacing the previous one.
     * @param text - the message; an empty string clears it immediately.
     */
    function showNotice(text) {
      noticeState.text = String(text ?? '');
      if (noticeState.timer !== null) {
        clearTimeout(noticeState.timer);
        noticeState.timer = null;
      }
      notifyListeners();
      if (noticeState.text === '') return;
      noticeState.timer = setTimeout(() => {
        noticeState.timer = null;
        noticeState.text = '';
        notifyListeners();
      }, 4000);
    }

    /**
     * Appoint one session master of its project, or release the role, then adopt
     * the board the route answers with.
     * @param sessionId - the row's session.
     * @param makeMaster - true to appoint, false to release.
     */
    async function requestMaster(sessionId, makeMaster) {
      try {
        const response = await window.fetch(MASTER_ROUTE, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId, master: makeMaster !== false }),
        });
        if (!response.ok) {
          showNotice(makeTranslator()('notice.masterFailed'));
          return;
        }
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (payload !== null && typeof payload === 'object' && Array.isArray(payload.nodes)) {
          store.publishBoard(normalizeBoard(payload));
        }
        showNotice(makeTranslator()(makeMaster === false ? 'notice.masterCleared' : 'notice.masterSet'));
      } catch (error) {
        // A refused or unavailable Host never blocks the page: keep the last board.
        console.warn('[peer-bus] master request failed:', error);
        showNotice(makeTranslator()('notice.masterFailed'));
      } finally {
        void store.refresh();
      }
    }

    /** Open a session through `uiWorkspace`, when this build provides it. */
    function openSession(sessionId) {
      const opener = runtime.openSession;
      if (typeof opener !== 'function') return;
      try {
        opener(sessionId);
      } catch (error) {
        console.warn('[peer-bus] openSession failed:', error);
      }
    }

    /* ------------------------------------------------------------- helpers */

    /** `ЧЧ:ММ:СС` — the only clock a person reads here. */
    function clockOf(millis) {
      const date = new Date(millis);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** Last path segment of a project root. */
    function projectLabel(root) {
      if (typeof root !== 'string' || root === '') return '';
      const parts = root.split(/[\\/]+/).filter((part) => part !== '');
      return parts.length === 0 ? '' : parts[parts.length - 1];
    }

    /** Translator over one slot's `t`, falling back to the Russian labels. */
    function makeTranslator(t) {
      // The owner reads Russian, and the app's own locale may be `en`; following it would flip
      // every label of this plugin. The RU dictionary therefore wins whenever it holds the key.
      return (key, params) => {
        const fallback = typeof t === 'function' ? t(key, params) : undefined;
        const template = RUSSIAN[key] ?? fallback ?? key;
        if (params === undefined || typeof template !== 'string') return template;
        return template.replace(/\{(\w+)\}/g, (match, name) =>
          params[name] === undefined ? match : String(params[name]),
        );
      };
    }

    /** The name a person reads for a node: the session title first, then the declared label, else the handle. */
    function nodeLabel(node) {
      const title = typeof node.title === 'string' ? node.title.trim() : '';
      if (title !== '') return title;
      const name = node.name.trim();
      return name === '' ? node.short : name;
    }

    /** A cost as text: the number the Host sent, plus its own currency code. */
    function costText(cost) {
      if (cost === null) return '';
      const currency = cost.currency.trim();
      return currency === '' ? String(cost.total) : `${cost.total} ${currency}`;
    }

    /* ----------------------------------------------------------- component */

    /** One chip on a node's meta line; nothing when its text is empty. */
    function Chip({ tone, text, title }) {
      if (typeof text !== 'string' || text === '') return null;
      return h('span', { className: 'dshPeerBus_chip', 'data-tone': tone, title: title ?? text }, text);
    }

    /** A node's resource claims as chips, the overflow collapsed to `+N`. */
    function ClaimChips({ claims }) {
      if (claims.length === 0) return null;
      const shown = claims.slice(0, CLAIM_CHIPS);
      const rest = claims.length - shown.length;
      return [
        ...shown.map((resource) => h(Chip, { key: resource, tone: 'claim', text: resource })),
        rest > 0 ? h(Chip, { key: '+rest', tone: 'claim', text: `+${rest}`, title: claims.join(', ') }) : null,
      ];
    }

    /** The board's project-wide claims, above the tree; nothing when there are none. */
    function ClaimsBlock({ claims, tr }) {
      if (!Array.isArray(claims) || claims.length === 0) return null;
      return h(
        'div',
        { className: 'dshPeerBus_claims', 'data-peer-bus': 'claims' },
        h('div', { className: 'dshPeerBus_claimsHead' }, tr('dock.claims')),
        claims.map((claim) => {
          const holder = claim.holderName.trim() !== '' ? claim.holderName.trim() : claim.holder;
          const until = claim.expiresAt > 0 ? tr('dock.claimUntil', { time: clockOf(claim.expiresAt) }) : '';
          return h(
            'div',
            { className: 'dshPeerBus_claimRow', key: claim.resource, title: claim.note !== '' ? claim.note : claim.resource },
            h('span', { className: 'dshPeerBus_claimResource' }, claim.resource),
            holder.trim() === '' ? null : h('span', { className: 'dshPeerBus_claimHolder' }, holder),
            until === '' ? null : h('span', { className: 'dshPeerBus_claimUntil' }, until),
          );
        }),
      );
    }

    /** "just now" / "5 min ago" / "2 h ago" / "3 d ago" from a last-activity millisecond stamp. */
    function agoText(millis, tr) {
      if (!Number.isFinite(millis) || millis <= 0) return '';
      const delta = Date.now() - millis;
      if (delta < 60_000) return tr('dock.agoNow');
      const minutes = Math.floor(delta / 60_000);
      if (minutes < 60) return tr('dock.agoMinutes', { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return tr('dock.agoHours', { count: hours });
      return tr('dock.agoDays', { count: Math.floor(hours / 24) });
    }

    /** The meta line under a node: claims, open threads, cost — each only when present. */
    function NodeMeta({ node, tr }) {
      const cost = costText(node.cost);
      const hasClaim = node.claims.length > 0;
      const hasThreads = node.openThreads > 0;
      const ago = agoText(node.lastActivity, tr);
      if (!hasClaim && !hasThreads && cost === '' && ago === '') return null;
      return h(
        'div',
        { className: 'dshPeerBus_nodeMeta' },
        h(ClaimChips, { claims: node.claims }),
        hasThreads ? h(Chip, { tone: 'thread', text: tr('dock.openThreads', { count: node.openThreads }) }) : null,
        ago === '' ? null : h(Chip, { key: 'ago', tone: 'cost', text: ago }),
        cost === ''
          ? null
          : h(Chip, { key: 'cost', tone: 'cost', text: cost, title: tr('dock.cost', { value: cost }) }),
      );
    }

    /** One tree level: the node's own row, its intent, its meta, then its children. */
    function TreeNode({ entry, depth, tr, parentLabel }) {
      const { node, children } = entry;
      const intent = node.intent.trim() !== '' ? node.intent.trim() : node.last.trim();
      const label = nodeLabel(node);
      const state = stateOfNode(node);
      return h(
        'li',
        { className: 'dshPeerBus_node', 'data-session': node.id, 'data-sub': node.subagent ? 'true' : 'false' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshPeerBus_nodeHead',
            title:
              node.subagent && typeof parentLabel === 'string' && parentLabel !== ''
                ? tr('dock.subagentOf', { name: parentLabel }) + ' · ' + tr('dock.openSession', { name: label })
                : tr('dock.openSession', { name: label }),
            onClick: () => openSession(node.id),
          },
          h('span', { className: 'dshPeerBus_dot', 'data-state': state, 'aria-hidden': true }),
          h(
            'span',
            { className: 'dshPeerBus_name', 'data-muted': state === 'closed', title: node.id },
            label,
          ),
          node.master || node.role === 'master'
            ? h('span', { className: 'dshPeerBus_treeCrown', 'aria-hidden': true }, h(Crown, null))
            : null,
          node.master || node.role === 'master'
            ? h('span', { className: 'dshPeerBus_chip', 'data-tone': 'master' }, '(' + tr('dock.master') + ')')
            : null,
          node.dnd ? h('span', { className: 'dshPeerBus_chip', 'data-tone': 'dnd' }, tr('dock.dnd')) : null,
          node.subagent ? h('span', { className: 'dshPeerBus_chip' }, tr('dock.sub')) : null,
          node.pendingQuestions > 0
            ? h('span', { className: 'dshPeerBus_chip', 'data-tone': 'ask' }, tr('dock.asks', { count: node.pendingQuestions }))
            : null,
        ),
        intent === ''
          ? null
          : h('div', { className: 'dshPeerBus_intent', title: intent }, intent),
        h(NodeMeta, { node, tr }),
        children.length > 0 && depth < 12
          ? h(
              'ul',
              {
                className: 'dshPeerBus_branch',
                'data-sub': children.every((child) => child.node.subagent) ? 'true' : 'false',
              },
              children.map((child) =>
                h(TreeNode, { key: child.node.id, entry: child, depth: depth + 1, tr, parentLabel: label }),
              ),
            )
          : null,
      );
    }

    /** The board's counts as one localized sentence, by state rather than by legacy status. */
    function countLine(nodes, tr) {
      const counts = { running: 0, idle: 0, needs_you: 0, done: 0, error: 0, closed: 0 };
      for (const node of nodes) counts[stateOfNode(node)] += 1;
      const parts = [];
      if (counts.running > 0) parts.push(tr('dock.stateRunning', { count: counts.running }));
      if (counts.idle > 0) parts.push(tr('dock.stateIdle', { count: counts.idle }));
      if (counts.needs_you > 0) parts.push(tr('dock.stateNeedsYou', { count: counts.needs_you }));
      if (counts.done > 0) parts.push(tr('dock.stateDone', { count: counts.done }));
      if (counts.error > 0) parts.push(tr('dock.stateError', { count: counts.error }));
      if (parts.length === 0) parts.push(tr('dock.stateClosed', { count: counts.closed }));
      return parts.join(' · ');
    }

    /** The colour legend: one dot per state with its word, so the palette is self-explaining. */
    function StateLegend({ tr }) {
      return h(
        'div',
        { className: 'dshPeerBus_legend' },
        NODE_STATES.map((state) =>
          h(
            'span',
            { key: state, className: 'dshPeerBus_legendItem' },
            h('span', { className: 'dshPeerBus_dot', 'data-state': state, 'aria-hidden': true }),
            tr('legend.' + state),
          ),
        ),
      );
    }

    /** The board's header meta: counts, thread count (when any), last read. */
    function boardMeta(board, nodes, tr) {
      return [
        countLine(nodes, tr),
        board.threads.length > 0 ? tr('dock.openThreads', { count: board.threads.length }) : '',
        board.updatedAt > 0 ? tr('dock.updated', { time: clockOf(board.updatedAt) }) : '',
      ]
        .filter((part) => part !== '')
        .join(' · ');
    }

    /** The dock's own refresh control. */
    function RefreshButton({ tr }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dshPeerBus_refresh',
          'aria-label': tr('dock.refresh'),
          title: tr('dock.refresh'),
          onClick: () => {
            void store.refresh();
          },
        },
        h(RefreshMark, null),
      );
    }

    /** "Show the whole board in the right dock", only when that tab exists. */
    function OpenBoardButton({ tr }) {
      if (typeof runtime.openBoardTab !== 'function') return null;
      const label = tr('dock.openBoard');
      return h(
        'button',
        {
          type: 'button',
          className: 'dshPeerBus_refresh',
          'aria-label': label,
          title: label,
          onClick: () => {
            runtime.openBoardTab();
          },
        },
        h(PanelMark, null),
      );
    }

    /**
     * Board button in the session header: the board lives in the right dock (it is a move, not a
     * duplicate), and this is how the tab is found. Invisible without the tab registry.
     * @param props - the slot's translation hook.
     */
    function BoardHeaderButton(props) {
      const tr = makeTranslator(props?.t);
      return h(OpenBoardButton, { tr });
    }

    /**
     * The always-visible master indicator in the sidebar footer: a gold crown plus the master's
     * name, pulsing while that session works. The row's own leading cell cannot carry it — the
     * harness replaces that seat with the status dot for a running row — so this is the placement
     * that stays visible without hovering anything.
     * @param props - the slot's translation hook.
     */
    function MasterFooterChip(props) {
      const tr = makeTranslator(props?.t);
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const masters = snapshot.board.nodes.filter((node) => node.master || node.role === 'master');
      if (masters.length === 0) return null;
      const node = masters[0];
      const running = stateOfNode(node) === 'running';
      const label = tr('footer.master', { name: nodeLabel(node) });
      return h(
        'button',
        {
          type: 'button',
          className: 'dshPeerBus_footerChip',
          'data-running': running ? 'true' : 'false',
          'aria-label': label,
          title: label,
          onClick: () => {
            if (typeof runtime.openBoardTab === 'function') runtime.openBoardTab();
            else openSession(node.id);
          },
        },
        h('span', { className: 'dshPeerBus_footerCrown' }, h(Crown, null)),
        h('span', { className: 'dshPeerBus_footerName' }, nodeLabel(node)),
      );
    }

    /**
     * The whole board as a right-dock tab: every project or one chosen project,
     * the project's claimed resources, and the same clickable tree.
     * Registered only where the build provides the tab type registry.
     * @param props - `sessionId` of the tab's session, plus `t`.
     */
    function PeerBoardTab(props) {
      const tr = makeTranslator(props?.t);
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const board = snapshot.board;
      const [picked, setPicked] = React.useState('');

      const roots = [];
      for (const node of board.nodes) {
        if (node.project !== '' && !roots.includes(node.project)) roots.push(node.project);
      }
      const chosen = roots.includes(picked) ? picked : '';
      const shown = chosen === '' ? board.nodes : board.nodes.filter((node) => node.project === chosen);
      const forest = buildForest(shown);
      const meta = boardMeta(board, shown, tr);

      return h(
        'div',
        { className: 'dshPeerBus_pane', 'data-peer-bus': 'board' },
        h(
          'div',
          { className: 'dshPeerBus_paneHead' },
          h('span', { className: 'dshPeerBus_paneTitle' }, tr('tab.title')),
          h('span', { className: 'dshPeerBus_paneMeta', title: meta }, meta),
          h(RefreshButton, { tr }),
        ),
        h(StateLegend, { tr }),
        roots.length > 1
          ? h(
              'label',
              { className: 'dshPeerBus_filterRow' },
              h('span', { className: 'dshPeerBus_filterLabel' }, tr('dock.filter')),
              h(
                'select',
                {
                  className: 'dshPeerBus_filter',
                  value: chosen,
                  onChange: (event) => setPicked(event?.target?.value ?? ''),
                },
                h('option', { value: '' }, tr('dock.filterAll')),
                roots.map((root) =>
                  h('option', { key: root, value: root }, projectLabel(root) === '' ? root : projectLabel(root)),
                ),
              ),
            )
          : null,
        h(ClaimsBlock, { claims: board.claims, tr }),
        forest.length === 0
          ? h('div', { className: 'dshPeerBus_empty' }, snapshot.failed ? tr('dock.emptyHint') : tr('dock.empty'))
          : h(
              'ul',
              { className: 'dshPeerBus_tree', 'data-grow': 'true' },
              forest.map((entry) => h(TreeNode, { key: entry.node.id, entry, depth: 0, tr })),
            ),
      );
    }

    /**
     * The crown in a row's leading cell. The row reserves that 16px cell for its
     * own state dot while it runs, so the mark appears on the idle rows where the
     * cell is free — `MasterRowAction` covers the running row — and the hover
     * line below states the fact in words.
     * @param props - `sessionId` of the row, plus `t`.
     */
    function MasterMark(props) {
      const tr = makeTranslator(props?.t);
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      if (!isMasterOf(snapshot.board, props?.sessionId)) return null;
      const label = tr('mark.master');
      return h(
        'span',
        { className: 'dshPeerBus_mark', role: 'img', 'aria-label': label, title: label },
        h(Crown, null),
      );
    }

    /** The same fact as words on the row's hover card, where there is room. */
    function MasterHoverLine(props) {
      const tr = makeTranslator(props?.t);
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      if (!isMasterOf(snapshot.board, props?.sessionId)) return null;
      return h(
        'div',
        { className: 'dshPeerBus_hoverLine' },
        h(Crown, null),
        h('span', null, tr('hover.master')),
      );
    }

    /**
     * The board button in a master row's action strip. It deliberately is NOT a crown: the crown
     * means "this session is the master" and sits in the leading cell, so this one carries a panel
     * glyph and the «Доска сессий» label — two different things must not look the same.
     * @param props - `sessionId` / `displayTitle` of the row, plus `t`.
     */
    function MasterRowAction(props) {
      const tr = makeTranslator(props?.t);
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const sessionId = props?.sessionId;
      if (!isMasterOf(snapshot.board, sessionId)) return null;
      const boardLabel = tr('dock.openBoard');
      const boardButton =
        typeof runtime.openBoardTab !== 'function'
          ? h('span', { className: 'dshPeerBus_boardMark', role: 'img', 'aria-label': boardLabel, title: boardLabel }, h(PanelMark, null))
          : h(
              'button',
              {
                type: 'button',
                className: 'dshPeerBus_boardMark',
                'aria-label': boardLabel,
                title: boardLabel,
                onClick: () => {
                  runtime.openBoardTab();
                },
              },
              h(PanelMark, null),
            );
      // While the session works, the row's status dot takes the leading cell, so the gold crown
      // moves here for the duration; an idle row already shows it on the left.
      const crown =
        statusOfSession(snapshot.board, sessionId) === 'running'
          ? h(
              'span',
              {
                className: 'dshPeerBus_crownInline',
                role: 'img',
                'aria-label': tr('mark.master'),
                title: tr('mark.master'),
              },
              h(Crown, null),
            )
          : null;
      return h('span', { className: 'dshPeerBus_rowActions' }, crown, boardButton);
    }

    /**
     * One row of the "…" menu: appoint this session master, or release the role
     * when it already holds it. The entry dismisses the menu through the slot's
     * own `useMenuOpenState` hook, as the shipped rows do.
     * @param props - `sessionId` / `displayTitle` of the row, the menu hook, `t`.
     */
    function MakeMasterMenuItem(props) {
      const tr = makeTranslator(props?.t);
      const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const useMenuOpenState = typeof props?.useMenuOpenState === 'function' ? props.useMenuOpenState : null;
      const menu = useMenuOpenState === null ? null : useMenuOpenState();
      const sessionId = props?.sessionId;
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      const isMaster = isMasterOf(snapshot.board, sessionId);
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'dshPeerBus_menuItem',
          onClick: () => {
            if (typeof menu?.[1] === 'function') menu[1](false);
            void requestMaster(sessionId, !isMaster);
          },
        },
        h(Crown, null),
        h('span', null, tr(isMaster ? 'menu.releaseMaster' : 'menu.makeMaster')),
      );
    }

    /** The transient role-change notice: fixed, click-through, above the columns. */
    const NOTICE_CSS =
      '.dshPeerBus_notice{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);padding:8px 14px;' +
      'border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover,rgba(60,60,60,.94));' +
      'color:var(--dsw-alias-label-primary,#fff);font-size:12px;line-height:18px;z-index:60;pointer-events:none;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.28)}'

    /** Renders the latest notice, or nothing after it expires. */
    function NoticeOverlay() {
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        noticeState.listeners.add(bump);
        return () => noticeState.listeners.delete(bump);
      }, []);
      if (noticeState.text === '') return null;
      return h('div', { className: 'dshPeerBus_notice', role: 'status', 'aria-live': 'polite' }, noticeState.text);
    }

    /* --------------------------------------------------------------- apply */

    /** Browser services this half needs: the slot registry and copy. */
    const inject = ['slots', 'locale'];

    /**
     * Install every surface, then the right-dock tab where the build has a tab
     * type registry. The tab half is started through a nested `ctx.inject`, so a
     * build without `sidebarRight`/`sidebarRightTabs` simply never runs it —
     * the crown, hover line and composer strip are untouched by that absence.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-peer-bus';
        tag.textContent = CSS + NOTICE_CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'peer-bus: styles');

      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'peer-bus: dictionaries');

      ctx.effect(() => {
        store.start();
        return () => store.stop();
      }, 'peer-bus: board poll');

      // `uiWorkspace` is resolved per click so a page that binds the service
      // after this plugin keeps working, and a page without it cannot throw.
      const lookup = (name) => {
        try {
          return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
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

      ctx.slots.inject('sidebar.session.row.leading', () =>
        ctx.slots.register(
          { name: 'sidebar.session.row.leading', id: 'peer-bus-master', order: 20, locale: NS },
          MasterMark,
        ),
      );
      ctx.slots.inject('sidebar.session.row.hover', () =>
        ctx.slots.register(
          { name: 'sidebar.session.row.hover', id: 'peer-bus-master', order: 20, locale: NS },
          MasterHoverLine,
        ),
      );
      ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
        ctx.slots.register(
          { name: 'sidebar.workspaces.session.row.action', id: 'peer-bus-master', order: 50, locale: NS },
          MasterRowAction,
        ),
      );
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'peer-bus-master', order: 350, locale: NS },
          MakeMasterMenuItem,
        ),
      );
      // The board is a right-dock tab, not a composer strip: this header button is the way in.
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'peer-bus-board', order: 40, locale: NS },
          BoardHeaderButton,
        ),
      );

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'peer-bus-notice', order: 60, locale: NS }, NoticeOverlay),
      );

      // No footer chip: the owner found the permanent master label in the sidebar foot confusing.
      // The role stays visible in the board (crown next to the name) and on the row itself.

      if (typeof ctx.inject !== 'function') return;
      try {
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          const bind = () => {
            try {
              return scope.locale.bind(NS);
            } catch {
              return (key) => RUSSIAN[key] ?? key;
            }
          };
          scope.effect(
            () =>
              scope.sidebarRightTabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                title: () => bind()('tab.title'),
              }),
            'peer-bus: board tab type',
          );
          scope.slots.inject('sidebar.right.pane.tab', () =>
            scope.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, PeerBoardTab),
          );
          scope.effect(() => {
            runtime.openBoardTab = () => {
              try {
                scope.sidebarRight.openTab(TAB_KIND);
              } catch (error) {
                console.warn('[peer-bus] board tab could not open:', error);
              }
            };
            store.rerender();
            return () => {
              runtime.openBoardTab = null;
              store.rerender();
            };
          }, 'peer-bus: board tab opener');
        });
      } catch (error) {
        // A build without the right-dock tab registry keeps every other surface.
        console.warn('[peer-bus] board tab unavailable:', error);
      }
    }

    return { inject, apply };
  },
});
