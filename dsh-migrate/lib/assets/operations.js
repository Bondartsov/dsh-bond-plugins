/**
 * The one implementation behind both callers: the browser routes and the
 * model-facing `assets_import` tool.
 *
 * Nothing here trusts the client for paths. A request names items by
 * `{ type, source, name }`; the operation re-scans the sources and resolves that
 * name against the fresh inventory, so a forged payload cannot make the plugin
 * read or write outside the paths it discovered itself.
 */
import { agentsSkillsRoot, dshSkillsRoot, formatTime, instructionsDir, profilePatchPath, readTextOrUndefined } from './paths.js';
import { scanInstructions, copyInstruction, readInstruction } from './instructions.js';
import { copySkill, scanSkills } from './skills.js';
import { applyMcpRows, buildFragment, parseConfiguredServers, profileState, scanMcp, slugOf } from './mcp.js';
import { scanPlugins } from './plugins.js';
import { readLedger, recordEntry, recordRun, summarizeLedger, writeLedger, ledgerPath } from './ledger.js';
import { resolveSecretValues, scanSecrets, userEnvironmentNames } from './secrets.js';
import { writeUserEnvironment } from './envwriter.js';

/** Human labels of the resource types. */
export const TYPE_LABELS = {
  skills: 'Скилы',
  mcp: 'MCP-серверы',
  secrets: 'Секреты',
  plugins: 'Плагины',
  instructions: 'Инструкции и конфиги',
};

/** Display order of the types inside a source card. */
const TYPE_ORDER = ['skills', 'mcp', 'secrets', 'plugins', 'instructions'];

/** Statuses that can be imported. */
const IMPORTABLE = new Set(['new', 'update']);

/** Status labels, shared with the client copy. */
export const STATUS_LABELS = {
  new: 'новый',
  update: 'обновит',
  exists: 'уже есть',
  available: 'уже есть',
  duplicate: 'дубль',
  invalid: 'не годится',
  view: 'просмотр',
  runtime: 'только рантайм',
  set: 'уже задана',
  empty: 'пустая',
  conflict: 'конфликт',
};

/** An item identity as the client sends it. */
function keyOf(type, source, name) {
  return `${type}:${source}:${name}`;
}

/** Base name of a path, without importing `node:path` semantics twice. */
function baseName(path) {
  const parts = String(path ?? '').split(/[\\/]/u);
  return parts[parts.length - 1] ?? '';
}

/**
 * Build the inventory tree.
 *
 * @param overrides - path overrides for tests.
 * @returns the tree the panel renders.
 */
export async function buildTree(overrides = {}) {
  const ledger = await readLedger(overrides.ledgerFile ?? ledgerPath());
  const skills = await scanSkills({ skillsRoot: overrides.skillsRoot, agentsRoot: overrides.agentsRoot, ledger });
  const mcp = await scanMcp({ patchPath: overrides.patchPath });
  const plugins = await scanPlugins();
  const instructions = await scanInstructions();
  const profile = await profileState({ patchPath: overrides.patchPath });
  const secrets = await scanSecrets({
    homeDir: overrides.homeDir,
    userEnvNames: await userEnvironmentNames({ runner: overrides.envRunner, userEnvNames: overrides.userEnvNames }),
    overwrite: overrides.overwriteSecrets === true,
  });

  /** @type {Map<string, any>} */
  const sources = new Map();
  const sourceOf = (id, label) => {
    if (!sources.has(id)) sources.set(id, { id, label, types: Object.fromEntries(TYPE_ORDER.map((type) => [type, []])) });
    return sources.get(id);
  };

  for (const row of skills.roots) sourceOf(row.id, row.label);
  for (const row of skills.items) {
    const holder = sourceOf(row.source, row.sourceLabel ?? row.source);
    holder.types.skills.push({ ...row, type: 'skills', id: keyOf('skills', row.source, row.name) });
  }
  for (const row of mcp.items) {
    const holder = sourceOf(row.source, row.sourceLabel ?? row.source);
    holder.types.mcp.push({ ...row, type: 'mcp', id: keyOf('mcp', row.source, row.name) });
  }
  for (const row of secrets.items) {
    const holder = sourceOf(row.source, row.sourceLabel ?? row.source);
    holder.types.secrets.push({ ...row, type: 'secrets', id: keyOf('secrets', row.source, row.name) });
  }
  for (const row of plugins) {
    const holder = sourceOf(row.source, row.sourceLabel ?? row.source);
    holder.types.plugins.push({ ...row, id: keyOf('plugins', row.source, row.name) });
  }
  for (const row of instructions.items) {
    const holder = sourceOf(row.source, row.sourceLabel ?? row.source);
    holder.types.instructions.push({ ...row, hostId: row.id, name: baseName(row.path), id: keyOf('instructions', row.source, baseName(row.path)) });
  }

  const sourceLabels = new Map([
    ...skills.roots.map((row) => [row.id, row.label]),
    ...mcp.items.map((row) => [row.source, row.sourceLabel ?? row.source]),
    ...secrets.items.map((row) => [row.source, row.sourceLabel ?? row.source]),
    ...plugins.map((row) => [row.source, row.sourceLabel ?? row.source]),
    ...instructions.items.map((row) => [row.source, row.sourceLabel ?? row.source]),
  ]);

  const assembled = [...sources.values()]
    .map((source) => {
      const types = TYPE_ORDER.filter((type) => source.types[type].length > 0).map((type) => ({
        type,
        label: TYPE_LABELS[type],
        items: source.types[type],
        counts: countByStatus(source.types[type]),
      }));
      const items = types.flatMap((group) => group.items);
      return {
        id: source.id,
        label: sourceLabels.get(source.id) ?? source.id,
        available: true,
        types,
        counts: {
          total: items.length,
          selectable: items.filter((item) => item.selectable === true).length,
          ...countByStatus(items),
        },
      };
    })
    .filter((source) => source.types.length > 0)
    .sort((left, right) => {
      const order = ['claude-code', 'codex', 'zcode', 'shared', 'kilocode', 'opencode'];
      const leftIndex = order.indexOf(left.id);
      const rightIndex = order.indexOf(right.id);
      const rank = (index) => (index === -1 ? order.length : index);
      if (rank(leftIndex) !== rank(rightIndex)) return rank(leftIndex) - rank(rightIndex);
      return left.label.localeCompare(right.label);
    });

  const all = assembled.flatMap((source) => source.types.flatMap((group) => group.items));
  return {
    generatedAt: Date.now(),
    generatedAtText: formatTime(Date.now()),
    sources: assembled,
    totals: {
      ...countByStatus(all),
      total: all.length,
      selectable: all.filter((item) => item.selectable === true).length,
      byType: Object.fromEntries(TYPE_ORDER.map((type) => [type, all.filter((item) => item.type === type).length])),
      sources: assembled.length,
    },
    targets: {
      skills: overrides.skillsRoot ?? dshSkillsRoot(),
      sharedSkills: overrides.agentsRoot ?? agentsSkillsRoot(),
      profilePatch: profile.path,
      profilePresent: profile.present,
      profileConfigured: profile.configured,
      instructions: instructions.targetDir,
      dshGlobalInstructions: instructions.dshGlobalPath,
      dshGlobalPresent: instructions.dshGlobalPresent,
      environment: 'Переменные окружения пользователя Windows (User scope)',
      userEnvCount: secrets.userEnvCount,
    },
    policy: {
      skillsCopyTo: '~/.dsh/skills',
      mcpWriteTo: 'cordis.patch.yml профиля (с бэкапом, идемпотентно)',
      instructions: 'только просмотр и маскированная копия, в профиль не пишется',
      plugins: 'рантайм не переносится, переносятся скилы и MCP-записи',
      secrets: 'значения секретов не копируются в профиль: они уходят в переменные окружения пользователя, в UI видны только имя и длина',
    },
    secrets: {
      skippedNonSecret: secrets.skippedNonSecret,
      userEnvCount: secrets.userEnvCount,
      overwrite: overrides.overwriteSecrets === true,
      note: 'В группу «Секреты» попадают только записи, похожие на учётные данные; прочие env-записи не показываются.',
    },
    ledger: summarizeLedger(ledger),
  };
}

/** Count rows by status. */
function countByStatus(items) {
  const counts = { new: 0, update: 0, exists: 0, available: 0, duplicate: 0, invalid: 0, view: 0, runtime: 0, set: 0, empty: 0, conflict: 0 };
  for (const item of items) {
    const status = item.status ?? 'invalid';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/** Index every importable row of one fresh scan by its printable key. */
async function indexInventory(overrides) {
  const ledger = await readLedger(overrides.ledgerFile ?? ledgerPath());
  const skills = await scanSkills({ skillsRoot: overrides.skillsRoot, agentsRoot: overrides.agentsRoot, ledger });
  const mcp = await scanMcp({ patchPath: overrides.patchPath });
  const instructions = await scanInstructions();
  const secrets = await scanSecrets({
    homeDir: overrides.homeDir,
    userEnvNames: await userEnvironmentNames({ runner: overrides.envRunner, userEnvNames: overrides.userEnvNames }),
    overwrite: overrides.overwriteSecrets === true,
  });
  const index = new Map();
  for (const row of skills.items) index.set(keyOf('skills', row.source, row.name), { type: 'skills', row });
  for (const row of mcp.items) index.set(keyOf('mcp', row.source, row.name), { type: 'mcp', row });
  for (const row of instructions.items) index.set(keyOf('instructions', row.source, baseName(row.path)), { type: 'instructions', row });
  for (const row of secrets.items) index.set(keyOf('secrets', row.source, row.name), { type: 'secrets', row });
  return { index, skills, mcp, instructions, secrets, ledger };
}

/**
 * Import the selected items.
 *
 * @param items - `[{ type, source, name }]` as the panel sends them.
 * @param options - `{ dryRun }` plus path overrides for tests.
 * @returns `{ summary, items, writeback, ledger }`.
 */
export async function runImport(items, options = {}) {
  const dryRun = options.dryRun === true;
  const requested = Array.isArray(items) ? items : [];
  const { index, ledger } = await indexInventory(options);
  const results = [];
  const servers = [];
  const secretNames = [];
  const touched = [];

  for (const request of requested) {
    const type = String(request?.type ?? '');
    const source = String(request?.source ?? '');
    const name = String(request?.name ?? '');
    const key = keyOf(type, source, name);
    const found = index.get(key);
    if (found === undefined) {
      results.push({ id: key, type, source, name, action: 'failed', reason: 'элемент не найден в текущем инвентаре — обновите дерево' });
      continue;
    }
    if (found.type === 'skills') {
      const row = found.row;
      if (!IMPORTABLE.has(row.status)) {
        results.push({ id: key, type, source, name, action: 'skipped', reason: row.note || `статус «${STATUS_LABELS[row.status] ?? row.status}» — импорт не нужен`, target: row.target });
        continue;
      }
      if (dryRun) {
        results.push({ id: key, type, source, name, action: row.status === 'update' ? 'would-update' : 'would-copy', target: row.target, reason: row.note });
        continue;
      }
      const report = await copySkill(row, { skillsRoot: options.skillsRoot });
      results.push({ id: key, type, source, name, ...report, target: report.target ?? row.target });
      if (report.action === 'copied' || report.action === 'updated') {
        recordEntry(ledger, key, { action: report.action, target: report.target, backupPath: report.backupPath });
        touched.push(key);
      }
      continue;
    }
    if (found.type === 'mcp') {
      const row = found.row;
      if (row.status !== 'new') {
        results.push({ id: key, type, source, name, action: 'skipped', reason: row.note || 'сервер уже настроен', target: row.target });
        continue;
      }
      servers.push(row);
      continue;
    }
    if (found.type === 'secrets') {
      const row = found.row;
      if (row.status === 'conflict') {
        results.push({ id: key, type, source, name, action: 'skipped', reason: row.note || 'в источниках разные значения — нужен ручной разбор', target: row.target });
        continue;
      }
      if (row.status === 'empty') {
        results.push({ id: key, type, source, name, action: 'skipped', reason: row.note || 'значения нет', target: row.target });
        continue;
      }
      if (row.status === 'set' && options.overwriteSecrets !== true) {
        results.push({ id: key, type, source, name, action: 'skipped', reason: 'уже задана в переменных окружения пользователя — перезапись только с флагом «перезаписать»', target: row.target });
        continue;
      }
      if (row.status !== 'new' && row.status !== 'set') {
        results.push({ id: key, type, source, name, action: 'skipped', reason: row.note || `статус «${STATUS_LABELS[row.status] ?? row.status}»`, target: row.target });
        continue;
      }
      if (dryRun) {
        results.push({ id: key, type, source, name, action: 'would-set-env', target: row.target, valueLength: row.valueLength, reason: row.note });
        continue;
      }
      secretNames.push({ key, source, name, row });
      continue;
    }
    if (found.type === 'instructions') {
      const row = found.row;
      if (row.kind !== 'instructions') {
        results.push({ id: key, type, source, name, action: 'skipped', reason: row.note || 'конфиг не копируется', target: '' });
        continue;
      }
      if (dryRun) {
        results.push({ id: key, type, source, name, action: 'would-copy-instruction', target: row.target, reason: row.note });
        continue;
      }
      const report = await copyInstruction(row.id);
      results.push({ id: key, type, source, name, ...report, target: report.target ?? row.target });
      if (report.action === 'copied') {
        recordEntry(ledger, key, { action: report.action, target: report.target });
        touched.push(key);
      }
      continue;
    }
    results.push({ id: key, type, source, name, action: 'failed', reason: `неизвестный тип: ${type}` });
  }

  let writeback;
  if (servers.length > 0) {
    writeback = await applyMcpRows(servers, {
      patchPath: options.patchPath,
      dryRun,
      runBackup: options.runBackup,
      backupScript: options.backupScript,
    });
    const addedNames = new Set((writeback.added ?? []).map((entry) => entry.name));
    for (const server of servers) {
      const key = keyOf('mcp', server.source, server.name);
      if (addedNames.has(server.name)) {
        results.push({
          id: key,
          type: 'mcp',
          source: server.source,
          name: server.name,
          action: dryRun ? 'would-add' : 'added',
          status: writeback.ok === true ? 'ok' : 'failed',
          target: writeback.path,
          reason: writeback.ok === true ? '' : writeback.error,
        });
        if (dryRun !== true && writeback.ok === true) {
          recordEntry(ledger, key, { action: 'added', target: writeback.path });
          touched.push(key);
        }
        continue;
      }
      const skipped = (writeback.skipped ?? []).find((entry) => entry.name === server.name);
      results.push({
        id: key,
        type: 'mcp',
        source: server.source,
        name: server.name,
        action: writeback.ok === true ? 'skipped' : 'failed',
        reason: skipped?.reason ?? writeback.error ?? '',
        target: writeback.path,
      });
    }
  }

  // Secrets are written in one shot: one payload file, one PowerShell call, one
  // cleanup. Values are resolved HERE and never leave this block.
  let environment = null;
  if (secretNames.length > 0) {
    const values = await resolveSecretValues(
      secretNames.map((entry) => entry.name),
      { homeDir: options.homeDir },
    );
    const pending = [];
    for (const entry of secretNames) {
      const resolved = values.get(entry.name);
      if (resolved === undefined) {
        results.push({
          id: entry.key,
          type: 'secrets',
          source: entry.source,
          name: entry.name,
          action: 'failed',
          reason: 'значение не удалось прочитать из источника (он мог измениться)',
          target: entry.row.target,
        });
        continue;
      }
      pending.push({ ...entry, value: resolved.value });
    }
    if (pending.length > 0) {
      const write = await writeUserEnvironment(
        pending.map((entry) => ({ name: entry.name, value: entry.value })),
        { runner: options.envRunner, account: options.account },
      );
      environment = {
        ok: write.ok,
        written: write.written,
        failed: write.failed,
        acl: write.acl,
        payloadDeleted: write.payloadDeleted,
        verified: write.verified,
        error: write.error,
        target: 'Переменные окружения пользователя (User scope)',
      };
      const writtenByName = new Map(write.written.map((item) => [item.name, item]));
      const failedByName = new Map(write.failed.map((item) => [item.name, item]));
      for (const entry of pending) {
        const okEntry = writtenByName.get(entry.name);
        const failedEntry = failedByName.get(entry.name);
        results.push({
          id: entry.key,
          type: 'secrets',
          source: entry.source,
          name: entry.name,
          action: okEntry !== undefined ? 'env-written' : 'failed',
          status: okEntry !== undefined ? 'ok' : 'failed',
          target: environment.target,
          valueLength: okEntry?.length,
          reason: okEntry !== undefined ? '' : failedEntry?.reason ?? write.error ?? '',
        });
        if (okEntry !== undefined && write.ok === true) {
          recordEntry(ledger, entry.key, { action: 'env-written', target: environment.target });
          touched.push(entry.key);
        }
      }
    }
  }

  const summary = {
    requested: requested.length,
    copied: results.filter((item) => item.action === 'copied' || item.action === 'would-copy').length,
    updated: results.filter((item) => item.action === 'updated' || item.action === 'would-update').length,
    added: results.filter((item) => item.action === 'added' || item.action === 'would-add').length,
    instructions: results.filter((item) => item.action === 'would-copy-instruction').length,
    secrets: results.filter((item) => item.action === 'env-written' || item.action === 'would-set-env').length,
    skipped: results.filter((item) => item.action === 'skipped').length,
    failed: results.filter((item) => item.action === 'failed').length,
    dryRun,
  };

  if (dryRun !== true && touched.length > 0) {
    recordRun(ledger, { at: Date.now(), summary, items: results });
    await writeLedger(ledger, options.ledgerFile ?? ledgerPath());
  }

  return {
    ok: summary.failed === 0,
    summary,
    items: results,
    writeback: writeback ?? null,
    environment: environment ?? null,
    ledger: summarizeLedger(ledger),
  };
}

/**
 * Preview what a selection would do — the MCP YAML fragment included.
 *
 * @param items - the same payload the run route takes.
 * @param options - path overrides for tests.
 * @returns per-item previews, the combined YAML block and the warnings.
 */
export async function previewImport(items, options = {}) {
  const requested = Array.isArray(items) ? items : [];
  const { index } = await indexInventory(options);
  const patchPath = options.patchPath ?? profilePatchPath();
  const patchText = (await readTextOrUndefined(patchPath)) ?? '';
  const usedIds = parseConfiguredServers(patchText).ids;
  const previews = [];
  const warnings = [];
  const servers = [];
  const secretRows = [];

  for (const request of requested) {
    const type = String(request?.type ?? '');
    const source = String(request?.source ?? '');
    const name = String(request?.name ?? '');
    const key = keyOf(type, source, name);
    const found = index.get(key);
    if (found === undefined) {
      previews.push({ id: key, action: 'failed', reason: 'элемент не найден — обновите дерево' });
      continue;
    }
    if (found.type === 'mcp') {
      const row = found.row;
      servers.push(row);
      const single = buildFragment([row], { usedIds: new Set(usedIds) });
      const missing = row.needsEnv.filter((variable) => process.env[variable] === undefined);
      for (const variable of missing) warnings.push(`переменная окружения ${variable} не задана — сервер ${row.name} не сможет авторизоваться, пока вы её не добавите`);
      previews.push({
        id: key,
        action: row.status === 'new' ? 'would-add' : 'skipped',
        target: patchPath,
        fragment: single.fragment,
        needsEnv: row.needsEnv,
        missingEnv: missing,
        reason: row.note,
      });
      continue;
    }
    if (found.type === 'skills') {
      const row = found.row;
      previews.push({ id: key, action: row.status === 'update' ? 'would-update' : IMPORTABLE.has(row.status) ? 'would-copy' : 'skipped', target: row.target, reason: row.note });
      continue;
    }
    if (found.type === 'secrets') {
      const row = found.row;
      const blocked = row.status === 'conflict' || row.status === 'empty' || (row.status === 'set' && options.overwriteSecrets !== true);
      if (!blocked) secretRows.push(row);
      previews.push({
        id: key,
        action: blocked ? 'skipped' : 'would-set-env',
        target: row.target,
        name: row.name,
        origin: row.origin,
        valueLength: row.valueLength,
        reason: row.note,
      });
      continue;
    }
    if (found.type === 'instructions') {
      const row = found.row;
      previews.push({ id: key, action: row.kind === 'instructions' ? 'would-copy-instruction' : 'skipped', target: row.target, reason: row.note });
      continue;
    }
    previews.push({ id: key, action: 'failed', reason: `неизвестный тип: ${type}` });
  }

  // Secrets: names, origins and lengths only. A value never enters a preview.
  for (const variable of secretRows.filter((row) => row.status === 'new')) {
    warnings.push(`секрет ${variable.name} будет записан в переменные окружения пользователя — значение при этом не показывается`);
  }
  for (const row of secretRows) {
    if (row.status !== 'set') continue;
    warnings.push(`переменная ${row.name} уже задана и будет ПЕРЕЗАПИСАНА (флаг «перезаписать» включён)`);
  }

  const combined = servers.length > 0 ? buildFragment(servers, { usedIds: new Set(usedIds) }).fragment : '';
  const changesProfile = servers.length > 0;
  const changesEnvironment = secretRows.length > 0;
  return {
    patchPath,
    yaml: combined,
    previews,
    warnings: [...new Set(warnings)],
    changesProfile,
    changesEnvironment,
    environment: {
      target: 'Переменные окружения пользователя Windows (User scope)',
      variables: secretRows.map((row) => ({ name: row.name, origin: row.origin, valueLength: row.valueLength, status: row.status })),
      overwrite: options.overwriteSecrets === true,
      note: 'Значения не показываются и не передаются в браузер: панель видит только имена и длины.',
    },
    note:
      changesProfile && changesEnvironment
        ? 'Выбор изменит и конфигурацию профиля (cordis.patch.yml), и переменные окружения пользователя Windows. Записи выполняются только по кнопке подтверждения.'
        : changesProfile
          ? 'Ниже — точный фрагмент, который будет дописан в cordis.patch.yml профиля. Перед записью скрипт профильного бэкапа сохранит копию, после записи потребуется перезапуск DSH.'
          : changesEnvironment
            ? 'Выбор изменит переменные окружения пользователя Windows (User scope). Значения секретов в предпросмотр не попадают.'
            : 'Выбор не меняет ни конфигурацию профиля, ни переменные окружения.',
  };
}

/** Status of the plugin: ledger, targets and counters. */
export async function buildStatus(overrides = {}) {
  const ledger = await readLedger(overrides.ledgerFile ?? ledgerPath());
  const profile = await profileState({ patchPath: overrides.patchPath });
  const userEnvNames = await userEnvironmentNames({ runner: overrides.envRunner, userEnvNames: overrides.userEnvNames });
  return {
    generatedAt: Date.now(),
    generatedAtText: formatTime(Date.now()),
    ledger: summarizeLedger(ledger),
    profile,
    targets: {
      skills: overrides.skillsRoot ?? dshSkillsRoot(),
      sharedSkills: overrides.agentsRoot ?? agentsSkillsRoot(),
      profilePatch: profile.path,
      instructions: instructionsDir(),
      ledger: overrides.ledgerFile ?? ledgerPath(),
      environment: 'Переменные окружения пользователя Windows (User scope)',
      userEnvCount: userEnvNames.size,
    },
    environment: {
      scope: 'User',
      variables: userEnvNames.size,
      writer: 'временный JSON с ACL только для пользователя + set-user-env.ps1 ([Environment]::SetEnvironmentVariable); setx не используется',
    },
    slugExample: slugOf('example server'),
  };
}

/** Read one instruction document, masked. */
export async function instructionContent(id) {
  return await readInstruction(String(id ?? ''));
}
