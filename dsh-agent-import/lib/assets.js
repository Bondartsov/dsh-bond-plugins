/**
 * Inventory and migration of the non-session assets: skills, plugins, MCP
 * servers and configs.
 *
 * Two rules shape this module:
 *  - a foreign store is read-only; skills are COPIED into the DSH-owned skill
 *    root, never linked back into a foreign directory;
 *  - the plugin never edits the profile patch. MCP servers are proposed as a
 *    ready-to-paste `- insert:` fragment, because adding a profile row is the
 *    plugin manager's job and secrets must stay environment references.
 */
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { agentImportDir, directoryExists, dshPath, readHead, readJsonOrUndefined, readTextOrUndefined, userHome } from './paths.js';

/** Skill roots of the supported agents, in display order. */
const SKILL_ROOTS = [
  { id: 'claude-code', label: 'Claude Code', dir: () => join(userHome(), '.claude', 'skills') },
  { id: 'codex', label: 'Codex', dir: () => join(userHome(), '.codex', 'skills') },
  { id: 'zcode', label: 'ZCode', dir: () => join(userHome(), '.zcode', 'skills') },
  { id: 'shared', label: 'Shared ~/.agents', dir: () => join(userHome(), '.agents', 'skills') },
];

/** Plugin roots of the supported agents. */
const PLUGIN_ROOTS = [
  { id: 'claude-code', label: 'Claude Code', dir: () => join(userHome(), '.claude', 'plugins') },
  { id: 'codex', label: 'Codex', dir: () => join(userHome(), '.codex', 'plugins') },
  { id: 'zcode', label: 'ZCode', dir: () => join(userHome(), '.zcode', 'plugin-workspace') },
];

/** Config files worth reporting, never read: secrets live in several of them. */
const CONFIG_FILES = [
  { id: 'claude-code', label: 'Claude Code settings', path: () => join(userHome(), '.claude', 'settings.json') },
  { id: 'codex', label: 'Codex config', path: () => join(userHome(), '.codex', 'config.toml') },
  { id: 'zcode', label: 'ZCode settings', path: () => join(userHome(), '.zcode', 'settings.json') },
  { id: 'kilo', label: 'Kilo settings', path: () => join(userHome(), '.kilocode', 'settings.json') },
];

/** Coerce a value to text. */
const textOf = (value) => (typeof value === 'string' ? value : '');

/** Human-facing timestamp in the project's date format. */
export function formatTime(milliseconds) {
  const date = new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now());
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Turn a server name into a stable profile row id. */
function slugOf(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `mcp-${slug === '' ? 'server' : slug}`;
}

/** Parse the `description:` line of a skill's front matter. */
function descriptionOfSkill(text) {
  if (typeof text !== 'string') return '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  const front = match === null ? text : match[1];
  const line = /^\s*description\s*:\s*(.+)$/imu.exec(front);
  if (line === null) return '';
  return line[1].trim().replace(/^['"]|['"]$/gu, '').slice(0, 200);
}

/** List the skill directories of one root. */
async function listSkillsIn(root) {
  let entries;
  try {
    entries = await readdir(root.dir(), { withFileTypes: true });
  } catch {
    return { available: false, skills: [] };
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(root.dir(), entry.name);
    let linked = false;
    try {
      const info = await stat(path);
      linked = info.isSymbolicLink?.() === true;
    } catch {
      continue;
    }
    const manifest = join(path, 'SKILL.md');
    const head = existsSync(manifest) ? await readHead(manifest, 4096) : '';
    let target;
    try {
      const { realpath } = await import('node:fs/promises');
      target = await realpath(path);
    } catch {
      target = path;
    }
    skills.push({
      name: entry.name,
      path,
      target,
      linked,
      hasManifest: head !== '',
      description: descriptionOfSkill(head),
      alreadyInDsh: existsSync(dshPath('skills', entry.name)),
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { available: true, skills };
}

/** Names of the plugin directories of one root. */
async function listPluginsIn(root) {
  let entries;
  try {
    entries = await readdir(root.dir(), { withFileTypes: true });
  } catch {
    return { available: false, plugins: [] };
  }
  const plugins = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: join(root.dir(), entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { available: true, plugins };
}

/** Parse `[mcp_servers.<name>]` sections of a Codex `config.toml`. */
async function readCodexMcpServers() {
  const text = await readTextOrUndefined(join(userHome(), '.codex', 'config.toml'));
  if (text === undefined) return [];
  const servers = [];
  let current;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const section = /^\[mcp_servers\.(?:"([^"]+)"|([^\]]+))\]$/u.exec(line);
    if (section !== null) {
      current = { name: (section[1] ?? section[2] ?? '').trim(), command: '', url: '', args: [], transport: '' };
      servers.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('[')) {
      current = undefined;
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/u.exec(line);
    if (assignment === null) continue;
    const key = assignment[1];
    const value = assignment[2].trim();
    if (key === 'command') current.command = value.replace(/^['"]|['"]$/gu, '');
    else if (key === 'url') current.url = value.replace(/^['"]|['"]$/gu, '');
    else if (key === 'transport') current.transport = value.replace(/^['"]|['"]$/gu, '');
    else if (key === 'args') {
      try {
        const parsed = JSON.parse(value.replace(/,\s*\]$/u, ']'));
        if (Array.isArray(parsed)) current.args = parsed.map((item) => String(item));
      } catch {
        current.args = [];
      }
    }
    /* env blocks are deliberately not read: they carry tokens */
  }
  return servers.filter((server) => server.name !== '');
}

/** ZCode keeps one directory per MCP server; only names are read. */
async function readZcodeMcpServers() {
  const root = join(userHome(), '.zcode', 'mcp-servers');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.name.endsWith('.json'))
    .map((entry) => ({
      name: entry.name.replace(/\.json$/u, ''),
      command: '',
      url: '',
      args: [],
      transport: '',
      note: entry.isDirectory() ? `directory ${join(root, entry.name)}` : `file ${join(root, entry.name)}`,
    }));
}

/**
 * Claude Code keeps MCP servers inside `~/.claude.json`. Only the server name and
 * the transport kind are extracted; `env` and `headers` are never read.
 */
async function readClaudeMcpServers() {
  const config = await readJsonOrUndefined(join(userHome(), '.claude.json'));
  const servers = config?.mcpServers;
  if (servers === null || typeof servers !== 'object') return [];
  const rows = [];
  for (const [name, value] of Object.entries(servers)) {
    if (value === null || typeof value !== 'object') continue;
    rows.push({
      name,
      command: textOf(value.command),
      url: textOf(value.url),
      args: Array.isArray(value.args) ? value.args.map((item) => String(item)) : [],
      transport: textOf(value.type) || textOf(value.transport),
      redacted: true,
    });
  }
  return rows;
}

/** Whether the running profile already configures one MCP server name. */
async function configuredMcpNames() {
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir !== 'string' || profileDir === '') return new Set();
  const text = await readTextOrUndefined(join(profileDir, 'cordis.patch.yml'));
  if (text === undefined) return new Set();
  const names = new Set();
  for (const match of text.matchAll(/^\s*serverName:\s*(.+)$/gmu)) names.add(match[1].trim().replace(/^['"]|['"]$/gu, ''));
  return names;
}

/** Inventory of every non-session asset. */
export async function assetsInventory() {
  const skills = [];
  for (const root of SKILL_ROOTS) {
    const listed = await listSkillsIn(root);
    skills.push({ ...root, ...listed, path: root.dir() });
  }

  const plugins = [];
  for (const root of PLUGIN_ROOTS) {
    const listed = await listPluginsIn(root);
    plugins.push({ ...root, ...listed, path: root.dir() });
  }

  const mcp = [
    ...(await readClaudeMcpServers()).map((server) => ({ source: 'claude-code', ...server })),
    ...(await readCodexMcpServers()).map((server) => ({ source: 'codex', ...server })),
    ...(await readZcodeMcpServers()).map((server) => ({ source: 'zcode', ...server })),
  ];
  const configured = await configuredMcpNames();
  for (const server of mcp) server.alreadyConfigured = configured.has(server.name);

  const configs = [];
  for (const entry of CONFIG_FILES) {
    const info = await stat(entry.path()).catch(() => undefined);
    configs.push({
      id: entry.id,
      label: entry.label,
      path: entry.path(),
      present: info !== undefined,
      sizeBytes: info?.size ?? 0,
      updatedAt: info?.mtimeMs ?? 0,
      note: info === undefined ? '' : 'reported only; this plugin never reads or edits a foreign config',
    });
  }

  return {
    skills: {
      roots: skills.map((root) => ({ id: root.id, label: root.label, path: root.path, available: root.available, count: root.skills.length })),
      items: skills.flatMap((root) => root.skills.map((skill) => ({ ...skill, source: root.id }))),
      dshRoot: dshPath('skills'),
    },
    plugins: {
      roots: plugins.map((root) => ({ id: root.id, label: root.label, path: root.path, available: root.available, count: root.plugins.length })),
      items: plugins.flatMap((root) => root.plugins.map((plugin) => ({ ...plugin, source: root.id }))),
      note: 'A plugin runtime is platform-specific and cannot be imported; only its skills and MCP servers travel.',
    },
    mcp: { items: mcp, note: 'Values of env and headers are never exported; secrets stay environment references.' },
    configs,
    generatedAt: Date.now(),
  };
}

/** Build the `- insert:` fragment for the MCP servers the profile lacks. */
export async function mcpProposal() {
  const inventory = await assetsInventory();
  const rows = inventory.mcp.items.filter((server) => server.alreadyConfigured !== true);
  const lines = [
    `# Generated by @local/dsh-agent-import ${formatTime(Date.now())}.`,
    '# Paste under the profile patch (~/.dsh/profiles/<profile>/cordis.patch.yml), then restart DSH.',
    '# Review every row first: this plugin proposes, it never edits the profile.',
    '# Secrets must stay environment references, for example:',
    "#   headers:",
    "#     Authorization: !!js '`Bearer ${process.env.YOUR_TOKEN}`'",
  ];
  if (rows.length === 0) {
    lines.push('# No new MCP servers were found: every detected server is already configured, or no server was detected.');
    return { text: lines.join('\n'), count: 0, rows: [] };
  }
  lines.push('- insert:');
  for (const server of rows) {
    const stdio = server.command !== '' && server.url === '';
    lines.push(`    - id: ${slugOf(server.name)}`);
    lines.push('      name: "@deepseek-ai/dsh-mcp-client"');
    lines.push('      config:');
    lines.push(`        serverName: ${JSON.stringify(server.name)}`);
    if (stdio) {
      lines.push('        transport: stdio');
      lines.push(`        command: ${JSON.stringify(server.command)}`);
      lines.push(`        args: ${JSON.stringify(server.args)}`);
    } else if (server.url !== '') {
      lines.push('        transport: streamable-http');
      lines.push(`        url: ${JSON.stringify(server.url)}`);
    } else {
      lines.push('        transport: stdio');
      lines.push('        command: "" # fill in the launch command of this server');
      lines.push('        args: []');
    }
  }
  return { text: lines.join('\n'), count: rows.length, rows: rows.map((server) => server.name) };
}

/** Persist the proposal next to the ledger and return its path. */
export async function writeMcpProposal() {
  const proposal = await mcpProposal();
  const directory = agentImportDir();
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'mcp-proposal.yml');
  await writeFile(path, `${proposal.text}\n`, 'utf8');
  return { path, count: proposal.count, rows: proposal.rows };
}

/** Copy the named foreign skills into the DSH-owned skill root. */
export async function copySkills(names) {
  const inventory = await assetsInventory();
  const byName = new Map();
  for (const skill of inventory.skills.items) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  const root = dshPath('skills');
  const copied = [];
  const skipped = [];
  const failed = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (skill === undefined) {
      failed.push({ name, reason: 'not found in any foreign skill root' });
      continue;
    }
    const destination = join(root, name);
    if (await directoryExists(destination)) {
      skipped.push({ name, reason: `already present at ${destination}` });
      continue;
    }
    try {
      await mkdir(root, { recursive: true });
      await cp(skill.target ?? skill.path, destination, { recursive: true, force: false, errorOnExist: false, dereference: true });
      copied.push({ name, destination });
    } catch (error) {
      failed.push({ name, reason: error?.message ?? String(error) });
    }
  }
  return { copied, skipped, failed, root };
}
