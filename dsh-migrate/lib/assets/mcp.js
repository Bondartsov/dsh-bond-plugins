/**
 * MCP servers: inventory, YAML preview and the one privileged write.
 *
 * Three rules shape this module:
 *
 *  1. a foreign config is read for names, transports, commands and KEY NAMES of
 *     `env`/`headers` — never for their values. A normalized server therefore has
 *     no field that could hold a credential: secrets become `process.env.<VAR>`
 *     references plus a `needsEnv` warning when the variable is not set here;
 *  2. nothing is written before the owner's snapshot script reported a saved
 *     copy of the patch, and a failed snapshot aborts the write;
 *  3. the write is an append of one `- insert:` block that only carries servers
 *     whose `serverName` is absent, so a second run adds nothing.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { runProfileBackup } from './backup.js';
import { profilePatchPath, readJsonOrUndefined, readTextOrUndefined, stampForFile, userHome } from './paths.js';
import { classifyEnvValue, envReferenceOf, headerReferenceName, isSecretFlag, looksSecretValue } from './redact.js';

/** A new profile row always instantiates the shipped MCP client. */
export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client';

/** Bare launchers that only run through the Windows command interpreter. */
const SHIMS = new Set(['npx', 'npm', 'node', 'pnpm', 'yarn', 'bun', 'bunx']);

/** Sources understood by this module, in display order. */
export const MCP_SOURCES = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'zcode', label: 'ZCode' },
  { id: 'kilocode', label: 'KiloCode' },
  { id: 'opencode', label: 'OpenCode' },
];

/** Turn a server name into a stable profile row id. */
export function slugOf(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `mcp-${slug === '' ? 'server' : slug}`;
}

/** Coerce to text. */
const textOf = (value) => (typeof value === 'string' ? value : '');

/** Coerce to a string array. */
const arrayOf = (value) => (Array.isArray(value) ? value.map((entry) => String(entry)) : []);

/**
 * Sanitize one command line.
 *
 * A foreign config sometimes carries the credential AS an argument
 * (`--api-key ctx7sk-…`). Such an argument becomes an environment reference in
 * the rendered YAML, and the variable name is derived from its flag, so no value
 * survives and the owner gets a `needsEnv` warning instead of a broken server.
 *
 * @param serverName - server name, used to build a fallback variable name.
 * @param args - raw arguments.
 * @returns `{ args, needsEnv }` where an argument is a string or `{ js: <expr> }`.
 */
export function sanitizeArgs(serverName, args) {
  const raw = arrayOf(args);
  const result = [];
  const needsEnv = [];
  const jsFor = (flag, index) => {
    const match = /^--?(.+)$/u.exec(String(flag ?? ''));
    const variable = headerReferenceName(serverName, match === null ? `arg${index}` : match[1]);
    needsEnv.push(variable);
    return { js: `process.env.${variable}` };
  };
  for (let index = 0; index < raw.length; index += 1) {
    const argument = raw[index];
    if (argument === '') {
      result.push('');
      continue;
    }
    // `--flag=secret` keeps the flag text and references only the value. The flag
    // itself decides when the value has no token shape (`--password=example-pass-not-a-secret`).
    const inline = /^(--?[^=]+)=(.+)$/u.exec(argument);
    if (inline !== null) {
      if (looksSecretValue(inline[2]) || isSecretFlag(inline[1])) {
        result.push(`${inline[1]}=`);
        result.push(jsFor(inline[1], index));
        continue;
      }
      result.push(argument);
      continue;
    }
    // `--password <value>`: the value is the next token.
    if (isSecretFlag(argument) && index + 1 < raw.length) {
      result.push(argument);
      result.push(jsFor(argument, index));
      index += 1;
      continue;
    }
    if (!looksSecretValue(argument)) {
      result.push(argument);
      continue;
    }
    result.push(jsFor(raw[index - 1], index));
  }
  return { args: result, needsEnv };
}

/**
 * Normalize one foreign server definition.
 *
 * No credential value survives this function: `env` keeps a reference or a
 * literal that the classifier judged non-secret, `args` substitute an environment
 * reference for a credential, and `headers` keep a variable name only.
 *
 * @param raw - the foreign definition (`{ command, args, env, url, headers }`).
 * @param meta - `{ name, source, configPath }`.
 * @returns a normalized server row.
 */
export function normalizeServer(raw, meta) {
  const definition = raw !== null && typeof raw === 'object' ? raw : {};
  const name = textOf(meta?.name) || textOf(definition.name);
  const command = textOf(definition.command);
  const url = textOf(definition.url);
  const envKeys = [];
  const needsEnv = [];
  const env = [];
  for (const [key, value] of Object.entries(definition.env !== null && typeof definition.env === 'object' ? definition.env : {})) {
    const classified = classifyEnvValue(key, value);
    envKeys.push(key);
    if (classified.mode === 'reference') {
      env.push({ key, mode: 'reference', variable: classified.variable });
      needsEnv.push(classified.variable);
    } else {
      env.push({ key, mode: 'literal', value: classified.value });
    }
  }
  const headers = [];
  for (const [header, value] of Object.entries(definition.headers !== null && typeof definition.headers === 'object' ? definition.headers : {})) {
    const reference = envReferenceOf(value);
    const scheme = /^Bearer\s/iu.test(textOf(value)) ? 'Bearer' : /^Basic\s/iu.test(textOf(value)) ? 'Basic' : '';
    const variable = reference !== '' ? reference : headerReferenceName(name, header);
    headers.push({ name: header, variable, scheme });
    needsEnv.push(variable);
  }
  const sanitized = sanitizeArgs(name, definition.args);
  needsEnv.push(...sanitized.needsEnv);
  const transport = url !== '' ? 'streamable-http' : command !== '' ? 'stdio' : 'unknown';
  const source = textOf(meta?.source);
  const sourceLabel = MCP_SOURCES.find((entry) => entry.id === source)?.label ?? source;
  // Credentials baked into a URL cannot be turned into an argument reference
  // without guessing the shape; the row is refused and the owner sets it up by hand.
  const urlHasCredentials = /\/\/[^/@\s]+@/u.test(url) || /[?&](?:api[-_]?key|apikey|token|access[-_]?token|key|secret|password)=/iu.test(url);
  return {
    type: 'mcp',
    id: `mcp:${source}:${name}`,
    source,
    sourceLabel,
    name,
    configPath: textOf(meta?.configPath),
    transport,
    command,
    args: sanitized.args,
    url,
    urlHasCredentials,
    env,
    envKeys,
    headers,
    needsEnv: [...new Set(needsEnv)],
    timeoutMs: Number.isFinite(definition.timeout) ? Number(definition.timeout) : 0,
  };
}

/* ---------------------------------------------------------------- parsing */

/**
 * One raw foreign server definition, before secret-safe normalization.
 *
 * `raw` still holds the untouched `env`/`headers` values. It never leaves this
 * module: `scanRawMcpServers` is consumed by `scanMcpServers` (which drops the
 * values through {@link normalizeServer}) and by the secrets scanner (which moves
 * them into the user's environment without ever returning them).
 */
async function rawClaudeServers(home = userHome()) {
  const servers = [];
  const candidates = [join(home, '.claude.json'), join(home, '.claude', 'settings.json'), join(home, '.claude', '.mcp.json')];
  const seen = new Set();
  for (const path of candidates) {
    const config = await readJsonOrUndefined(path);
    if (config === undefined) continue;
    const blocks = [{ label: 'global', value: config?.mcpServers }];
    if (config?.projects !== null && typeof config?.projects === 'object') {
      for (const [projectPath, project] of Object.entries(config.projects)) {
        if (project?.mcpServers !== undefined) blocks.push({ label: projectPath, value: project.mcpServers });
      }
    }
    for (const block of blocks) {
      if (block.value === null || typeof block.value !== 'object') continue;
      for (const [name, definition] of Object.entries(block.value)) {
        const key = `${name}`;
        if (seen.has(key) && block.label === 'global') continue;
        seen.add(key);
        servers.push({ name, source: 'claude-code', configPath: path, raw: definition, scope: block.label });
      }
    }
  }
  return servers;
}

/** Minimal TOML reader for the `[mcp_servers.<name>]` tables of a Codex config. */
export async function parseCodexToml(text) {
  const servers = new Map();
  let section = '';
  let sub = '';
  const lines = String(text ?? '').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header !== null) {
      const parts = header[1].split('.').map((part) => part.trim().replace(/^["']|["']$/gu, ''));
      if (parts[0] !== 'mcp_servers' || parts[1] === undefined) {
        section = '';
        sub = '';
        continue;
      }
      section = parts[1];
      sub = parts[2] ?? '';
      if (!servers.has(section)) servers.set(section, { name: section, args: [], env: {}, headers: {}, envVars: [] });
      continue;
    }
    if (section === '') continue;
    const assignment = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/u.exec(line);
    if (assignment === null) continue;
    const key = assignment[1];
    let value = assignment[2].trim();
    // A multi-line array literal spans the following lines until the brackets close.
    const bracketDepth = (input) => (input.match(/\[/gu) ?? []).length - (input.match(/\]/gu) ?? []).length;
    while (bracketDepth(value) > 0 && index + 1 < lines.length) {
      index += 1;
      value += ` ${lines[index].trim()}`;
    }
    const entry = servers.get(section);
    const unquote = (input) => input.replace(/^['"]|['"]$/gu, '');
    if (sub === 'env') {
      entry.env[key] = unquote(value);
      continue;
    }
    if (sub === 'http_headers' || sub === 'headers') {
      entry.headers[key] = unquote(value);
      continue;
    }
    if (sub !== '') continue;
    if (key === 'command') entry.command = unquote(value);
    else if (key === 'url') entry.url = unquote(value);
    else if (key === 'transport' || key === 'type') entry.transport = unquote(value);
    else if (key === 'env_vars') {
      // `env_vars = ["A", "B"]` names variables without their values.
      for (const match of value.matchAll(/"([^"]+)"/gu)) entry.envVars.push(match[1]);
    } else if (key === 'args') {
      const parsed = [];
      for (const match of value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu)) parsed.push(match[1] ?? match[2] ?? '');
      entry.args = parsed;
    }
  }
  return [...servers.values()].map((entry) => {
    const env = { ...entry.env };
    for (const variable of entry.envVars) if (env[variable] === undefined) env[variable] = `\${${variable}}`;
    return { ...entry, env };
  });
}

/** Codex servers live in `~/.codex/config.toml`. */
async function rawCodexServers(home = userHome()) {
  const path = join(home, '.codex', 'config.toml');
  const text = await readTextOrUndefined(path);
  if (text === undefined) return [];
  const parsed = await parseCodexToml(text);
  return parsed.map((entry) => ({ name: entry.name, source: 'codex', configPath: path, raw: entry, scope: 'global' }));
}

/** ZCode keeps servers under `mcp.servers` of its CLI config. */
async function rawZcodeServers(home = userHome()) {
  const path = join(home, '.zcode', 'cli', 'config.json');
  const config = await readJsonOrUndefined(path);
  const block = config?.mcp?.servers ?? config?.mcpServers;
  if (block === null || typeof block !== 'object') return [];
  return Object.entries(block).map(([name, definition]) => ({ name, source: 'zcode', configPath: path, raw: definition, scope: 'global' }));
}

/** KiloCode keeps servers in two JSON files. */
async function rawKilocodeServers(home = userHome()) {
  const paths = [
    join(home, '.kilocode', 'mcp.json'),
    join(home, '.kilocode', 'cli', 'global', 'settings', 'mcp_settings.json'),
    join(home, '.kilocode', 'settings.json'),
  ];
  const servers = [];
  for (const path of paths) {
    const config = await readJsonOrUndefined(path);
    const block = config?.mcpServers;
    if (block === null || typeof block !== 'object') continue;
    for (const [name, definition] of Object.entries(block)) {
      servers.push({ name, source: 'kilocode', configPath: path, raw: definition, scope: 'global' });
    }
  }
  return servers;
}

/** OpenCode keeps servers in `~/.opencode/mcp_settings.json` and its config. */
async function rawOpencodeServers(home = userHome()) {
  const servers = [];
  for (const path of [join(home, '.opencode', 'mcp_settings.json'), join(home, '.config', 'opencode', 'opencode.json'), join(home, '.config', 'opencode', 'config.json')]) {
    const config = await readJsonOrUndefined(path);
    if (config === undefined) continue;
    const block = config?.mcpServers ?? config?.mcp;
    if (block === null || typeof block !== 'object') continue;
    for (const [name, definition] of Object.entries(block)) {
      // OpenCode "remote" entries carry `url`; "local" entries carry `command` as an array.
      const raw = { ...definition };
      if (Array.isArray(raw.command)) {
        const [first, ...rest] = raw.command;
        raw.command = textOf(first);
        raw.args = rest;
      }
      servers.push({ name, source: 'opencode', configPath: path, raw, scope: 'global' });
    }
  }
  return servers;
}

/**
 * Every raw server definition of every supported source.
 *
 * The result carries credential VALUES, so it stays inside the Host: the public
 * inventory goes through {@link scanMcpServers}, which normalizes them away.
 *
 * @param options - `{ homeDir }` override for tests.
 */
export async function scanRawMcpServers(options = {}) {
  const home = options.homeDir ?? userHome();
  return [
    ...(await rawClaudeServers(home)),
    ...(await rawCodexServers(home)),
    ...(await rawZcodeServers(home)),
    ...(await rawKilocodeServers(home)),
    ...(await rawOpencodeServers(home)),
  ];
}

/** Parse every supported source into secret-safe server rows. */
export async function scanMcpServers(options = {}) {
  const raw = await scanRawMcpServers(options);
  return raw.map((entry) => {
    const server = normalizeServer(entry.raw, { name: entry.name, source: entry.source, configPath: entry.configPath });
    return entry.scope === 'global' ? server : { ...server, scope: entry.scope };
  });
}

/* --------------------------------------------------------------- profile */

/**
 * Read the `serverName` values already configured in the profile patch.
 * @param text - the patch file content.
 * @returns `{ names: Set, ids: Set }`.
 */
export function parseConfiguredServers(text) {
  const names = new Set();
  const ids = new Set();
  const source = String(text ?? '');
  for (const match of source.matchAll(/^\s*serverName:\s*(.+)$/gmu)) {
    names.add(match[1].trim().replace(/^['"]|['"]$/gu, ''));
  }
  for (const match of source.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gmu)) ids.add(match[1].trim());
  return { names, ids };
}

/** Whether the profile patch is readable (the panel shows the target row). */
export async function profileState(options = {}) {
  const path = options.patchPath ?? profilePatchPath();
  const text = await readTextOrUndefined(path);
  if (text === undefined) return { path, present: false, configured: 0, names: [] };
  const { names } = parseConfiguredServers(text);
  return { path, present: true, configured: names.size, names: [...names].sort() };
}

/* ------------------------------------------------------------------ YAML */

/** One YAML scalar: JSON quoting is valid YAML. */
function yamlScalar(value) {
  return JSON.stringify(String(value));
}

/** One flow sequence: strings are quoted, `{ js }` entries become `!!js` expressions. */
function yamlSequence(values) {
  if (values.length === 0) return '[]';
  const rendered = values.map((entry) => {
    if (entry !== null && typeof entry === 'object' && typeof entry.js === 'string') return `!!js ${entry.js}`;
    return yamlScalar(entry);
  });
  return `[ ${rendered.join(', ')} ]`;
}

/** A unique row id for one server. */
function uniqueId(server, usedIds) {
  const base = slugOf(server.name);
  if (!usedIds.has(base)) return base;
  let index = 2;
  while (usedIds.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/**
 * Windows launchers must run through the command interpreter; everything else is
 * started directly. The profile already mixes both forms, so the rule is narrow.
 */
export function wrapLauncher(command, args) {
  const name = String(command ?? '');
  const list = Array.isArray(args) ? args : [];
  if (name === '') return { command: '', args: list };
  const bare = !/[/\\]/u.test(name) && !/\.exe$/iu.test(name);
  if (bare && SHIMS.has(name.toLowerCase())) {
    return { command: 'cmd', args: ['/c', name, ...list] };
  }
  return { command: name, args: list };
}

/**
 * Render one profile row.
 * @param server - a normalized server.
 * @param usedIds - ids already present in the patch (mutated with the new id).
 * @returns `{ id, lines }`.
 */
export function buildServerRow(server, usedIds) {
  const id = uniqueId(server, usedIds);
  usedIds.add(id);
  const lines = [
    `    - id: ${id}`,
    `      name: ${yamlScalar(MCP_PLUGIN_NAME)}`,
    '      config:',
    `        serverName: ${yamlScalar(server.name)}`,
  ];
  if (server.transport === 'streamable-http') {
    lines.push('        transport: streamable-http');
    lines.push(`        url: ${yamlScalar(server.url)}`);
    if (server.headers.length > 0) {
      lines.push('        headers:');
      for (const header of server.headers) {
        const template = header.scheme === '' ? '`${process.env.' : `\`${header.scheme} \${process.env.`;
        lines.push(`          ${header.name}: !!js '${template}${header.variable}}'`);
      }
    }
  } else {
    const launcher = wrapLauncher(server.command, server.args);
    lines.push('        transport: stdio');
    lines.push(`        command: ${yamlScalar(launcher.command)}`);
    lines.push(`        args: ${yamlSequence(launcher.args)}`);
    if (server.env.length > 0) {
      lines.push('        env:');
      for (const entry of server.env) {
        if (entry.mode === 'reference') lines.push(`          ${entry.key}: !!js process.env.${entry.variable}`);
        else lines.push(`          ${entry.key}: ${yamlScalar(entry.value)}`);
      }
    }
  }
  return { id, lines };
}

/**
 * Build the `- insert:` fragment for a set of servers.
 *
 * @param servers - normalized servers to add (already filtered).
 * @param options - `{ usedIds, generatedAt }`.
 * @returns `{ fragment, rows }` where `rows` maps a server id to its row id.
 */
export function buildFragment(servers, options = {}) {
  const usedIds = new Set(options.usedIds ?? []);
  const added = [];
  const body = [];
  for (const server of servers) {
    const { id, lines } = buildServerRow(server, usedIds);
    added.push({ name: server.name, id, source: server.source, transport: server.transport });
    body.push(...lines);
  }
  if (body.length === 0) return { fragment: '', rows: added };
  const header = [
    '# === MCP-серверы, добавленные @local/dsh-migrate ===',
    '# Секреты не копируются: значения берутся из переменных окружения.',
    '# Откат: восстановите cordis.patch.yml из профильного бэкапа (.good) и перезапустите DSH.',
    '# Новые записи добавляются ТОЛЬКО через - insert: [...] — патч с id переопределяет запись.',
  ];
  const fragment = `${header.join('\n')}\n- insert:\n${body.join('\n')}\n`;
  return { fragment, rows: added };
}

/**
 * Whether one server can become a profile row at all.
 * @param server - a normalized server.
 * @returns an empty string when it can, otherwise the reason it cannot.
 */
export function rowBlocker(server) {
  if (server.name === '') return 'у сервера нет имени';
  if (server.urlHasCredentials === true) return 'в url зашиты учётные данные — такую запись нельзя безопасно перенести, настройте сервер вручную';
  if (server.transport === 'unknown') return 'не найден ни command, ни url — запись собрать нельзя';
  if (server.transport === 'stdio' && server.command === '') return 'stdio-сервер без команды запуска';
  return '';
}

/**
 * The MCP part of the inventory: rows plus their status against the profile.
 * @param options - `{ patchPath }` override for tests.
 */
export async function scanMcp(options = {}) {
  const path = options.patchPath ?? profilePatchPath();
  const [servers, state] = await Promise.all([scanMcpServers(), profileState({ patchPath: path })]);
  const configured = new Set(state.names);
  // The same server name usually appears in several foreign agents; only the
  // first occurrence can add a row, the rest are duplicates of that decision.
  const claimed = new Set();
  const items = servers.map((server) => {
    const blocker = rowBlocker(server);
    const row = { ...server, target: path };
    if (blocker !== '') {
      row.status = 'invalid';
      row.selectable = false;
      row.note = blocker;
      return row;
    }
    if (configured.has(server.name)) {
      row.status = 'exists';
      row.selectable = false;
      row.note = `сервер ${server.name} уже настроен в профиле`;
      return row;
    }
    if (claimed.has(server.name)) {
      row.status = 'duplicate';
      row.selectable = false;
      row.note = `тот же сервер уже предлагается из другого источника`;
      return row;
    }
    claimed.add(server.name);
    row.status = 'new';
    row.selectable = true;
    row.note = server.needsEnv.length === 0 ? 'будет добавлен в cordis.patch.yml профиля' : `будет добавлен; нужно задать переменные: ${server.needsEnv.join(', ')}`;
    return row;
  });
  return { items, patchPath: path, configured: state.configured, configuredNames: state.names };
}

/**
 * Append the selected servers to the profile patch.
 *
 * @param servers - normalized servers, already selected by the owner.
 * @param options - `{ patchPath, dryRun, runBackup, resolvedEnv }`.
 * @returns `{ ok, path, backupPath, fragment, added, skipped, verified, error }`.
 */
export async function applyMcpRows(servers, options = {}) {
  const patchPath = options.patchPath ?? profilePatchPath();
  const dryRun = options.dryRun === true;
  const text = await readTextOrUndefined(patchPath);
  if (text === undefined) {
    return { ok: false, path: patchPath, backupPath: '', fragment: '', added: [], skipped: [], verified: false, error: `патч профиля не найден: ${patchPath}` };
  }
  const { names, ids } = parseConfiguredServers(text);
  const skipped = [];
  const pending = [];
  for (const server of servers) {
    const blocker = rowBlocker(server);
    if (blocker !== '') {
      skipped.push({ name: server.name, source: server.source, reason: blocker });
      continue;
    }
    if (names.has(server.name)) {
      skipped.push({ name: server.name, source: server.source, reason: 'уже настроен в профиле — дубль не создаётся' });
      continue;
    }
    if (pending.some((entry) => entry.name === server.name)) {
      skipped.push({ name: server.name, source: server.source, reason: 'тот же сервер выбран повторно' });
      continue;
    }
    pending.push(server);
  }
  if (pending.length === 0) {
    return { ok: true, path: patchPath, backupPath: '', fragment: '', added: [], skipped, verified: true, error: '' };
  }
  const { fragment } = buildFragment(pending, { usedIds: ids });
  if (dryRun) {
    return { ok: true, dryRun: true, path: patchPath, backupPath: '', fragment, added: pending.map((server) => ({ name: server.name, source: server.source })), skipped, verified: false, error: '' };
  }

  // A snapshot first, always. Without a saved copy the write does not happen.
  const backup = await runProfileBackup({ runner: options.runBackup, script: options.backupScript });
  if (backup.ok !== true) {
    return {
      ok: false,
      path: patchPath,
      backupPath: '',
      fragment,
      added: [],
      skipped,
      verified: false,
      error: `резервная копия профиля не создана — запись отменена (${backup.output || 'нет вывода скрипта'})`,
    };
  }

  const next = `${text.replace(/\s*$/u, '')}\n\n${fragment}`;
  const temporary = `${patchPath}.tmp-${stampForFile(Date.now())}`;
  try {
    await writeFile(temporary, next, 'utf8');
    await rename(temporary, patchPath);
  } catch (error) {
    return { ok: false, path: patchPath, backupPath: backup.savedAs, fragment, added: [], skipped, verified: false, error: error?.message ?? String(error) };
  }

  const written = await readFile(patchPath, 'utf8');
  const after = parseConfiguredServers(written);
  const missing = pending.filter((server) => !after.names.has(server.name)).map((server) => server.name);
  const duplicated = pending
    .filter((server) => (written.match(new RegExp(`^\\s*serverName:\\s*"?${server.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"?\\s*$`, 'gmu')) ?? []).length > 1)
    .map((server) => server.name);
  return {
    ok: missing.length === 0 && duplicated.length === 0,
    path: patchPath,
    backupPath: backup.savedAs,
    fragment,
    added: pending.map((server) => ({ name: server.name, source: server.source })),
    skipped,
    verified: missing.length === 0 && duplicated.length === 0,
    verifiedNote: missing.length === 0 ? '' : `после записи не найдены: ${missing.join(', ')}`,
    error: '',
  };
}

/** The file name of the patch, for a compact panel label. */
export function patchLabel(path) {
  return `${basename(String(path ?? ''))}`;
}

/** Whether the default profile patch exists (used by the status route). */
export function profilePatchExists() {
  return existsSync(profilePatchPath());
}
