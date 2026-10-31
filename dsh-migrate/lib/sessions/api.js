/**
 * The plugin's operations.
 *
 * One object is shared by the agent tool and by the browser routes, so every
 * operation has exactly one implementation and both callers see the same
 * behaviour: discovery, import, ledger and asset proposals.
 */
import { randomUUID } from 'node:crypto';

import { attachSessions, listWorkspaces, workspaceHasSession } from './attach.js';
import { importForeign, requireService, sessionIdFor, updateImported } from './import.js';
import { reimportSession } from './reimport.js';
import { repairWatermarks } from './watermark.js';
import { listImports, ledgerSummary } from './ledger.js';
import { inventory, projectTree, search } from './scan.js';

/**
 * Mark every tree session with whether a workspace already lists it.
 *
 * The panel offers «Привязать к проекту» exactly for the sessions that show as
 * Ungrouped: `inWorkspace === false`. When the registry is unavailable the field
 * stays absent (unknown) instead of a false "not attached".
 *
 * @param ctx - the Host context.
 * @param tree - the project tree from `projectTree`.
 */
async function annotateWorkspace(ctx, tree) {
  const workspaces = await listWorkspaces(ctx);
  if (workspaces === undefined) return tree;
  for (const project of tree?.projects ?? []) {
    for (const session of project.sessions) {
      // The tree row carries the source id; a workspace lists the DSH session id, so the
      // membership check must look at the imported id when the row has one.
      const targetId = typeof session.importedSessionId === 'string' && session.importedSessionId !== ''
        ? session.importedSessionId
        : session.id;
      const workspace = workspaces.find((candidate) => workspaceHasSession(candidate, targetId));
      if (workspace === undefined || workspace === null) {
        session.inWorkspace = false;
      } else {
        session.inWorkspace = true;
        session.workspaceTitle = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : String(workspace.path ?? '');
      }
    }
  }
  return tree;
}

/**
 * Build the operations bound to one Host context.
 * @param ctx - the Host plugin context.
 * @returns the operation table.
 */
export function createOperations(ctx) {
  return {
    /** Scan every source and return sessions, projects and ledger counters. */
    async scan(options = {}) {
      return await inventory({
        limit: options.limit,
        offset: options.offset,
        query: options.query,
        sources: options.sources,
      });
    },

    /** Free-text search across every source. */
    async search(query, options = {}) {
      return await search(query, { limit: options.limit, sources: options.sources });
    },

    /**
     * Every detected session grouped by its project — the panel's tree view.
     *
     * A project row carries its own session page, so the UI renders folders with
     * sessions inside instead of one flat sheet, the way the origin agents show
     * them. Sessions spawned inside another session are context for their parent,
     * not sessions of their own: they are counted separately and shown only when
     * `includeChildren` asks for them. The result is cached briefly on the Host.
     */
    async tree(options = {}) {
      const result = await projectTree({
        query: options.query,
        sources: options.sources,
        perProject: options.perProject,
        perSourceLimit: options.perSourceLimit,
        includeChildren: options.includeChildren === true,
        fresh: options.fresh === true,
      });
      return await annotateWorkspace(ctx, result);
    },

    /**
     * Attach stored sessions to the workspace (project folder) of their own cwd.
     *
     * The repair path for sessions that show as **Ungrouped**: an import normally
     * attaches itself, but a predecessor install or a failed attach left them out
     * of every workspace's `sessionIds`. Idempotent — an attached session reports
     * `already` and the registry is not touched.
     */
    async attach(sessionIds) {
      return await attachSessions(ctx, sessionIds);
    },

    /** Import one foreign session into DSH. */
    async import(ref, options = {}) {
      if (ref === null || typeof ref !== 'object') throw new Error('import needs {source, id, path?}');
      return await importForeign(ctx, ref, { force: options.force === true, includeSubagents: options.includeSubagents === true });
    },

    /**
     * Update an already imported session: append only what appeared in the
     * origin since the import, keeping the DSH session id, its title and any
     * turn the user added here.
     */
    async update(ref) {
      if (ref === null || typeof ref !== 'object') throw new Error('update needs {source, id, path?}');
      return await updateImported(ctx, ref);
    },
    /**
     * Import a selection of foreign sessions in one operation.
     *
     * The panel sends this in small batches so it can show progress and stay
     * inside one HTTP request; each item is independent, so one unreadable
     * session never fails a whole project import.
     *
     * @param items - `[{source, id, path?}]`.
     * @param options - `{force}`.
     * @returns `{results, summary}` with per-item status and counters.
     */
    async importBatch(items, options = {}) {
      const list = Array.isArray(items) ? items : [];
      if (list.length === 0) throw new Error('import_batch needs a non-empty items array');
      if (list.length > 50) throw new Error('import_batch accepts at most 50 items per call; send the selection in batches');
      const results = [];
      const hooks = options.hooks !== null && typeof options.hooks === 'object' ? options.hooks : {};
      let imported = 0;
      let already = 0;
      let failed = 0;
      for (let index = 0; index < list.length; index += 1) {
        const item = list[index];
        const source = String(item?.source ?? '');
        const id = String(item?.id ?? '');
        try {
          if (source === '' || id === '') throw new Error('each item needs a source and an id');
          if (typeof hooks.onItemStart === 'function') hooks.onItemStart(index, { source, id, path: String(item?.path ?? '') });
          const report = await importForeign(ctx, { source, id, path: item?.path }, {
            force: options.force === true,
            includeSubagents: options.includeSubagents === true,
            // A batch reports the stages of the item that is being imported now.
            onProgress: (stage, data) => {
              if (typeof hooks.onStage === 'function') hooks.onStage(index, stage, data ?? {});
            },
          });
          if (report.status === 'already-imported') already += 1;
          else imported += 1;
          const result = {
            source,
            id,
            status: report.status,
            sessionId: report.sessionId,
            title: report.title,
            cwd: report.cwd,
            workspacePath: report.workspacePath,
            eventCount: report.eventCount,
            turnCount: report.turnCount,
            verified: report.verified === true,
            warnings: Array.isArray(report.warnings) ? report.warnings : [],
          };
          results.push(result);
          if (typeof hooks.onItemDone === 'function') hooks.onItemDone(index, result);
        } catch (error) {
          failed += 1;
          const result = { source, id, status: 'failed', error: error?.message ?? String(error) };
          results.push(result);
          if (typeof hooks.onItemDone === 'function') hooks.onItemDone(index, result);
        }
      }
      return { results, summary: { total: list.length, imported, already, failed } };
    },

    /**
     * Re-import one session from scratch: delete the imported copy, clear its
     * ledger row, import again with fresh watermarks.
     *
     * This is the repair path for a ledger row without watermarks (an install
     * that predates them) and for a source that rewrote its history.
     */
    async reimport(ref, options = {}) {
      if (ref === null || typeof ref !== 'object') throw new Error('reimport needs {source, id, path?}');
      return await reimportSession(ctx, ref, {
        mode: options.mode === 'replace' ? 'replace' : 'copy',
        includeSubagents: options.includeSubagents === true,
        onProgress: options.onProgress,
      });
    },

    /**
     * Prove inherited copies against their origins and write the update
     * watermark — no deletion, no re-import, works while the session is open.
     *
     * @param query - `{sessionIds, entryIds, refs}`; empty means every row without
     *   a watermark.
     */
    async repairWatermarks(query = {}) {
      return await repairWatermarks(ctx, {
        sessionIds: Array.isArray(query.sessionIds) ? query.sessionIds.map(String) : undefined,
        entryIds: Array.isArray(query.entryIds) ? query.entryIds.map(String) : undefined,
        refs: Array.isArray(query.refs) ? query.refs : undefined,
      });
    },

    /** The import ledger: which foreign session became which DSH session. */
    ledger() {
      return { ...ledgerSummary(), entries: listImports().slice(0, 200) };
    },

    /** The DSH session id an import would use, without writing anything. */
    preview(ref) {
      return {
        sessionId: sessionIdFor(String(ref?.source ?? ''), String(ref?.id ?? '')),
        source: String(ref?.source ?? ''),
        foreignId: String(ref?.id ?? ''),
      };
    },

    /**
     * Read one session back through DSH's own session query layer.
     *
     * This is deliberately a different seam from the persistence read-back the
     * import performs: `sessionQuery.readSession` builds a Session from the
     * complete logical log (`Session.create`), which is what opening and
     * continuing the session does. A session that passes here is a first-class
     * DSH session, not merely a stored file.
     */
    async verify(sessionId) {
      const id = String(sessionId ?? '');
      if (id === '') throw new Error('verify needs a session id');
      const query = requireService(ctx, 'sessionQuery');
      const settle = async (value) => (value !== null && typeof value === 'object' && typeof value.then === 'function' ? await value : value);
      const read = await query.readSession(id);
      let title;
      if (typeof query.readTitle === 'function') {
        try {
          const value = await settle(query.readTitle(id));
          if (typeof value === 'string') title = value;
          else if (value !== null && typeof value === 'object' && typeof value.title === 'string') title = value.title;
        } catch {
          /* the title projection is a convenience, the log is the contract */
        }
      }
      const events = Array.isArray(read?.events) ? read.events : [];
      if (title === undefined) {
        const event = events.find((entry) => entry?.type === 'session/title');
        if (typeof event?.data?.title === 'string') title = event.data.title;
      }
      let listed = false;
      if (typeof query.listSessions === 'function') {
        try {
          const records = await settle(query.listSessions());
          const rows = Array.isArray(records) ? records : (records?.items ?? []);
          listed = rows.some((row) => row?.header?.id === id || row?.sessionId === id);
        } catch {
          /* listing is advisory */
        }
      }
      return {
        sessionId: id,
        readable: true,
        listed,
        title: title ?? '',
        cwd: typeof read?.session?.cwd === 'string' ? read.session.cwd : '',
        eventCount: events.length,
        turnCount: events.filter((entry) => entry?.type === 'turn/start').length,
        // Appendix turns this importer adds for spawned (subagent) transcripts.
        appendixCount: events.filter(
          (entry) =>
            entry?.type === 'user/message' &&
            Array.isArray(entry?.data?.content) &&
            entry.data.content.some((block) => typeof block?.text === 'string' && /(?:subagent|workflow) transcript \d+:/u.test(block.text)),
        ).length,
        inheritedEventCount: Number.isSafeInteger(read?.inheritedEventCount) ? read.inheritedEventCount : 0,
      };
    },

    /**
     * Whether this plugin's browser bundle reached the page manifest.
     *
     * The client half only renders after the Host composed it into
     * `window.__DSH_BOOT__`, and that composition is cached per Host process. This
     * report says plainly whether a page reload is enough or a full restart is
     * required — the question a user asks when a panel does not appear.
     */
    async uiDiagnostics() {
      const packageName = '@local/dsh-migrate';
      const settle = async (value) => (value !== null && typeof value === 'object' && typeof value.then === 'function' ? await value : value);
      const modules = typeof ctx?.get === 'function' ? ctx.get('clientModules') : undefined;
      if (modules === undefined || modules === null) {
        return {
          packageName,
          registered: false,
          reason: 'the Host publishes no clientModules service; the browser half cannot be composed here',
          clientPath: '',
          bundleUrl: '',
          rev: '',
          entries: 0,
        };
      }
      let clientPath = '';
      if (typeof modules.clientPath === 'function') {
        const value = await settle(modules.clientPath(packageName));
        if (typeof value === 'string') clientPath = value;
      }
      let entry;
      let entries = 0;
      if (typeof modules.graph === 'function') {
        try {
          const graph = await settle(modules.graph());
          const rows = Array.isArray(graph?.entries) ? graph.entries : Array.isArray(graph) ? graph : [];
          entries = rows.length;
          entry = rows.find((row) => row?.id === packageName);
        } catch {
          /* the graph is advisory for this report */
        }
      }
      return {
        packageName,
        registered: clientPath !== '' || entry !== undefined,
        clientPath,
        bundleUrl: typeof entry?.url === 'string' ? entry.url : '',
        rev: typeof entry?.rev === 'string' ? entry.rev : '',
        entries,
        reason:
          clientPath !== '' || entry !== undefined
            ? 'the browser half is composed; reload the plugins (⟳) to render the panel'
            : 'the browser half is not in the page manifest yet; restart DSH once (client packages are cached for the life of the Host process)',
      };
    },

    /**
     * Resume an imported session and send one prompt, then wait for the turn to
     * land in the same log.
     *
     * This is the real continuation check rather than a structural one: DSH
     * resumes the cold artifact through `sessionController`, the model receives
     * the imported history, and the new events append to the same session file.
     * It spends one model request, so it is an explicit action.
     */
    async continueSession(sessionId, text) {
      const id = String(sessionId ?? '');
      const prompt = String(text ?? '').trim();
      if (id === '') throw new Error('continue needs a session id');
      if (prompt === '') throw new Error('continue needs a prompt');
      const controller = requireService(ctx, 'sessionController');
      const query = requireService(ctx, 'sessionQuery');
      const settle = async (value) => (value !== null && typeof value === 'object' && typeof value.then === 'function' ? await value : value);
      /** Run one stage with its own label, keeping the deepest frame in the message. */
      const stage = async (label, run) => {
        try {
          return await run();
        } catch (error) {
          const stack = String(error?.stack ?? '')
            .split('\n')
            .slice(0, 4)
            .join(' | ');
          throw new Error(`${label}: ${error?.message ?? String(error)} :: ${stack}`);
        }
      };
      const before = await stage('read before', () => settle(query.readSession(id)));
      const beforeEventCount = Array.isArray(before?.events) ? before.events.length : 0;
      const requestId = `import-continue-${randomUUID()}`;
      const result = await stage('prompt', () =>
        settle(
          controller.prompt(
            { sessionId: id, requestId, content: [{ type: 'text', text: prompt }] },
            AbortSignal.timeout(60_000),
          ),
        ),
      );
      const deadline = Date.now() + 180_000;
      let afterEventCount = beforeEventCount;
      let reply = '';
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        let after;
        try {
          after = await settle(query.readSession(id));
        } catch {
          continue;
        }
        const events = Array.isArray(after?.events) ? after.events : [];
        afterEventCount = events.length;
        if (events.length <= beforeEventCount) continue;
        const appended = events.filter((event) => typeof event?.seq === 'number' && event.seq >= beforeEventCount);
        if (!appended.some((event) => event.type === 'turn/end')) continue;
        const assistant = appended.filter((event) => event.type === 'assistant/message').at(-1);
        const blocks = Array.isArray(assistant?.data?.message?.content) ? assistant.data.message.content : [];
        reply = blocks
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .slice(0, 800);
        break;
      }
      return {
        sessionId: id,
        accepted: result?.accepted !== false,
        requestId,
        prompt,
        beforeEventCount,
        afterEventCount,
        appended: afterEventCount > beforeEventCount,
        reply,
      };
    },

  };
}


