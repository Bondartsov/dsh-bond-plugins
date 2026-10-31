/**
 * DSH Migrate — Host half.
 *
 * One plugin, two independent layers behind one prefix:
 *
 *  - `/dsh-migrate/sessions/*` discovers sessions of Claude Code, Codex, ZCode
 *    (v1/v2), KiloCode and OpenCode and imports them as native DSH sessions;
 *  - `/dsh-migrate/assets/*` copies skills, appends MCP rows to the profile patch
 *    after a backup, writes selected secrets into the Windows user environment
 *    through an ACL-restricted temporary file and copies instruction documents
 *    masked.
 *
 * The browser panel renders both layers as tabs of one page; the model-facing
 * tools (`dsh_migrate_sessions`, `dsh_migrate_assets`) keep the same two layers
 * apart. Foreign agent stores are only read, never modified.
 */
import { buildStatus, buildTree, instructionContent, previewImport, runImport } from './lib/assets/operations.js';
import { createOperations } from './lib/sessions/api.js';
import { createRun, finishRun, getRun, latestRun, snapshot, updateRunItem, updateWriteProgress } from './lib/sessions/runs.js';

/** Plugin name shown in the profile. */
export const name = 'dsh-migrate';

/** Services this half needs before it activates. */
export const inject = ['tools', 'webServer'];

/** Browser-facing routes, all same-origin and all under the one prefix. */
const ROUTES = {
  sessionsTree: '/dsh-migrate/sessions/tree',
  sessionsRun: '/dsh-migrate/sessions/run',
  sessionsRunStatus: '/dsh-migrate/sessions/run-status',
  sessionsImport: '/dsh-migrate/sessions/import',
  sessionsUpdate: '/dsh-migrate/sessions/update',
  sessionsReimport: '/dsh-migrate/sessions/reimport',
  sessionsAttach: '/dsh-migrate/sessions/attach',
  sessionsRepairWatermark: '/dsh-migrate/sessions/repair-watermark',
  sessionsStatus: '/dsh-migrate/sessions/status',
  assetsTree: '/dsh-migrate/assets/tree',
  assetsRun: '/dsh-migrate/assets/run',
  assetsPreview: '/dsh-migrate/assets/preview',
  assetsStatus: '/dsh-migrate/assets/status',
  assetsInstruction: '/dsh-migrate/assets/instruction',
};

/** Human-facing timestamp in the project's date format. */
function formatTime(milliseconds) {
  const date = new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Whether a route request comes from this GUI. */
function sameOrigin(request) {
  const site = request?.headers?.['sec-fetch-site'];
  if (site === undefined || site === null) return true;
  return String(site).trim().toLowerCase() === 'same-origin';
}

/** Read a bounded JSON request body. */
function readJsonBody(request, limit = 256 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(undefined);
      }
    });
    request.on('error', () => finish(undefined));
  });
}

/** Answer one route with JSON. */
function respondJson(response, value) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Refuse one route with a machine-readable error. */
function respondError(response, status, code, hint) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: `${code}: ${hint}` }));
}

/** Content blocks a model-facing tool renders. */
const asText = (text) => [{ type: 'text', text }];

/** Validate the `items` payload of the assets run/preview routes. */
function normalizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({ type: String(item.type ?? ''), source: String(item.source ?? ''), name: String(item.name ?? '') }))
    .filter((item) => item.type !== '' && item.source !== '' && item.name !== '');
}

/** Validate the `items` payload of the sessions run route. */
function normalizeSessionItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({ source: String(item.source ?? ''), id: String(item.id ?? ''), path: item.path === undefined ? undefined : String(item.path) }))
    .filter((item) => item.source !== '' && item.id !== '');
}

/** Render one scan result as a compact model-facing report. */
function renderInventory(result) {
  const lines = [`Сканирование источников DSH: ${formatTime(result.generatedAt)}`];
  for (const source of result.sources) {
    if (source.available !== true) {
      lines.push(`- ${source.label} (${source.id}): недоступен — ${source.reason}`);
      continue;
    }
    lines.push(`- ${source.label} (${source.id}): ${source.total} сессий, показано ${source.sessions.length}`);
  }
  const sessions = result.sources.flatMap((source) => source.sessions.map((session) => ({ ...session, label: source.label })));
  if (sessions.length > 0) {
    lines.push('', 'Сессии:');
    for (const session of sessions.slice(0, 60)) {
      const title = session.title === '' ? '(без имени)' : session.title;
      const project = session.cwd === '' ? '(проект не записан)' : session.cwd;
      const imported = session.importedSessionId === '' ? '' : ` [импортирована как ${session.importedSessionId}]`;
      lines.push(`- ${session.label} · ${title} · ${project} · ${formatTime(session.updatedAt)} · id=${session.id}${imported}`);
    }
    if (sessions.length > 60) lines.push(`… ещё ${sessions.length - 60} сессий; уточните поиск через action=search.`);
  }
  lines.push('', `Уже импортировано: ${result.ledger.total}`);
  return lines.join('\n');
}

/** Render one import report. */
function renderImport(report) {
  if (report.status === 'already-imported') {
    return `Сессия уже импортирована как ${report.sessionId} ("${report.title}"). Повторный импорт не создаёт дубль.`;
  }
  const lines = [
    `Импортирована сессия "${report.title}" → ${report.sessionId}.`,
    `Проект: ${report.cwd}${report.workspacePath === undefined ? '' : ` (workspace ${report.workspacePath})`}`,
    `Событий: ${report.eventCount}, ходов: ${report.turnCount}.`,
    `Проверка холодным чтением: ${report.verified === true ? 'успешно — сессию можно открыть и продолжить' : `НЕ ПРОЙДЕНА (${String(report.verifyError ?? 'причина неизвестна')})`}.`,
  ];
  if (report.droppedCalls > 0) lines.push(`Отброшено вызовов без результата: ${report.droppedCalls}.`);
  if (report.droppedResults > 0) lines.push(`Отброшено результатов без вызова: ${report.droppedResults}.`);
  if (Array.isArray(report.warnings) && report.warnings.length > 0) {
    lines.push('Предупреждения:');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}

/** Render the assets tree as a compact model-facing report. */
function renderTree(tree) {
  const lines = [
    `Ассеты чужих агентов на ${tree.generatedAtText}:`,
    `Всего элементов: ${tree.totals.total}; импортируемых: ${tree.totals.selectable}.`,
    `  скилы: ${tree.totals.byType.skills} · MCP: ${tree.totals.byType.mcp} · плагины: ${tree.totals.byType.plugins} · инструкции: ${tree.totals.byType.instructions}`,
    `Статусы: новых ${tree.totals.new}, обновят ${tree.totals.update}, уже есть ${tree.totals.exists}, доступны без импорта ${tree.totals.available}, дублей ${tree.totals.duplicate}, негодных ${tree.totals.invalid}.`,
    `Секреты: ${tree.totals.byType.secrets} записей; новых ${tree.totals.new}, уже задано ${tree.totals.set}, пустых ${tree.totals.empty}, конфликтов ${tree.totals.conflict} → ${tree.targets.environment}`,
    '',
  ];
  for (const source of tree.sources) {
    lines.push(`${source.label} (${source.id}): ${source.counts.total} элементов`);
    for (const group of source.types) {
      lines.push(`  ${group.label}: ${group.items.length}`);
      for (const item of group.items.slice(0, 25)) {
        const status = item.status;
        const suffix = item.type === 'secrets' ? ` · ${item.valueLength} симв.` : item.target === '' ? '' : ` → ${item.target}`;
        lines.push(`    · ${item.name} [${status}]${suffix}`);
      }
    }
  }
  return lines.join('\n');
}

/** Render an assets import report. */
function renderReport(report) {
  const summary = report.summary;
  const lines = [
    report.summary.dryRun ? 'Сухой прогон (ничего не записано):' : 'Импорт выполнен:',
    `  запрошено: ${summary.requested} · скопировано: ${summary.copied} · обновлено: ${summary.updated} · добавлено MCP: ${summary.added} · секретов записано: ${summary.secrets ?? 0} · пропущено: ${summary.skipped} · ошибок: ${summary.failed}`,
  ];
  for (const item of report.items) {
    const suffix = item.reason === '' || item.reason === undefined ? '' : ` — ${item.reason}`;
    lines.push(`  · [${item.action}] ${item.type}/${item.name}${item.target === undefined || item.target === '' ? '' : ` → ${item.target}`}${suffix}`);
  }
  if (report.environment !== null && report.environment !== undefined) {
    const environment = report.environment;
    lines.push(
      '',
      `Переменные окружения (User scope): записано ${environment.written.length}, ошибок ${environment.failed.length}.`,
      `Временный файл со значениями удалён: ${environment.payloadDeleted === true ? 'да' : 'НЕТ — это утечка, разберитесь вручную'}`,
      `Проверка по списку User-scope: ${environment.verified === true ? 'переменные на месте' : 'НЕ пройдена'}`,
      'Значения секретов не выводились и в отчёт не попали; чтобы новые переменные увидел DSH, нужен перезапуск.',
    );
    if (environment.error !== '') lines.push(`Ошибка записи окружения: ${environment.error}`);
  }
  if (report.writeback !== null && report.writeback !== undefined) {
    const writeback = report.writeback;
    lines.push('', `Профиль: ${writeback.path}`, `Бэкап: ${writeback.backupPath === '' ? 'не создавался (запись не выполнялась)' : writeback.backupPath}`);
    if (writeback.fragment !== '') lines.push('', 'Добавленный фрагмент:', writeback.fragment);
    if (writeback.error !== '' && writeback.error !== undefined) lines.push(`Ошибка записи: ${writeback.error}`);
  }
  return lines.join('\n');
}

/** Render the session ledger. */
function renderLedger(result) {
  const lines = [`Импортировано сессий: ${result.total}`];
  for (const [source, count] of Object.entries(result.bySource)) lines.push(`- ${source}: ${count}`);
  for (const entry of result.entries ?? []) {
    lines.push(`- ${formatTime(entry.importedAt)} · ${entry.source} → ${entry.sessionId} · "${entry.title}"`);
  }
  return lines.join('\n');
}

/** What the panel tells the owner once a run has settled. */
const REFRESH_HINT = 'Сессии появятся в списке после перезагрузки плагинов (⟳) или перезапуска DSH.';

/** Project counters of one run: «в проект X импортировано N сессий». */
function projectsOf(run) {
  const map = new Map();
  for (const item of run.items) {
    if (item.status !== 'done') continue;
    const path = String(item.workspacePath ?? item.cwd ?? '');
    const key = path === '' ? '(проект не записан)' : path;
    const entry = map.get(key) ?? {
      path: key,
      title: path === '' ? '(проект не записан)' : path.split(/[\\/]+/u).filter((part) => part !== '').at(-1) ?? path,
      imported: 0,
    };
    entry.imported += 1;
    map.set(key, entry);
  }
  return [...map.values()];
}

/** Whether the finished run needs the «перезагрузите плагины ⟳ / перезапустите DSH» note. */
function hintOf(run) {
  const touched = run.summary.imported + run.summary.reimported + run.summary.already;
  return touched > 0 ? { needed: true, text: REFRESH_HINT, refreshAttempted: false } : { needed: false, text: '', refreshAttempted: false };
}

/** Apply one progress stage reported by the importer onto the current run item. */
function stagePatch(stage, data, current) {
  if (stage === 'writing') {
    return { status: 'running', stage, messages: Number.isFinite(data.messages) ? data.messages : current.messages, events: Number.isFinite(data.total) ? data.total : current.events };
  }
  const patch = { status: 'running', stage };
  if (typeof data.title === 'string' && data.title !== '') patch.title = data.title;
  if (Number.isFinite(data.messages)) patch.messages = data.messages;
  if (Number.isFinite(data.turns)) patch.turns = data.turns;
  if (Number.isFinite(data.events)) patch.events = data.events;
  if (Array.isArray(data.warnings)) patch.warnings = data.warnings.map(String);
  return patch;
}

/** Run one batch import, feeding the run registry item by item. */
async function runImportBatch(run, operations, items, options = {}) {
  try {
    const answer = await operations.importBatch(items, {
      force: options.force === true,
      includeSubagents: options.includeSubagents === true,
      hooks: {
        onItemStart(index) {
          updateRunItem(run, index, { status: 'running', stage: 'reading' });
        },
        onStage(index, stage, data) {
          const item = run.items[index];
          if (item === undefined) return;
          if (stage === 'writing') {
            updateRunItem(run, index, stagePatch(stage, data, item));
            updateWriteProgress(run, index, Number(data.written) || 0, Number(data.total) || 0);
            return;
          }
          updateRunItem(run, index, stagePatch(stage, data, item));
        },
        onItemDone(index, result) {
          if (result.status === 'failed') {
            updateRunItem(run, index, { status: 'failed', stage: 'failed', error: String(result.error ?? 'импорт не удался') });
            return;
          }
          if (result.status === 'already-imported') {
            updateRunItem(run, index, {
              status: 'skipped',
              stage: 'already',
              title: String(result.title ?? ''),
              sessionId: String(result.sessionId ?? ''),
              verified: true,
            });
            return;
          }
          updateRunItem(run, index, {
            status: 'done',
            stage: 'done',
            title: String(result.title ?? ''),
            sessionId: String(result.sessionId ?? ''),
            cwd: String(result.cwd ?? ''),
            workspacePath: String(result.workspacePath ?? ''),
            messages: Number.isFinite(result.foreignMessageCount) ? result.foreignMessageCount : run.items[index].messages,
            turns: Number.isFinite(result.turnCount) ? result.turnCount : 0,
            events: Number.isFinite(result.eventCount) ? result.eventCount : 0,
            verified: result.verified === true,
            warnings: Array.isArray(result.warnings) ? result.warnings.map(String) : [],
          });
        },
      },
    });
    const nothingLanded = answer.summary.imported === 0 && answer.summary.already === 0;
    finishRun(run, {
      status: nothingLanded && answer.summary.failed > 0 ? 'failed' : 'done',
      summary: {
        imported: answer.summary.imported,
        already: answer.summary.already,
        skipped: answer.summary.already,
        failed: answer.summary.failed,
        reimported: 0,
      },
      projects: projectsOf(run),
      hint: hintOf(run),
    });
  } catch (error) {
    finishRun(run, {
      status: 'failed',
      summary: { failed: run.total },
      projects: projectsOf(run),
      hint: { needed: false, text: 'Импорт остановлен: ' + String(error?.message ?? error), refreshAttempted: false },
    });
  }
  return snapshot(run);
}

/** Run one re-import, feeding the run registry its stages. */
async function runReimports(run, operations, items, options = {}) {
  try {
    const item = items[0];
    updateRunItem(run, 0, { status: 'running', stage: 'deleting' });
    const report = await operations.reimport(
      { source: item.source, id: item.id, path: item.path },
      {
        mode: options.mode === 'replace' ? 'replace' : 'copy',
        includeSubagents: options.includeSubagents === true,
        onProgress: (stage, data) => {
          const current = run.items[0];
          updateRunItem(run, 0, stagePatch(stage === 'done' ? 'reimporting' : stage, data ?? {}, current));
        },
      },
    );
    const ok = report.status === 'reimported' || report.status === 'reimported-existing';
    const warnings = [...(Array.isArray(report.warnings) ? report.warnings : []), ...(Array.isArray(report.report?.warnings) ? report.report.warnings : [])];
    updateRunItem(run, 0, {
      status: ok ? 'done' : 'failed',
      stage: ok ? 'done' : 'failed',
      mode: report.mode === 'replace' ? 'replace' : 'copy',
      previousSessionId: String(report.previousSessionId ?? ''),
      archived: report.archived === true,
      archiveReason: String(report.archiveReason ?? ''),
      title: String(report.report?.title ?? item.title ?? ''),
      sessionId: String(report.sessionId ?? ''),
      cwd: String(report.report?.cwd ?? ''),
      workspacePath: String(report.report?.workspacePath ?? ''),
      turns: Number.isFinite(report.report?.turnCount) ? report.report.turnCount : 0,
      events: Number.isFinite(report.report?.eventCount) ? report.report.eventCount : 0,
      verified: report.report?.verified === true,
      warnings: warnings.map(String),
      error: ok ? '' : String(report.report?.verifyError ?? 'переимпорт не удался'),
    });
    run.summary.reimported = ok ? 1 : 0;
    run.summary.failed = ok ? 0 : 1;
    finishRun(run, { status: ok ? 'done' : 'failed', projects: projectsOf(run), hint: hintOf(run) });
  } catch (error) {
    updateRunItem(run, 0, { status: 'failed', stage: 'failed', error: String(error?.message ?? error) });
    finishRun(run, {
      status: 'failed',
      summary: { failed: 1, imported: 0, reimported: 0, already: 0, skipped: 0 },
      projects: projectsOf(run),
      hint: { needed: false, text: 'Переимпорт остановлен: ' + String(error?.message ?? error), refreshAttempted: false },
    });
  }
  return snapshot(run);
}

/**
 * Start a run in the background and answer the browser with its id.
 *
 * The initial snapshot is taken BEFORE the work starts, so the browser always
 * sees «в очереди» first and the bar grows from zero; wait=1 is for tests and
 * scripts that want the settled report in one request.
 */
async function startRun(response, run, makeWork, wait) {
  if (wait === true) {
    const result = await makeWork();
    respondJson(response, { runId: run.id, run: result, statusRoute: ROUTES.sessionsRunStatus, pollMs: 400 });
    return;
  }
  respondJson(response, { runId: run.id, run: snapshot(run), statusRoute: ROUTES.sessionsRunStatus, pollMs: 400 });
  void makeWork().catch(() => {});
}

/** Register the session routes of the `/dsh-migrate/sessions/*` layer. */
function registerSessionRoutes(server, guard, requireMethod, operations, disposers) {
  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.sessionsTree,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        const url = new URL(request.url ?? ROUTES.sessionsTree, 'http://localhost');
        respondJson(
          response,
          await operations.tree({
            query: url.searchParams.get('query') ?? '',
            sources: url.searchParams.getAll('source'),
            perProject: Number(url.searchParams.get('perProject') ?? 60),
            includeChildren: url.searchParams.get('includeChildren') === '1',
            perSourceLimit: Number(url.searchParams.get('perSourceLimit') ?? 500),
            fresh: url.searchParams.get('fresh') === '1',
          }),
        );
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.sessionsRun,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        const body = await readJsonBody(request);
        if (body === undefined || !Array.isArray(body.items)) {
          respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"items": [{"source": "...", "id": "..."}], "includeSubagents": false}');
          return;
        }
        const url = new URL(request.url ?? ROUTES.sessionsRun, 'http://localhost');
        const items = normalizeSessionItems(body.items);
        if (items.length === 0) {
          respondError(response, 400, 'BAD_ARGUMENT', 'body must name at least one {source, id} item');
          return;
        }
        const run = createRun({ kind: 'import', items });
        await startRun(
          response,
          run,
          () => runImportBatch(run, operations, items, {
            force: body.force === true,
            includeSubagents: body.includeSubagents === true,
          }),
          url.searchParams.get('wait') === '1',
        );
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.sessionsImport,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        const body = await readJsonBody(request);
        if (body === undefined || typeof body.source !== 'string' || typeof body.id !== 'string') {
          respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"source": "...", "id": "..."}');
          return;
        }
        const url = new URL(request.url ?? ROUTES.sessionsImport, 'http://localhost');
        const items = [{ source: body.source, id: body.id, path: typeof body.path === 'string' ? body.path : '' }];
        const run = createRun({ kind: 'import', items });
        const work = runImportBatch(run, operations, items, {
          force: body.force === true,
          includeSubagents: body.includeSubagents === true,
        });
        await startRun(response, run, work, url.searchParams.get('wait') === '1');
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.sessionsReimport,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        const body = await readJsonBody(request);
        if (body === undefined || typeof body.source !== 'string' || typeof body.id !== 'string') {
          respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"source": "...", "id": "...", "confirm": true}');
          return;
        }
        const mode = body.mode === 'replace' ? 'replace' : 'copy';
        if (mode === 'replace' && body.confirm !== true) {
          respondError(response, 400, 'CONFIRMATION_REQUIRED', 'mode=replace deletes the imported copy first; send confirm:true after the owner agreed');
          return;
        }
        const url = new URL(request.url ?? ROUTES.sessionsReimport, 'http://localhost');
        const items = [
          {
            source: body.source,
            id: body.id,
            path: typeof body.path === 'string' ? body.path : '',
            title: typeof body.title === 'string' ? body.title : '',
            mode,
          },
        ];
        const run = createRun({ kind: 'reimport', items });
        await startRun(
          response,
          run,
          () => runReimports(run, operations, items, { includeSubagents: body.includeSubagents === true, mode }),
          url.searchParams.get('wait') === '1',
        );
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.sessionsUpdate,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        const body = await readJsonBody(request);
        if (body === undefined || typeof body.source !== 'string' || typeof body.id !== 'string') {
          respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"source": "...", "id": "..."}');
          return;
        }
        respondJson(response, await operations.update({ source: body.source, id: body.id, path: typeof body.path === 'string' ? body.path : undefined }));
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.sessionsRunStatus,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        const url = new URL(request.url ?? ROUTES.sessionsRunStatus, 'http://localhost');
        const id = url.searchParams.get('run') ?? '';
        const run = id === '' ? latestRun() : getRun(id);
        if (run === undefined) {
          respondError(response, 404, 'RUN_NOT_FOUND', 'this run is unknown; start an import and poll the id it returned');
          return;
        }
        respondJson(response, { run: snapshot(run), pollMs: 400 });
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.sessionsAttach,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        const body = await readJsonBody(request);
        if (body === undefined || !Array.isArray(body.sessionIds)) {
          respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"sessionIds": ["session-...", ...]}');
          return;
        }
        if (body.sessionIds.length === 0 || body.sessionIds.length > 200 || body.sessionIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
          respondError(response, 400, 'BAD_ARGUMENT', 'attach accepts 1..200 non-empty session ids');
          return;
        }
        respondJson(response, await operations.attach(body.sessionIds.map((id) => id.trim())));
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.sessionsRepairWatermark,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        const body = await readJsonBody(request, 64 * 1024);
        if (body === undefined || typeof body !== 'object') {
          respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"sessionIds": [...]}, {"entryIds": ["source:id"]} or {} for every row without a watermark');
          return;
        }
        const ids = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '') : undefined);
        const sessionIds = ids(body.sessionIds);
        const entryIds = ids(body.entryIds);
        if ((body.sessionIds !== undefined && sessionIds === undefined) || (body.entryIds !== undefined && entryIds === undefined)) {
          respondError(response, 400, 'BAD_ARGUMENT', 'sessionIds/entryIds must be arrays of non-empty strings');
          return;
        }
        if ((sessionIds?.length ?? 0) > 200 || (entryIds?.length ?? 0) > 200) {
          respondError(response, 400, 'BAD_ARGUMENT', 'at most 200 ids per call');
          return;
        }
        respondJson(response, await operations.repairWatermarks({ sessionIds, entryIds, refs: Array.isArray(body.refs) ? body.refs : undefined }));
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.sessionsStatus,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        respondJson(response, {
          ledger: operations.ledger(),
          ui: await operations.uiDiagnostics(),
          latestRun: snapshot(latestRun()),
          generatedAt: Date.now(),
          generatedAtText: formatTime(Date.now()),
        });
      }),
    }),
  );
}

/** Register the asset routes of the `/dsh-migrate/assets/*` layer. */
function registerAssetRoutes(server, guard, requireMethod, disposers) {
  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.assetsTree,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        const url = new URL(request.url ?? ROUTES.assetsTree, 'http://localhost');
        respondJson(response, await buildTree({ overwriteSecrets: url.searchParams.get('overwriteSecrets') === '1' }));
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.assetsStatus,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        respondJson(response, await buildStatus());
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.assetsRun,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        const body = await readJsonBody(request);
        if (body === undefined || !Array.isArray(body.items)) {
          respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"items": [{"type": "...", "source": "...", "name": "..."}], "dryRun": false, "overwriteSecrets": false}');
          return;
        }
        respondJson(
          response,
          await runImport(normalizeItems(body.items), {
            dryRun: body.dryRun === true,
            overwriteSecrets: body.overwriteSecrets === true,
          }),
        );
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.assetsPreview,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'POST')) return;
        const body = await readJsonBody(request);
        if (body === undefined || !Array.isArray(body.items)) {
          respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"items": [{"type": "...", "source": "...", "name": "..."}], "overwriteSecrets": false}');
          return;
        }
        respondJson(response, await previewImport(normalizeItems(body.items), { overwriteSecrets: body.overwriteSecrets === true }));
      }),
    }),
  );

  disposers.push(
    server.register({
      kind: 'exact',
      path: ROUTES.assetsInstruction,
      handler: guard(async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return;
        const url = new URL(request.url ?? ROUTES.assetsInstruction, 'http://localhost');
        const id = url.searchParams.get('id') ?? '';
        if (id === '') {
          respondError(response, 400, 'BAD_ARGUMENT', 'query must be ?id=<instruction id>');
          return;
        }
        respondJson(response, await instructionContent(id));
      }),
    }),
  );
}

/**
 * Install the plugin.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx) {
  const operations = createOperations(ctx);

  /* ------------------------------------------------------------- web routes */

  const installRoutes = (webCtx) => {
    const server = webCtx.webServer;
    webCtx.effect(() => {
      const disposers = [];
      const guard = (handler) => async (request, response) => {
        if (!sameOrigin(request)) {
          respondError(response, 403, 'NOT_OWNER', 'this route is served to the DSH GUI only.');
          return;
        }
        try {
          await handler(request, response);
        } catch (error) {
          respondError(response, 500, 'MIGRATE_FAILED', error?.message ?? String(error));
        }
      };
      const requireMethod = (request, response, method) => {
        if (request.method === method) return true;
        response.writeHead(405, { 'cache-control': 'no-store' });
        response.end();
        return false;
      };

      registerSessionRoutes(server, guard, requireMethod, operations, disposers);
      registerAssetRoutes(server, guard, requireMethod, disposers);

      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* a route already gone */
          }
        }
      };
    });
  };

  // `webServer` is declared in `inject`, so the service is published before this
  // runs; `ctx.inject` stays as a fallback for a composition that publishes the
  // carrier later.
  const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (server !== undefined && typeof server.register === 'function') {
    installRoutes({ webServer: server, effect: (callback) => ctx.effect(callback) });
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], installRoutes);
  }

  /* ----------------------------------------------------------------- tools */

  ctx.tools.register({
    name: 'dsh_migrate_sessions',
    description:
      'Discover and import sessions from other coding agents into DSH — the «Сессии» layer of the dsh-migrate plugin. Sources: ' +
      'Claude Code, Codex, ZCode (CLI and v2), KiloCode, OpenCode. `scan` lists sessions and projects; `search` filters them; ' +
      '`import` migrates one session into a native DSH session that keeps its name, project, history and tool log and can be ' +
      'continued in DSH afterwards; `update` appends what appeared in the origin since the import; `verify` reads an imported ' +
      'session back through the DSH session query layer; `continue` resumes it and sends one prompt (spends a model request); ' +
      '`ledger` shows what was already imported; `ui` reports whether the browser half reached the page manifest. Foreign ' +
      'stores are only read, never modified.',
    parameters: {
      action: {
        type: 'string',
        enum: ['scan', 'search', 'import', 'update', 'reimport', 'attach', 'repair_watermark', 'verify', 'continue', 'ledger', 'ui'],
        description: 'Operation to run. Defaults to `scan`.',
        required: true,
      },
      source: {
        type: 'string',
        enum: ['claude-code', 'codex', 'zcode-cli', 'zcode-v2', 'kilo', 'opencode'],
        description: 'Source agent; required for `import`, optional as a filter for `scan`/`search`.',
      },
      id: { type: 'string', description: 'Foreign session id, exactly as `scan`/`search` returned it. Required for `import`.' },
      sessionId: { type: 'string', description: 'DSH session id returned by `import`; read it back with `verify`.' },
      sessionIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'For `attach`/`repair_watermark`: stored session ids (attach: put into the workspace of their cwd; repair: ledger rows to prove and stamp).',
      },
      entryIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'For `repair_watermark`: ledger keys `source:foreignId`; omit both lists to repair every row without a watermark.',
      },
      mode: {
        type: 'string',
        enum: ['copy', 'replace'],
        description: 'For `reimport`: `copy` (default) imports a new session and archives the old one; `replace` deletes the old copy first (destructive).',
      },
      prompt: { type: 'string', description: 'Prompt for `continue`: sends this text into the imported session (one model request).' },
      path: { type: 'string', description: 'Foreign session file or database path when the row carried one; helps `import` resolve the record.' },
      query: { type: 'string', description: 'Free-text filter over session names and project paths for `search`.' },
      limit: { type: 'number', description: 'Page size for `scan`/`search` (default 50, max 500).' },
      offset: { type: 'number', description: 'Page offset for `scan`/`search`.' },
      force: { type: 'boolean', description: 'Re-import even when the ledger already records this foreign session.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'text'],
        properties: {
          action: { type: 'string' },
          text: { type: 'string' },
          data: { type: 'object' },
        },
      },
      render: (_args, value) => asText(value.text),
    },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'scan';
      const sources = typeof args?.source === 'string' && args.source !== '' ? [args.source] : undefined;

      if (action === 'scan') {
        const result = await operations.scan({ limit: args?.limit, offset: args?.offset, sources });
        return { action, text: renderInventory(result), data: { sources: result.sources, ledger: result.ledger } };
      }
      if (action === 'search') {
        const result = await operations.search(args?.query ?? '', { limit: args?.limit, sources });
        return { action, text: renderInventory(result), data: { sources: result.sources } };
      }
      if (action === 'import') {
        if (typeof args?.source !== 'string' || typeof args?.id !== 'string') {
          throw new Error('import needs `source` and `id` (take them from scan/search output)');
        }
        const report = await operations.import(
          { source: args.source, id: args.id, path: typeof args.path === 'string' ? args.path : undefined },
          { force: args?.force === true },
        );
        return { action, text: renderImport(report), data: report };
      }
      if (action === 'update') {
        if (typeof args?.source !== 'string' || typeof args?.id !== 'string') {
          throw new Error('update needs `source` and `id` (take them from scan/search output)');
        }
        const report = await operations.update({ source: args.source, id: args.id, path: typeof args.path === 'string' ? args.path : undefined });
        const lines = [
          `Обновление ${report.sessionId}: ${report.status}.`,
          `Добавлено сообщений: ${report.addedMessages ?? 0}, ходов: ${report.addedTurns ?? 0}.`,
          `Проверка чтением: ${report.verified === true ? 'успешно' : 'не пройдена'}.`,
        ];
        if (Array.isArray(report.warnings)) for (const warning of report.warnings) lines.push(`- ${warning}`);
        return { action, text: lines.join('\n'), data: report };
      }
      if (action === 'repair_watermark') {
        const result = await operations.repairWatermarks({
          sessionIds: Array.isArray(args?.sessionIds) ? args.sessionIds.map(String) : undefined,
          entryIds: Array.isArray(args?.entryIds) ? args.entryIds.map(String) : undefined,
        });
        const lines = [
          `Восстановление отметок: восстановлено ${result.summary.repaired}, расхождений ${result.summary.diverged}, ошибок ${result.summary.failed}.`,
        ];
        for (const item of result.items) {
          const reason = item.reason === '' ? '' : ` — ${item.reason}`;
          lines.push(`- ${item.sessionId}: ${item.status} (совпало ${item.matchedMessages} из ${item.copiedMessages}, в источнике ${item.sourceMessages})${reason}`);
        }
        return { action, text: lines.join('\n'), data: result };
      }
      if (action === 'attach') {
        const sessionIds = Array.isArray(args?.sessionIds)
          ? args.sessionIds.map(String).filter((id) => id !== '')
          : typeof args?.sessionId === 'string' && args.sessionId !== ''
            ? [args.sessionId]
            : [];
        if (sessionIds.length === 0) throw new Error('attach needs `sessionIds`: the stored session ids to put into their project workspace');
        const result = await operations.attach(sessionIds);
        const lines = [
          `Привязка к проектам: привязано ${result.summary.attached}, уже привязано ${result.summary.already}, ошибок ${result.summary.failed}.`,
        ];
        for (const item of result.items) {
          const suffix = item.workspaceTitle === '' ? '' : ` → ${item.workspaceTitle}`;
          const reason = item.reason === '' ? '' : ` (${item.reason})`;
          lines.push(`- ${item.sessionId}: ${item.status}${suffix}${reason}`);
        }
        return { action, text: lines.join('\n'), data: result };
      }
      if (action === 'reimport') {
        if (typeof args?.source !== 'string' || typeof args?.id !== 'string') {
          throw new Error('reimport needs `source` and `id` (take them from scan/search output)');
        }
        const report = await operations.reimport(
          { source: args.source, id: args.id, path: typeof args.path === 'string' ? args.path : undefined },
          { mode: args?.mode === 'replace' ? 'replace' : 'copy' },
        );
        const lines = [
          `Переимпорт ${report.sessionId}: ${report.deleted === true ? 'старая копия удалена' : 'старой копии на диске не было'}.`,
          `Сообщений/ходов в новой копии: ${report.report?.turnCount ?? 0} ходов.`,
          `Проверка чтением: ${report.report?.verified === true ? 'успешно' : 'не пройдена'}.`,
        ];
        if (Array.isArray(report.warnings)) for (const warning of report.warnings) lines.push(`- ${warning}`);
        return { action, text: lines.join('\n'), data: report };
      }
      if (action === 'verify') {
        if (typeof args?.sessionId !== 'string' || args.sessionId === '') {
          throw new Error('verify needs `sessionId` (the id import returned)');
        }
        const report = await operations.verify(args.sessionId);
        const lines = [
          `Сессия ${report.sessionId} читается слоем запросов DSH.`,
          `Имя: ${report.title === '' ? '(без имени)' : report.title}`,
          `Проект: ${report.cwd === '' ? '(не записан)' : report.cwd}`,
          `Событий: ${report.eventCount}, ходов: ${report.turnCount}.`,
          `В списке сессий DSH: ${report.listed === true ? 'да' : 'нет (проверьте проект/перезапуск)'}.`,
        ];
        return { action, text: lines.join('\n'), data: report };
      }
      if (action === 'continue') {
        if (typeof args?.sessionId !== 'string' || args.sessionId === '') {
          throw new Error('continue needs `sessionId` (the id import returned)');
        }
        if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') {
          throw new Error('continue needs `prompt`: the text to send into the imported session');
        }
        const report = await operations.continueSession(args.sessionId, args.prompt);
        const lines = [
          `Сессия ${report.sessionId}: ${report.appended === true ? 'продолжена' : 'принята, но новых событий не появилось'}.`,
          `Событий было ${report.beforeEventCount}, стало ${report.afterEventCount}.`,
        ];
        if (report.reply !== '') lines.push('', `Ответ модели: ${report.reply}`);
        else lines.push('', 'Ответа в логе пока нет; проверьте сессию в UI.');
        return { action, text: lines.join('\n'), data: report };
      }
      if (action === 'ui') {
        const report = await operations.uiDiagnostics();
        const lines = [
          `Клиентская половина (${report.packageName}): ${report.registered ? 'зарегистрирована в манифесте клиентских модулей' : 'НЕ зарегистрирована'}.`,
          `Бандл: ${report.bundleUrl === '' ? report.clientPath === '' ? '—' : report.clientPath : report.bundleUrl}`,
          `Записей в манифесте: ${report.entries}.`,
          `Рекомендация: ${report.reason}`,
        ];
        return { action, text: lines.join('\n'), data: report };
      }
      if (action === 'ledger') {
        const result = operations.ledger();
        return { action, text: renderLedger(result), data: { total: result.total, bySource: result.bySource } };
      }
      throw new Error(`unknown action "${action}"; use scan, search, import, update, reimport, attach, repair_watermark, verify, continue, ledger or ui`);
    },
  });

  ctx.tools.register({
    name: 'dsh_migrate_assets',
    description:
      'Inventory and import skills, MCP servers, secrets, plugins and instruction documents from Claude Code, Codex, ZCode, ' +
      'KiloCode and OpenCode into DSH — the «Ассеты» layer of the dsh-migrate plugin. `tree` lists every source/type/item with ' +
      'its target and status (new / already-there / would-update); `preview` returns the exact YAML fragment a selection would ' +
      'append to the profile patch and the NAMES of the secrets it would write, and writes nothing; `run` performs the import — ' +
      'skill directories are copied into <DSH_HOME>/skills, instruction documents are copied masked into ' +
      '<DSH_HOME>/dsh-migrate/instructions, selected MCP servers are appended to the profile patch AFTER a profile snapshot, and ' +
      'selected secrets are written into the Windows USER environment through a temporary ACL-restricted file (never on argv) — ' +
      'all idempotently; `status` shows the ledger; `read_instruction` returns one document with every credential masked. Secret ' +
      'VALUES are never returned, logged or echoed: rows carry only the name, the origin and the value length. A DSH restart is ' +
      'required for new MCP rows and new environment variables to take effect.',
    parameters: {
      action: {
        type: 'string',
        enum: ['tree', 'preview', 'run', 'status', 'read_instruction'],
        description: 'Operation to run. Defaults to `tree`.',
        required: true,
      },
      items: {
        type: 'array',
        description:
          'Selection for `preview`/`run`: objects `{ type, source, name }` exactly as `tree` printed them ' +
          '(type is one of skills, mcp, secrets, plugins, instructions).',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            source: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
      dryRun: { type: 'boolean', description: 'For `run`: report what would happen and write nothing.' },
      overwrite: {
        type: 'boolean',
        description:
          'For `run`/`preview`: allow rewriting secrets whose variable is already set in the user environment. ' +
          'Without it such rows are skipped.',
      },
      id: { type: 'string', description: 'For `read_instruction`: the document id, e.g. `claude-code:CLAUDE.md`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'text'],
        properties: {
          action: { type: 'string' },
          text: { type: 'string' },
          data: { type: 'object' },
        },
      },
      render: (_args, value) => asText(value.text),
    },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'tree';
      const overwrite = args?.overwrite === true;
      if (action === 'tree') {
        const tree = await buildTree({ overwriteSecrets: overwrite });
        return {
          action,
          text: renderTree(tree),
          data: { totals: tree.totals, sources: tree.sources.map((source) => ({ id: source.id, label: source.label, counts: source.counts })), targets: tree.targets },
        };
      }
      if (action === 'status') {
        const status = await buildStatus();
        const lines = [
          `Импортировано элементов по журналу: ${status.ledger.total}`,
          `Патч профиля: ${status.profile.path} (настроено MCP: ${status.profile.configured})`,
          `Цель скилов: ${status.targets.skills}`,
          `Журнал: ${status.targets.ledger}`,
        ];
        return { action, text: lines.join('\n'), data: status };
      }
      if (action === 'read_instruction') {
        const read = await instructionContent(args?.id);
        if (read.ok !== true) throw new Error(read.error ?? 'документ не читается');
        const lines = [`${read.label} — ${read.path}`, read.note, read.truncated ? 'Показаны первые 256 КиБ.' : '', '', read.content];
        return { action, text: lines.filter((line) => line !== '').join('\n'), data: { id: read.id, path: read.path, chars: read.content.length, masked: read.masked } };
      }
      if (action !== 'preview' && action !== 'run') {
        throw new Error(`unknown action "${action}"; use tree, preview, run, status or read_instruction`);
      }
      const items = normalizeItems(args?.items);
      if (items.length === 0) {
        throw new Error('preview/run needs `items`: take them from action=tree (type, source, name)');
      }
      if (action === 'preview') {
        const preview = await previewImport(items, { overwriteSecrets: overwrite });
        return {
          action,
          text: [preview.note, preview.yaml === '' ? '' : 'YAML:', preview.yaml, ...preview.warnings.map((warning) => `⚠ ${warning}`)].filter((line) => line !== '').join('\n'),
          data: preview,
        };
      }
      const report = await runImport(items, { dryRun: args?.dryRun === true, overwriteSecrets: overwrite });
      return { action, text: renderReport(report), data: report };
    },
  });
}
