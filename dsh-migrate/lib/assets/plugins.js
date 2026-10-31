/**
 * Plugin inventory — informational by design.
 *
 * A plugin runtime is a platform-specific bundle; nothing of it can be imported
 * into DSH. What DOES travel are the skills and MCP servers a plugin ships, and
 * those appear as their own rows in the `skills` and `mcp` groups. This module
 * lists the plugins so the owner can see where those rows come from, and says so
 * in the row note instead of pretending a plugin is importable.
 */
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readJsonOrUndefined, statOrUndefined, userHome } from './paths.js';

/** How many skills a plugin cache directory ships. */
async function countSkills(directory) {
  try {
    const entries = await readdir(join(directory, 'skills'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

/** Newest version directory of one cached plugin. */
async function newestCacheDir(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return '';
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const info = await statOrUndefined(path);
    candidates.push({ path, version: entry.name, mtime: info?.mtimeMs ?? 0 });
  }
  candidates.sort((left, right) => {
    const byVersion = right.version.localeCompare(left.version, undefined, { numeric: true });
    return byVersion !== 0 ? byVersion : right.mtime - left.mtime;
  });
  return candidates[0]?.path ?? '';
}

/** Claude Code plugins: the ones the owner enabled, with their cache path. */
async function scanClaudePlugins() {
  const settings = await readJsonOrUndefined(join(userHome(), '.claude', 'settings.json'));
  const enabled = settings?.enabledPlugins;
  if (enabled === null || typeof enabled !== 'object') return [];
  const rows = [];
  for (const [key, value] of Object.entries(enabled)) {
    const separator = key.lastIndexOf('@');
    const name = separator > 0 ? key.slice(0, separator) : key;
    const marketplace = separator > 0 ? key.slice(separator + 1) : '';
    const cacheRoot = join(userHome(), '.claude', 'plugins', 'cache', marketplace, name);
    const cacheDir = await newestCacheDir(cacheRoot);
    const skills = cacheDir === '' ? 0 : await countSkills(cacheDir);
    rows.push({
      type: 'plugins',
      source: 'claude-code',
      sourceLabel: 'Claude Code',
      rawName: name,
      name,
      marketplace,
      enabled: value === true,
      path: cacheDir === '' ? cacheRoot : cacheDir,
      present: cacheDir !== '',
      skills,
    });
  }
  return rows;
}

/** ZCode plugins: the enablement list of its CLI config. */
async function scanZcodePlugins() {
  const config = await readJsonOrUndefined(join(userHome(), '.zcode', 'cli', 'config.json'));
  const enabled = config?.plugins?.enabledPlugins;
  if (enabled === null || typeof enabled !== 'object') return [];
  return Object.entries(enabled).map(([key, value]) => {
    const separator = key.lastIndexOf('@');
    const name = separator > 0 ? key.slice(0, separator) : key;
    const marketplace = separator > 0 ? key.slice(separator + 1) : '';
    const cacheRoot = join(userHome(), '.zcode', 'plugin-workspace', name);
    return {
      type: 'plugins',
      source: 'zcode',
      sourceLabel: 'ZCode',
      rawName: name,
      name,
      marketplace,
      enabled: value === true,
      path: cacheRoot,
      present: existsSync(cacheRoot),
      skills: 0,
    };
  });
}

/** Codex plugin caches: marketplaces only, codex keeps no enablement list here. */
async function scanCodexPlugins() {
  const root = join(userHome(), '.codex', 'plugins', 'cache');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      type: 'plugins',
      source: 'codex',
      sourceLabel: 'Codex',
      rawName: entry.name,
      name: entry.name,
      marketplace: entry.name,
      enabled: true,
      path: join(root, entry.name),
      present: true,
      skills: 0,
    }));
}

/**
 * Scan every plugin list.
 * @returns rows with `status: 'runtime'` — plugin runtimes are never importable.
 */
export async function scanPlugins() {
  const rows = [...(await scanClaudePlugins()), ...(await scanZcodePlugins()), ...(await scanCodexPlugins())];
  return rows.map((row) => ({
    ...row,
    type: 'plugins',
    status: 'runtime',
    selectable: false,
    target: '',
    note:
      row.skills > 0
        ? `рантайм плагина не переносится; его ${row.skills} скилов есть в разделе «Скилы» (источник plugin:${row.marketplace}/${row.name})`
        : 'рантайм плагина не переносится — переносятся только его скилы и MCP-записи (разделы «Скилы» и «MCP»)',
  }));
}
