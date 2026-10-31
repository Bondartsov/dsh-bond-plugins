/**
 * Profile backup, mandatory before the plugin touches the profile patch.
 *
 * The snapshot script ships inside this package (`scripts/backup-profile.ps1`), so the path is not
 * tied to one machine: it copies `<profile>/cordis.patch.yml` into `<profile>/backups` as a dated
 * `.good` file. The plugin never edits the patch unless this script reported a saved copy.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Snapshot script shipped with this package; override with `DSH_ASSETS_BACKUP_SCRIPT`. */
export const DEFAULT_BACKUP_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'backup-profile.ps1',
);

/** Extra seconds allowed for the PowerShell snapshot. */
const BACKUP_TIMEOUT_MS = 60_000;

/** The snapshot script in effect for this run. */
export function backupScriptPath() {
  const configured = process.env.DSH_ASSETS_BACKUP_SCRIPT;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return DEFAULT_BACKUP_SCRIPT;
}

/**
 * Run one command and collect its output.
 * @param command - executable.
 * @param args - arguments.
 * @returns `{ code, stdout, stderr }`.
 */
function run(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error?.message ?? String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, BACKUP_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error?.message ?? String(error)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: Number.isFinite(code) ? code : -1, stdout, stderr });
    });
  });
}

/**
 * Snapshot the profile patch through the owner's script.
 *
 * @param options - `{ script }` override, mainly for tests.
 * @returns `{ ok, script, savedAs, output }`; `ok:false` must abort a write.
 */
export async function runProfileBackup(options = {}) {
  if (typeof options.runner === 'function') return await options.runner();
  const script = typeof options.script === 'string' && options.script !== '' ? options.script : backupScriptPath();
  if (typeof script !== 'string' || script === '') {
    return { ok: false, script: '', savedAs: '', output: 'скрипт резервной копии не задан' };
  }
  const result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const saved = /saved:\s*(\S+)/iu.exec(output);
  const ok = result.code === 0 && saved !== null;
  return {
    ok,
    script,
    savedAs: saved === null ? '' : saved[1],
    output: output.split(/\r?\n/u).slice(0, 12).join('\n'),
  };
}
