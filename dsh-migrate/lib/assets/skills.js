/**
 * Skill inventory and copy.
 *
 * Which root DSH really reads is not a guess: `@deepseek-ai/dsh-skill-filesystem`
 * registers the `user-dsh` root at `join(resolveDshHome(), 'skills')` (rank 400)
 * and the `user-agents` root at `join(resolveAgentsHome(), 'skills')` (rank 500).
 * A lower rank wins, so:
 *
 *  - `<DSH_HOME>/skills` is the copy target — it is DSH-owned and editable;
 *  - `~/.agents/skills` needs no import at all: DSH already lists those skills;
 *  - a foreign skill whose name already resolves from `~/.agents/skills` is marked
 *    `available`, never `new`, because copying it would only shadow the same skill
 *    with a possibly older copy.
 */
import { cp, mkdir, readdir, readFile, realpath, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  agentsSkillsRoot,
  directoryExists,
  dshSkillsRoot,
  readHead,
  stampForFile,
  statOrUndefined,
  userHome,
} from './paths.js';

/** Foreign agent skill roots, in the order that decides a name clash. */
export const SKILL_ROOTS = [
  { id: 'claude-code', label: 'Claude Code', dir: () => join(userHome(), '.claude', 'skills'), kind: 'agent' },
  { id: 'codex', label: 'Codex', dir: () => join(userHome(), '.codex', 'skills'), kind: 'agent' },
  { id: 'zcode', label: 'ZCode', dir: () => join(userHome(), '.zcode', 'skills'), kind: 'agent' },
  { id: 'shared', label: 'Общие ~/.agents', dir: () => join(userHome(), '.agents', 'skills'), kind: 'agent' },
];

/** Sources whose skills DSH already reads without any import. */
const ALREADY_READ_SOURCES = new Set(['shared']);

/** Filesystem mtime jitter tolerated before a copy counts as newer. */
const UPDATE_TOLERANCE_MS = 2000;

/** Bound on the size walk of one skill directory. */
const SIZE_WALK_LIMIT = 400;

/** A directory name that can be a skill folder. */
function isSafeName(name) {
  const text = String(name ?? '');
  if (text === '' || text === '.' || text === '..') return false;
  return !/[/\\:*?"<>|]/u.test(text);
}

/** Parse the `description:` line of a skill's YAML front matter. */
export function descriptionOfSkill(text) {
  if (typeof text !== 'string') return '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  const front = match === null ? text : match[1];
  const line = /^\s*description\s*:\s*(.+)$/imu.exec(front);
  if (line === null) return '';
  return line[1].trim().replace(/^['"]|['"]$/gu, '').slice(0, 220);
}

/** Parse the `name:` line of a skill's front matter, if it has one. */
export function declaredNameOfSkill(text) {
  if (typeof text !== 'string') return '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  const front = match === null ? '' : match[1];
  const line = /^\s*name\s*:\s*(.+)$/imu.exec(front);
  return line === null ? '' : line[1].trim().replace(/^['"]|['"]$/gu, '');
}

/** Total size of the regular files of one directory, bounded. */
export async function directorySize(root) {
  let total = 0;
  let seen = 0;
  const walk = async (dir) => {
    if (seen > SIZE_WALK_LIMIT) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > SIZE_WALK_LIMIT) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const info = await statOrUndefined(path);
      if (info !== undefined && info.isFile()) total += info.size;
    }
  };
  await walk(root);
  return total;
}

/** One version directory of a plugin cache: the newest one wins. */
async function newestVersionDir(root) {
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
    const skills = join(path, 'skills');
    if (!existsSync(skills)) continue;
    const info = await statOrUndefined(skills);
    candidates.push({ path, version: entry.name, mtime: info?.mtimeMs ?? 0 });
  }
  if (candidates.length === 0) return '';
  candidates.sort((left, right) => {
    const byVersion = right.version.localeCompare(left.version, undefined, { numeric: true });
    if (byVersion !== 0) return byVersion;
    return right.mtime - left.mtime;
  });
  return candidates[0].path;
}

/**
 * Skill roots contributed by ENABLED plugins.
 *
 * A plugin runtime is platform-specific and cannot be imported, but the skills a
 * plugin ships are ordinary directories and can be copied like any other skill.
 * Only plugins that the origin agent reports as enabled are considered, so an
 * abandoned cache version never turns into an import row.
 */
export async function pluginSkillRoots() {
  const roots = [];
  const settingsPath = join(userHome(), '.claude', 'settings.json');
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch {
    return roots;
  }
  const enabled = settings?.enabledPlugins;
  if (enabled === null || typeof enabled !== 'object') return roots;
  const cache = join(userHome(), '.claude', 'plugins', 'cache');
  for (const [key, value] of Object.entries(enabled)) {
    if (value !== true) continue;
    const separator = key.lastIndexOf('@');
    if (separator <= 0) continue;
    const plugin = key.slice(0, separator);
    const marketplace = key.slice(separator + 1);
    const versionDir = await newestVersionDir(join(cache, marketplace, plugin));
    if (versionDir === '') continue;
    roots.push({
      id: `plugin:${marketplace}/${plugin}`,
      label: `Плагин ${plugin} (${marketplace})`,
      dir: () => join(versionDir, 'skills'),
      kind: 'plugin',
      pluginPath: versionDir,
    });
  }
  return roots;
}

/** Every skill root the scan reads, agent roots first. */
export async function allSkillRoots() {
  return [...SKILL_ROOTS, ...(await pluginSkillRoots())];
}

/** List the skill directories of one root. */
async function listSkillsInRoot(root) {
  let entries;
  try {
    entries = await readdir(root.dir(), { withFileTypes: true });
  } catch {
    return { available: false, reason: 'каталог не найден', skills: [] };
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!isSafeName(entry.name)) continue;
    const path = join(root.dir(), entry.name);
    let realPath = path;
    try {
      realPath = await realpath(path);
    } catch {
      /* a broken symlink still shows up as a row */
    }
    const info = await statOrUndefined(realPath);
    // A broken junction keeps its row: dropping it silently would hide a skill the
    // origin agent still advertises, and the owner should see that it is broken.
    const broken = info === undefined;
    const manifest = join(realPath, 'SKILL.md');
    const head = broken ? '' : existsSync(manifest) ? await readHead(manifest, 8192) : '';
    skills.push({
      name: entry.name,
      path,
      realPath,
      broken,
      hasManifest: head !== '',
      description: descriptionOfSkill(head),
      declaredName: declaredNameOfSkill(head),
      sizeBytes: broken ? 0 : await directorySize(realPath),
      updatedAt: info?.mtimeMs ?? 0,
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { available: true, reason: '', skills };
}

/**
 * Classify one skill row against the DSH-owned root.
 * @param row - a scanned skill.
 * @param context - shared scan facts (target root, shared names, ledger).
 * @returns `{ status, selectable, note }`.
 */
export function classifySkill(row, context) {
  if (row.broken === true) {
    return { status: 'invalid', selectable: false, note: 'битая ссылка: цель ссылки не существует' };
  }
  if (row.hasManifest !== true) {
    return { status: 'invalid', selectable: false, note: 'нет файла SKILL.md — DSH такой каталог скилом не считает' };
  }
  const targetInfo = context.targetInfo?.get(row.name);
  if (targetInfo !== undefined && targetInfo !== null) {
    const newer = Number(row.updatedAt) - Number(targetInfo.mtimeMs ?? 0);
    if (newer > UPDATE_TOLERANCE_MS) {
      return { status: 'update', selectable: true, note: `исходник новее цели на ${Math.round(newer / 1000)} с — при импорте старая копия уйдёт в .bak` };
    }
    return { status: 'exists', selectable: false, note: 'в ~/.dsh/skills уже есть такой же (или более новый) скил' };
  }
  if (context.sharedNames?.has(row.name) === true || ALREADY_READ_SOURCES.has(row.source)) {
    return {
      status: 'available',
      selectable: false,
      note: 'DSH уже читает этот скил напрямую из ~/.agents/skills — импорт не нужен',
    };
  }
  if (typeof context.claimedBy?.get(row.name) === 'string' && context.claimedBy.get(row.name) !== `${row.source}:${row.name}`) {
    return { status: 'duplicate', selectable: false, note: `то же имя уже занято источником ${context.claimedBy.get(row.name)}` };
  }
  return { status: 'new', selectable: true, note: 'будет скопирован в ~/.dsh/skills' };
}

/**
 * Scan every skill root and classify every row.
 * @param options - `{ skillsRoot }` override for tests.
 * @returns inventory rows plus the root summary.
 */
export async function scanSkills(options = {}) {
  const root = options.skillsRoot ?? dshSkillsRoot();
  const agentsRoot = options.agentsRoot ?? agentsSkillsRoot();
  const ledger = options.ledger ?? { entries: {} };
  // `roots` lets a test drive the classifier over synthetic directories instead of
  // the real home directory.
  const roots = Array.isArray(options.roots) ? options.roots : await allSkillRoots();

  const perRoot = [];
  for (const definition of roots) {
    const listed = await listSkillsInRoot(definition);
    perRoot.push({ definition, ...listed, path: definition.dir() });
  }

  // The shared root's names are the ones DSH already resolves without an import.
  const sharedNames = new Set();
  for (const rootState of perRoot) {
    if (rootState.definition.id !== 'shared') continue;
    for (const skill of rootState.skills) sharedNames.add(skill.name);
  }
  // A skill that is physically present under ~/.agents/skills counts too, even
  // when the shared root itself was unreadable for another reason.
  let agentsEntries = [];
  try {
    agentsEntries = await readdir(agentsRoot, { withFileTypes: true });
  } catch {
    agentsEntries = [];
  }
  for (const entry of agentsEntries) if (entry.isDirectory()) sharedNames.add(entry.name);

  const targetInfo = new Map();
  let targetEntries = [];
  try {
    targetEntries = await readdir(root, { withFileTypes: true });
  } catch {
    targetEntries = [];
  }
  for (const entry of targetEntries) {
    if (!entry.isDirectory()) continue;
    const info = await statOrUndefined(join(root, entry.name));
    if (info !== undefined) targetInfo.set(entry.name, info);
  }

  // Clash resolution: a row claims a name only when nothing better owns it.
  const claimedBy = new Map();
  const rows = [];
  for (const rootState of perRoot) {
    for (const skill of rootState.skills) {
      const row = {
        type: 'skills',
        id: `${rootState.definition.id}:${skill.name}`,
        source: rootState.definition.id,
        sourceLabel: rootState.definition.label,
        kind: rootState.definition.kind,
        name: skill.name,
        path: skill.path,
        realPath: skill.realPath,
        broken: skill.broken === true,
        hasManifest: skill.hasManifest,
        description: skill.description,
        sizeBytes: skill.sizeBytes,
        updatedAt: skill.updatedAt,
        target: join(root, skill.name),
      };
      rows.push(row);
      if (skill.hasManifest && !targetInfo.has(skill.name) && !sharedNames.has(skill.name) && !claimedBy.has(skill.name)) {
        claimedBy.set(skill.name, `${row.source}:${row.name}`);
      }
    }
  }
  for (const row of rows) {
    const classified = classifySkill(
      { ...row, source: row.source },
      { targetInfo, sharedNames, claimedBy, ledger },
    );
    row.status = classified.status;
    row.selectable = classified.selectable;
    row.note = classified.note;
    const previous = ledger.entries?.[`skills:${row.source}:${row.name}`];
    if (previous !== undefined) row.importedAt = previous.appliedAt ?? 0;
  }

  return {
    roots: perRoot.map((rootState) => ({
      id: rootState.definition.id,
      label: rootState.definition.label,
      kind: rootState.definition.kind,
      path: rootState.path,
      available: rootState.available,
      reason: rootState.reason,
      count: rootState.skills.length,
    })),
    items: rows,
    targetRoot: root,
    sharedRoot: agentsRoot,
    alreadyReadCount: sharedNames.size,
  };
}

/**
 * Copy one skill into the DSH-owned root.
 *
 * @param row - an inventory row (`name`, `realPath`, `source`).
 * @param options - `{ skillsRoot }` override for tests.
 * @returns a per-item report the run route returns verbatim.
 */
export async function copySkill(row, options = {}) {
  const root = options.skillsRoot ?? dshSkillsRoot();
  const name = String(row?.name ?? '');
  if (!isSafeName(name)) return { id: row?.id ?? '', action: 'failed', reason: `недопустимое имя скила: "${name}"` };
  if (typeof row.realPath !== 'string' || row.realPath === '') return { id: row?.id ?? '', action: 'failed', reason: 'не удалось определить каталог источника' };

  const destination = join(root, name);
  const sourceInfo = await statOrUndefined(row.realPath);
  if (sourceInfo === undefined) return { id: row.id, action: 'failed', reason: 'каталог источника исчез' };
  if (!existsSync(join(row.realPath, 'SKILL.md'))) {
    return { id: row.id, action: 'skipped', reason: 'нет SKILL.md — DSH такой каталог скилом не считает' };
  }

  const targetInfo = await statOrUndefined(destination);
  let backupPath = '';
  try {
    await mkdir(root, { recursive: true });
    if (targetInfo !== undefined) {
      const newer = Number(sourceInfo.mtimeMs ?? 0) - Number(targetInfo.mtimeMs ?? 0);
      if (newer <= UPDATE_TOLERANCE_MS) {
        return { id: row.id, action: 'skipped', reason: `уже есть: ${destination}` };
      }
      backupPath = `${destination}.bak-${stampForFile(Date.now())}`;
      await rename(destination, backupPath);
    }
    await cp(row.realPath, destination, { recursive: true, force: false, errorOnExist: false, dereference: true });
  } catch (error) {
    return { id: row.id, action: 'failed', reason: error?.message ?? String(error) };
  }
  const verified = existsSync(join(destination, 'SKILL.md'));
  return {
    id: row.id,
    action: backupPath === '' ? 'copied' : 'updated',
    status: verified ? 'ok' : 'unverified',
    target: destination,
    backupPath,
    reason: verified ? '' : 'каталог скопирован, но SKILL.md в цели не найден',
  };
}

/** Whether the DSH skill root exists (the panel shows the target row). */
export async function skillsRootAvailable() {
  return directoryExists(dshSkillsRoot());
}
