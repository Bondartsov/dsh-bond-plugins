/**
 * Filesystem locations of the assets-import plugin.
 *
 * Everything here is read-only with respect to foreign agent stores: the plugin
 * reads `~/.claude`, `~/.codex`, `~/.zcode`, `~/.agents`, `~/.kilocode` and
 * `~/.config/opencode`, and writes only under the DSH home (plus the profile
 * patch, which is the one privileged path and is handled in `lib/mcp.js`).
 */
import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The per-user DSH home; the Host exports `DSH_HOME`. */
export function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return join(homedir(), '.dsh');
}

/** The shared agent root; DSH reads skills from `<agentsHome>/skills` too. */
export function agentsHome() {
  const configured = process.env.DSH_AGENTS_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return join(homedir(), '.agents');
}

/** One path inside the DSH home. */
export function dshPath(...segments) {
  return join(dshHome(), ...segments);
}

/**
 * The active profile directory.
 *
 * The Host exports `DSH_PROFILE_DIR`; a standalone run falls back to
 * `<dshHome>/profiles/<DSH_PROFILE|desktop>` so a test can point elsewhere.
 */
export function profileDir() {
  const configured = process.env.DSH_PROFILE_DIR;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  const profile = process.env.DSH_PROFILE;
  const name = typeof profile === 'string' && profile.trim() !== '' ? profile.trim() : 'desktop';
  return join(dshHome(), 'profiles', name);
}

/** The profile patch this plugin may append MCP rows to. */
export function profilePatchPath() {
  return join(profileDir(), 'cordis.patch.yml');
}

/**
 * The DSH-owned user skill root.
 *
 * Verified against the shipped `@deepseek-ai/dsh-skill-filesystem` provider:
 * its `user-dsh` root is `join(resolveDshHome(), 'skills')`, rank 400, and it
 * beats `user-agents` (rank 500). That makes `<dshHome>/skills` the only honest
 * copy target for an imported skill.
 */
export function dshSkillsRoot() {
  return join(dshHome(), 'skills');
}

/** The DSH-owned shared agent skill root (already read by DSH, rank 500). */
export function agentsSkillsRoot() {
  return join(agentsHome(), 'skills');
}

/** The one durable directory of the unified migration plugin. */
export function migrateDir() {
  return join(dshHome(), 'dsh-migrate');
}

/** Durable state of this plugin: ledger, instruction copies, proposals. */
export function assetsImportDir() {
  return migrateDir();
}

/**
 * Directory of the predecessor plugin (`@local/dsh-assets-import`).
 *
 * Read-only fallback for its ledger, so repeated imports stay idempotent after
 * the merge; new writes land under `migrateDir()`.
 */
export function legacyAssetsImportDir() {
  return join(dshHome(), 'assets-import');
}

/** Where copied instruction documents land (never the profile). */
export function instructionsDir() {
  return join(assetsImportDir(), 'instructions');
}

/** Instruction copies of the predecessor plugin; read-only fallback. */
export function legacyInstructionsDir() {
  return join(legacyAssetsImportDir(), 'instructions');
}

/** The user's home directory. */
export function userHome() {
  return homedir();
}

/** Whether a path exists and is a directory. */
export async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path exists and is a regular file. */
export async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Stat a path, or `undefined` when it cannot be read. */
export async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/** Read a whole UTF-8 file, or `undefined` when it cannot be read. */
export async function readTextOrUndefined(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Read a JSON file, or `undefined` when it is missing or malformed. */
export async function readJsonOrUndefined(path) {
  const text = await readTextOrUndefined(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Read at most `count` bytes from the start of a file.
 * @param path - file path.
 * @param count - byte budget.
 * @returns the decoded text, possibly cut mid-line.
 */
export async function readHead(path, count) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
  }
}

/** Human-facing timestamp in the project's date format (`ДД.ММ.ГГГГ ЧЧ:ММ:СС`). */
export function formatTime(milliseconds) {
  const date = new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** A filesystem-safe timestamp for backup file names. */
export function stampForFile(milliseconds) {
  const date = new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
