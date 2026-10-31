/**
 * Agent Import — Host half.
 *
 * Two callers, one implementation: the `agent_import` tool serves the model and
 * the same-origin routes serve the browser panel, and both go through
 * `createOperations(ctx)`. Nothing here writes to a foreign agent store; imports
 * land in the DSH session store through the Host persistence service.
 */
import { createOperations } from './lib/api.js';

/** Plugin name shown in the profile. */
export const name = 'agent-import';

/** Services this half needs before it activates. */
export const inject = ['tools', 'webServer'];

/** Browser-facing routes, all same-origin. */
const ROUTES = {
  inventory: '/agent-import/inventory',
  tree: '/agent-import/tree',
  ui: '/agent-import/ui',
  importOne: '/agent-import/import',
  importBatch: '/agent-import/import-batch',
  update: '/agent-import/update',
  reimport: '/agent-import/reimport',
  ledger: '/agent-import/ledger',
  assets: '/agent-import/assets',
  mcpPlan: '/agent-import/mcp-plan',
  skills: '/agent-import/skills',
  verify: '/agent-import/verify',
  continue: '/agent-import/continue',
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
function readJsonBody(request, limit = 16 * 1024) {
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
  if (result.projects.length > 0) {
    lines.push('', 'Проекты:');
    for (const project of result.projects.slice(0, 20)) {
      lines.push(`- ${project.path}: ${project.sessions} сессий (${project.sources.join(', ')})`);
    }
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

/** Render the asset inventory compactly. */
function renderAssets(result) {
  const lines = ['Ассеты чужих агентов:'];
  const skills = result.skills.items;
  lines.push(`- Скилы: ${skills.length}; уже в DSH: ${skills.filter((skill) => skill.alreadyInDsh).length}`);
  for (const root of result.skills.roots) lines.push(`  · ${root.label}: ${root.available ? `${root.count} (${root.path})` : 'недоступно'}`);
  lines.push(`- Плагины: ${result.plugins.items.length} (перенос рантайма невозможен; переносятся их скилы и MCP)`);
  for (const root of result.plugins.roots) lines.push(`  · ${root.label}: ${root.available ? root.count : 'недоступно'}`);
  lines.push(`- MCP-серверы: ${result.mcp.items.length}, уже настроено: ${result.mcp.items.filter((server) => server.alreadyConfigured).length}`);
  for (const server of result.mcp.items.slice(0, 40)) {
    const kind = server.command !== '' ? 'stdio' : server.url !== '' ? 'http' : 'unknown';
    lines.push(`  · ${server.name} [${server.source}, ${kind}]${server.alreadyConfigured ? ' — уже настроен' : ''}`);
  }
  for (const config of result.configs) lines.push(`- Конфиг ${config.label}: ${config.present ? `${config.sizeBytes} байт (${config.path})` : 'нет'}`);
  return lines.join('\n');
}

/** Render the ledger. */
function renderLedger(result) {
  const lines = [`Импортировано сессий: ${result.total}`];
  for (const [source, count] of Object.entries(result.bySource)) lines.push(`- ${source}: ${count}`);
  for (const entry of result.entries ?? []) {
    lines.push(`- ${formatTime(entry.importedAt)} · ${entry.source} → ${entry.sessionId} · "${entry.title}"`);
  }
  return lines.join('\n');
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
          respondError(response, 500, 'IMPORT_FAILED', error?.message ?? String(error));
        }
      };
      const requireMethod = (request, response, method) => {
        if (request.method === method) return true;
        response.writeHead(405, { 'cache-control': 'no-store' });
        response.end();
        return false;
      };

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.inventory,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'GET')) return;
            const url = new URL(request.url ?? ROUTES.inventory, 'http://localhost');
            const sources = url.searchParams.getAll('source');
            respondJson(
              response,
              await operations.scan({
                limit: Number(url.searchParams.get('limit') ?? 50),
                offset: Number(url.searchParams.get('offset') ?? 0),
                query: url.searchParams.get('query') ?? '',
                sources: sources.length === 0 ? undefined : sources,
              }),
            );
          }),
        }),
      );

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.tree,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'GET')) return;
            const url = new URL(request.url ?? ROUTES.tree, 'http://localhost');
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
          path: ROUTES.ui,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'GET')) return;
            respondJson(response, await operations.uiDiagnostics());
          }),
        }),
      );

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.update,
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
          path: ROUTES.reimport,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'POST')) return;
            const body = await readJsonBody(request);
            if (body === undefined || typeof body.source !== 'string' || typeof body.id !== 'string') {
              respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"source": "...", "id": "...", "includeSubagents"?: true, "confirm"?: true}');
              return;
            }
            if (body.confirm !== true) {
              // Rebuilding creates a second copy and archives the first, so it is never implicit.
              respondError(response, 409, 'CONFIRM_REQUIRED', 'reimport создаст новую копию и отправит прежнюю в архив; передайте "confirm": true');
              return;
            }
            respondJson(
              response,
              await operations.reimport({
                source: body.source,
                id: body.id,
                path: typeof body.path === 'string' ? body.path : undefined,
                includeSubagents: body.includeSubagents === true,
              }),
            );
          }),
        }),
      );
      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.importBatch,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'POST')) return;
            const body = await readJsonBody(request, 256 * 1024);
            if (body === undefined || !Array.isArray(body.items)) {
              respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"items": [{"source": "...", "id": "..."}]}');
              return;
            }
            respondJson(response, await operations.importBatch(body.items, { force: body.force === true, includeSubagents: body.includeSubagents === true }));
          }),
        }),
      );

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.importOne,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'POST')) return;
            const body = await readJsonBody(request);
            if (body === undefined || typeof body.source !== 'string' || typeof body.id !== 'string') {
              respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"source": "...", "id": "..."}');
              return;
            }
            const report = await operations.import(
              { source: body.source, id: body.id, path: typeof body.path === 'string' ? body.path : undefined },
              { force: body.force === true, includeSubagents: body.includeSubagents === true },
            );
            respondJson(response, report);
          }),
        }),
      );

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.ledger,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'GET')) return;
            respondJson(response, operations.ledger());
          }),
        }),
      );

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.assets,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'GET')) return;
            respondJson(response, await operations.assets());
          }),
        }),
      );

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.mcpPlan,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'POST')) return;
            respondJson(response, await operations.writeMcpPlan());
          }),
        }),
      );

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.skills,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'POST')) return;
            const body = await readJsonBody(request);
            if (body === undefined || !Array.isArray(body.names)) {
              respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"names": ["skill", ...]}');
              return;
            }
            respondJson(response, await operations.copySkills(body.names));
          }),
        }),
      );

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.verify,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'POST')) return;
            const body = await readJsonBody(request);
            if (body === undefined || typeof body.sessionId !== 'string') {
              respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"sessionId": "..."}');
              return;
            }
            respondJson(response, await operations.verify(body.sessionId));
          }),
        }),
      );

      disposers.push(
        server.register({
          kind: 'exact',
          path: ROUTES.continue,
          handler: guard(async (request, response) => {
            if (!requireMethod(request, response, 'POST')) return;
            const body = await readJsonBody(request);
            if (body === undefined || typeof body.sessionId !== 'string' || typeof body.prompt !== 'string') {
              respondError(response, 400, 'BAD_ARGUMENT', 'body must be {"sessionId": "...", "prompt": "..."}');
              return;
            }
            respondJson(response, await operations.continueSession(body.sessionId, body.prompt));
          }),
        }),
      );

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

  // With `webServer` declared in `inject` the service is published before this
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
    name: 'agent_import',
    description:
      'Discover and import sessions from other coding agents into DSH. Sources: Claude Code, Codex, ZCode (CLI and v2), ' +
      'KiloCode, OpenCode. `scan` lists sessions and projects; `search` filters them; `import` migrates one session into ' +
      'a native DSH session that keeps its name, project, history and tool log, and can be continued in DSH afterwards; ' +
      '`verify` reads an imported session back through the DSH session query layer; ' +
      '`continue` resumes an imported session and sends one prompt into it (spends a model request); ' +
      '`ledger` shows what was already imported; `assets` inventories skills, plugins, MCP servers and configs; ' +
      '`mcp_plan` writes a ready-to-paste profile fragment for the detected MCP servers; `copy_skills` copies foreign ' +
      'skills into the DSH skill root. Foreign stores are only read, never modified.',
    parameters: {
      action: {
        type: 'string',
        enum: ['scan', 'search', 'import', 'update', 'reimport', 'verify', 'continue', 'ledger', 'assets', 'mcp_plan', 'copy_skills', 'ui'],
        description: 'Operation to run. Defaults to `scan`.',
        required: true,
      },
      source: {
        type: 'string',
        enum: ['claude-code', 'codex', 'zcode-cli', 'zcode-v2', 'kilo', 'opencode'],
        description: 'Source agent; required for `import`, optional as a filter for `scan`/`search`.',
      },
      id: { type: 'string', description: 'Foreign session id, exactly as `scan`/`search` returned it. Required for `import`.' },
      sessionId: {
        type: 'string',
        description: 'DSH session id returned by `import`; read it back through the DSH session query layer with `verify`.',
      },
      prompt: {
        type: 'string',
        description: 'Prompt for `continue`: resumes the imported session and sends this text, spending one model request.',
      },
      path: { type: 'string', description: 'Foreign session file or database path when the row carried one; helps `import` resolve the record.' },
      query: { type: 'string', description: 'Free-text filter over session names and project paths for `search`.' },
      limit: { type: 'number', description: 'Page size for `scan`/`search` (default 50, max 500).' },
      offset: { type: 'number', description: 'Page offset for `scan`/`search`.' },
      names: {
        type: 'array',
        description: 'Skill names to copy for `copy_skills`.',
        items: { type: 'string' },
      },
      force: {
        type: 'boolean',
        description: 'Re-import even when the ledger already records this foreign session (rarely needed).',
      },
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
      if (action === 'reimport') {
        if (typeof args?.source !== 'string' || typeof args?.id !== 'string') {
          throw new Error('reimport needs `source` and `id` (take them from scan/search output)');
        }
        const report = await operations.reimport({
          source: args.source,
          id: args.id,
          path: typeof args.path === 'string' ? args.path : undefined,
          includeSubagents: args.includeSubagents === true,
        });
        const lines = [
          `Переимпорт ${report.sessionId}: ${report.status}.`,
          report.rebuilt === true ? 'Копия собрана заново из источника.' : 'Копия не тронута.',
        ];
        if (Array.isArray(report.warnings)) for (const warning of report.warnings) lines.push(`- ${warning}`);
        return { action, text: lines.join('\n'), data: report };
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
          `Клиентская половина (${report.packageName}): ${report.registered ? 'зарегистрирована в манифесте страницы' : 'НЕ зарегистрирована'}.`,
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
      if (action === 'assets') {
        const result = await operations.assets();
        return {
          action,
          text: renderAssets(result),
          data: {
            skills: result.skills.roots,
            plugins: result.plugins.roots,
            mcp: result.mcp.items.map((server) => ({ name: server.name, source: server.source, alreadyConfigured: server.alreadyConfigured })),
            configs: result.configs.map((config) => ({ label: config.label, present: config.present, path: config.path })),
          },
        };
      }
      if (action === 'mcp_plan') {
        const result = await operations.writeMcpPlan();
        return {
          action,
          text: `MCP-предложение записано: ${result.path} (${result.count} новых серверов${result.rows.length === 0 ? '' : `: ${result.rows.join(', ')}`}). Строки профиля плагин не правит — вставьте фрагмент вручную.`,
          data: { path: result.path, count: result.count, rows: result.rows },
        };
      }
      if (action === 'copy_skills') {
        const names = Array.isArray(args?.names) ? args.names : [];
        if (names.length === 0) throw new Error('copy_skills needs `names` (see action=assets for the available skills)');
        const result = await operations.copySkills(names);
        const lines = [`Скилы: скопировано ${result.copied.length}, пропущено ${result.skipped.length}, ошибок ${result.failed.length}.`];
        for (const entry of result.copied) lines.push(`- скопирован ${entry.name} → ${entry.destination}`);
        for (const entry of result.skipped) lines.push(`- пропущен ${entry.name}: ${entry.reason}`);
        for (const entry of result.failed) lines.push(`- ошибка ${entry.name}: ${entry.reason}`);
        return { action, text: lines.join('\n'), data: { copied: result.copied, skipped: result.skipped, failed: result.failed } };
      }
      throw new Error(`unknown action "${action}"; use scan, search, import, ledger, assets, mcp_plan or copy_skills`);
    },
  });
}



