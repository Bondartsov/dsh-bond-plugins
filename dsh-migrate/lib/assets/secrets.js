/**
 * Secrets: env-like records of the foreign agents.
 *
 * The owner asked for the creds to move too, "without reading them". This module
 * is where that promise lives:
 *
 *  - a normalised row carries the variable NAME, its origin and the VALUE LENGTH —
 *    never the value itself, not even masked-with-hint;
 *  - the values exist only inside this module for the duration of one call and are
 *    handed straight to {@link module:./envwriter}, which writes them into the
 *    user's environment through a file the calling process never passes on argv;
 *  - an error thrown here never formats a value: every message names the variable
 *    or the file, nothing else.
 *
 * Sources: `env` blocks of the agents' own settings, and the `env`/`headers`
 * entries of their MCP servers (read through the same raw parse the MCP inventory
 * uses, so the two views cannot disagree).
 */
import { join } from 'node:path';

import { scanRawMcpServers } from './mcp.js';
import { readJsonOrUndefined, readTextOrUndefined, userHome } from './paths.js';
import { envReferenceOf, headerReferenceName, isSecretKey, looksSecretValue } from './redact.js';
import { listUserEnvironmentNames } from './envwriter.js';

/** Statuses a secret row may carry. */
export const SECRET_STATUSES = ['new', 'set', 'empty', 'duplicate', 'conflict', 'invalid'];

/** A variable name Windows and a `.env` file both accept. */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Display label of one secret origin. */
const SOURCE_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  zcode: 'ZCode',
  kilocode: 'KiloCode',
  opencode: 'OpenCode',
};

/** Config files that keep a plain `env` object. */
const ENV_BLOCK_FILES = [
  { source: 'claude-code', path: (home) => join(home, '.claude', 'settings.json'), pointer: 'env' },
  { source: 'kilocode', path: (home) => join(home, '.kilocode', 'settings.json'), pointer: 'env' },
  { source: 'opencode', path: (home) => join(home, '.config', 'opencode', 'opencode.json'), pointer: 'env' },
];

/**
 * Single-token settings that are credentials but are not env names.
 * The variable name is the documented one, not an invented one.
 */
const TOKEN_FIELDS = [
  { source: 'kilocode', path: (home) => join(home, '.kilocode', 'settings.json'), field: 'kilocodeToken', variable: 'KILOCODE_TOKEN' },
];

/** Whether an env entry is credential-like enough to belong to this group. */
export function isCredentialEntry(name, value) {
  return isSecretKey(String(name ?? '')) || looksSecretValue(String(value ?? ''));
}

/** Drop a `Bearer ` / `Basic ` scheme so the variable holds the token itself. */
function stripScheme(value) {
  return String(value ?? '').replace(/^(?:Bearer|Basic)\s+/iu, '');
}

/** Length as the panel shows it, never the value. */
function lengthOf(value) {
  return String(value ?? '').length;
}

/**
 * Collect every raw secret candidate of every source.
 *
 * @param options - `{ homeDir }` override for tests.
 * @returns `{ candidates, skippedNonSecret }`; candidates carry the values.
 */
export async function collectSecretCandidates(options = {}) {
  const home = options.homeDir ?? userHome();
  const candidates = [];
  let skippedNonSecret = 0;

  /** One `env` object of a JSON config. */
  const pushEnvBlock = (source, path, block, pointer) => {
    if (block === null || typeof block !== 'object') return;
    for (const [name, value] of Object.entries(block)) {
      const text = String(value ?? '');
      if (!isCredentialEntry(name, text)) {
        skippedNonSecret += 1;
        continue;
      }
      candidates.push({
        name,
        value: text,
        source,
        origin: `${path} → ${pointer}.${name}`,
        originPath: path,
        kind: 'env',
        pointer,
      });
    }
  };

  for (const entry of ENV_BLOCK_FILES) {
    const path = entry.path(home);
    const config = await readJsonOrUndefined(path);
    if (config === undefined) continue;
    pushEnvBlock(entry.source, path, config?.env, entry.pointer);
  }
  for (const entry of TOKEN_FIELDS) {
    const path = entry.path(home);
    const config = await readJsonOrUndefined(path);
    if (config === undefined) continue;
    const value = config?.[entry.field];
    if (typeof value !== 'string' || value === '') continue;
    if (!looksSecretValue(value)) {
      skippedNonSecret += 1;
      continue;
    }
    candidates.push({
      name: entry.variable,
      value,
      source: entry.source,
      origin: `${path} → ${entry.field}`,
      originPath: path,
      kind: 'token',
      pointer: entry.field,
    });
  }

  // MCP servers: `env` values and `headers` tokens, from the same raw parse the
  // MCP inventory uses.
  const raw = await scanRawMcpServers({ homeDir: home });
  for (const server of raw) {
    const definition = server.raw !== null && typeof server.raw === 'object' ? server.raw : {};
    const env = definition.env !== null && typeof definition.env === 'object' ? definition.env : {};
    for (const [name, value] of Object.entries(env)) {
      const text = String(value ?? '');
      // `env_vars` (Codex) names a variable without a value: `${VAR}` is a pointer,
      // not a value, and must not be written as one.
      const reference = envReferenceOf(text);
      if (reference !== '') {
        candidates.push({
          name: reference,
          value: '',
          source: server.source,
          origin: `${server.configPath} → mcpServers.${server.name}.env_vars`,
          originPath: server.configPath,
          kind: 'reference',
          pointer: `mcpServers.${server.name}.env_vars`,
          server: server.name,
        });
        continue;
      }
      if (!isCredentialEntry(name, text)) {
        skippedNonSecret += 1;
        continue;
      }
      candidates.push({
        name,
        value: text,
        source: server.source,
        origin: `${server.configPath} → mcpServers.${server.name}.env.${name}`,
        originPath: server.configPath,
        kind: 'env',
        pointer: `mcpServers.${server.name}.env`,
        server: server.name,
      });
    }
    const headers = definition.headers !== null && typeof definition.headers === 'object' ? definition.headers : {};
    for (const [header, value] of Object.entries(headers)) {
      const text = String(value ?? '');
      const reference = envReferenceOf(text);
      const variable = reference !== '' ? reference : headerReferenceName(server.name, header);
      candidates.push({
        name: variable,
        value: reference !== '' ? '' : stripScheme(text),
        source: server.source,
        origin: `${server.configPath} → mcpServers.${server.name}.headers.${header}`,
        originPath: server.configPath,
        kind: reference !== '' ? 'reference' : 'header',
        pointer: `mcpServers.${server.name}.headers`,
        server: server.name,
      });
    }
  }

  return { candidates, skippedNonSecret };
}

/**
 * Build the public inventory rows of the `secrets` type.
 *
 * The returned rows never contain a value: only `valueLength` and `masked`.
 *
 * @param options - `{ homeDir, userEnvNames, overwrite }`; `userEnvNames` is a Set
 *   of names already present in the Windows User scope.
 * @returns `{ items, skippedNonSecret, userEnvCount }`.
 */
export async function scanSecrets(options = {}) {
  const { candidates, skippedNonSecret } = await collectSecretCandidates(options);
  const userEnvNames = options.userEnvNames instanceof Set ? options.userEnvNames : new Set();
  const overwrite = options.overwrite === true;

  /** First row wins a name; the rest explain why they are not offered. */
  const chosen = new Map();
  const items = [];
  for (const candidate of candidates) {
    const valid = VALID_NAME.test(candidate.name);
    const length = lengthOf(candidate.value);
    const row = {
      type: 'secrets',
      id: `secrets:${candidate.source}:${candidate.name}`,
      source: candidate.source,
      sourceLabel: SOURCE_LABELS[candidate.source] ?? candidate.source,
      name: candidate.name,
      kind: candidate.kind,
      origin: candidate.origin,
      originPath: candidate.originPath,
      pointer: candidate.pointer,
      server: candidate.server ?? '',
      valueLength: length,
      masked: length === 0 ? '' : '••••',
      target: 'Переменные окружения пользователя (User scope)',
    };
    if (!valid) {
      row.status = 'invalid';
      row.selectable = false;
      row.note = 'имя не годится для переменной окружения Windows';
      items.push(row);
      continue;
    }
    const previous = chosen.get(candidate.name);
    if (previous !== undefined) {
      const same = previous.value === candidate.value;
      row.status = same ? 'duplicate' : 'conflict';
      row.selectable = false;
      row.note = same
        ? `то же значение уже предлагается из ${previous.source}`
        : `в ${previous.source} у этой переменной ДРУГОЕ значение — разберитесь вручную, автоматически переносить нельзя`;
      items.push(row);
      continue;
    }
    chosen.set(candidate.name, candidate);
    if (length === 0) {
      row.status = 'empty';
      row.selectable = false;
      row.note =
        candidate.kind === 'reference'
          ? 'в конфиге только имя переменной, значения нет — переносить нечего'
          : 'значение пустое — переносить нечего';
      items.push(row);
      continue;
    }
    if (userEnvNames.has(candidate.name)) {
      row.status = 'set';
      row.selectable = overwrite;
      row.note = overwrite
        ? 'уже задана в переменных окружения пользователя — будет ПЕРЕЗАПИСАНА'
        : 'уже задана в переменных окружения пользователя — перезапись только с флагом «перезаписать»';
      items.push(row);
      continue;
    }
    row.status = 'new';
    row.selectable = true;
    row.note = 'будет записана в переменные окружения пользователя (User scope)';
    items.push(row);
  }

  // Credential-looking first: the owner should not have to scroll past duplicates.
  const order = { new: 0, set: 1, empty: 2, conflict: 3, duplicate: 4, invalid: 5 };
  items.sort((left, right) => (order[left.status] ?? 9) - (order[right.status] ?? 9) || left.name.localeCompare(right.name));

  return { items, skippedNonSecret, userEnvCount: userEnvNames.size };
}

/**
 * Resolve the VALUES of the named variables.
 *
 * Called only by the writer, in the same tick as the write; the result is not
 * serialisable into any route response on purpose.
 *
 * @param names - variable names to resolve.
 * @param options - `{ homeDir }` override for tests.
 * @returns a Map name → `{ value, origin, source }`, first origin wins.
 */
export async function resolveSecretValues(names, options = {}) {
  const wanted = new Set((names ?? []).map((name) => String(name)));
  const { candidates } = await collectSecretCandidates(options);
  const resolved = new Map();
  for (const candidate of candidates) {
    if (!wanted.has(candidate.name)) continue;
    if (resolved.has(candidate.name)) continue;
    if (candidate.value === '') continue;
    resolved.set(candidate.name, { value: candidate.value, origin: candidate.origin, source: candidate.source, length: lengthOf(candidate.value) });
  }
  return resolved;
}

/** The names already present in the Windows User scope. */
export async function userEnvironmentNames(options = {}) {
  if (options.userEnvNames instanceof Set) return options.userEnvNames;
  return await listUserEnvironmentNames(options);
}

/** Whether a resolved value still looks usable (a `readTextOrUndefined` sanity hook). */
export async function configReadable(path) {
  return (await readTextOrUndefined(path)) !== undefined;
}
