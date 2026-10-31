/**
 * Writing secrets into the user's Windows environment — without putting a value
 * on a command line, in a log line, or in an error message.
 *
 * The only channel that carries a value is a temporary JSON file:
 *
 *  1. a private temporary directory is created and its ACL is narrowed to the
 *     current user (`icacls /inheritance:r /grant:r <user>:F`);
 *  2. `payload.json` is written there (also mode 0600);
 *  3. `set-user-env.ps1` is started with just the payload PATH on its argv and
 *     calls `[Environment]::SetEnvironmentVariable(name, value, 'User')` per row;
 *  4. the directory is removed, whatever happened;
 *  5. the write is verified by re-listing the User scope NAMES.
 *
 * `setx` is never used: it truncates long values and takes the value on argv.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The script that sets one variable per payload row. */
export const SET_ENV_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'set-user-env.ps1');

/** The script that lists the names of the user scope (names only, no values). */
export const LIST_ENV_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'list-user-env.ps1');

/** A variable name Windows accepts. */
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Budget for one PowerShell run. */
const SCRIPT_TIMEOUT_MS = 120_000;

/** The current account name, as `icacls` wants it. */
export function currentAccount() {
  const username = process.env.USERNAME;
  if (typeof username === 'string' && username.trim() !== '') return username.trim();
  const home = process.env.USERPROFILE;
  if (typeof home === 'string' && home.trim() !== '') return basename(home.trim());
  return '';
}

/**
 * Run one process, collecting only what the caller asks for.
 * @param command - executable.
 * @param args - arguments; must never contain a secret value.
 * @param options - `{ maxOutput }`.
 * @returns `{ code, stdout, stderr }`.
 */
export function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error?.message ?? String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const max = Number.isFinite(options.maxOutput) ? options.maxOutput : 256 * 1024;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, Number.isFinite(options.timeout) ? options.timeout : SCRIPT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < max) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < max) stderr += String(chunk);
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

/** Default runner; tests replace it to assert the argv. */
const defaultRunner = (command, args, options) => runProcess(command, args, options);

/**
 * List the names present in the Windows User scope.
 * Only names cross the process boundary — the script prints no value.
 *
 * @param options - `{ runner }` for tests.
 * @returns a Set of names (empty when the probe is unavailable).
 */
export async function listUserEnvironmentNames(options = {}) {
  const runner = typeof options.runner === 'function' ? options.runner : defaultRunner;
  const result = await runner('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LIST_ENV_SCRIPT], { timeout: SCRIPT_TIMEOUT_MS });
  if (result.code !== 0) return new Set();
  const text = String(result.stdout ?? '').trim();
  if (text === '') return new Set();
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return new Set(list.filter((entry) => typeof entry === 'string' && entry !== ''));
  } catch {
    return new Set();
  }
}

/**
 * Narrow a directory to the current account only.
 * @param directory - the temporary directory.
 * @param runner - process runner.
 * @param account - account name.
 * @returns `{ applied, reason }`.
 */
async function tightenAcl(directory, runner, account) {
  if (account === '') return { applied: false, reason: 'не удалось определить имя пользователя для ACL' };
  const result = await runner('icacls', [directory, '/inheritance:r', '/grant:r', `${account}:F`], { timeout: 30_000 });
  if (result.code !== 0) {
    return { applied: false, reason: `icacls завершился с кодом ${result.code}` };
  }
  return { applied: true, reason: '' };
}

/**
 * Delete the payload directory and prove it is gone.
 *
 * A leftover payload file would be a leak on disk, so a failed removal is a hard
 * failure of the whole write, not a warning.
 *
 * @param directory - the temporary directory.
 * @param payloadPath - the file that held the values.
 * @returns `{ deleted, reason }`.
 */
export async function removePayload(directory, payloadPath) {
  let reason = '';
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    reason = error?.message ?? String(error);
  }
  const fileGone = !existsSync(payloadPath);
  const directoryGone = !existsSync(directory);
  return {
    deleted: fileGone && directoryGone,
    reason: fileGone && directoryGone ? '' : reason || 'файл или каталог с секретами остался на диске',
  };
}

/**
 * Write variables into the user's Windows environment.
 *
 * @param entries - `[{ name, value }]` — the ONLY place a value is accepted.
 * @param options - `{ runner, account, verify, keepPayload }` for tests.
 * @returns `{ ok, written, failed, acl, payloadDeleted, verified, error }`; `written`
 *   holds names and lengths, never values.
 */
export async function writeUserEnvironment(entries, options = {}) {
  const runner = typeof options.runner === 'function' ? options.runner : defaultRunner;
  const account = typeof options.account === 'string' && options.account !== '' ? options.account : currentAccount();
  const wanted = [];
  const failed = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name ?? '');
    const value = entry?.value;
    if (!VALID_NAME.test(name)) {
      failed.push({ name, reason: 'имя не годится для переменной окружения Windows' });
      continue;
    }
    if (typeof value !== 'string' || value === '') {
      failed.push({ name, reason: 'пустое значение — записывать нечего' });
      continue;
    }
    wanted.push({ name, value });
  }
  if (wanted.length === 0) {
    return { ok: failed.length === 0, written: [], failed, acl: null, payloadDeleted: true, verified: true, error: '' };
  }

  let directory = '';
  try {
    directory = await mkdtemp(join(tmpdir(), 'dsh-assets-secrets-'));
  } catch (error) {
    return { ok: false, written: [], failed: wanted.map((entry) => ({ name: entry.name, reason: 'нет временного каталога' })), acl: null, payloadDeleted: false, verified: false, error: error?.message ?? String(error) };
  }
  const payloadPath = join(directory, 'payload.json');

  const core = await (async () => {
    try {
      // The ACL must be narrowed BEFORE the value lands on disk.
      const acl = await tightenAcl(directory, runner, account);
      if (acl.applied !== true) {
        return { ok: false, written: [], failed: wanted.map((entry) => ({ name: entry.name, reason: acl.reason })), acl, verified: false, error: `не удалось ограничить доступ к временному файлу: ${acl.reason}` };
      }

      await writeFile(payloadPath, `${JSON.stringify(wanted)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        await chmod(payloadPath, 0o600);
      } catch {
        /* Windows ignores POSIX modes; the ACL above is what matters */
      }

      const result = await runner(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SET_ENV_SCRIPT, '-PayloadPath', payloadPath],
        { timeout: SCRIPT_TIMEOUT_MS },
      );
      if (result.code !== 0) {
        // The script's own output is NOT echoed: a PowerShell error may quote the
        // payload row it failed on, and that row holds a value.
        return {
          ok: false,
          written: [],
          failed: wanted.map((entry) => ({ name: entry.name, reason: 'скрипт установки переменных завершился с ошибкой' })),
          acl,
          verified: false,
          error: `powershell завершился с кодом ${result.code}; вывод скрипта не показывается, чтобы значение секрета не попало в отчёт`,
        };
      }

      const written = wanted.map((entry) => ({ name: entry.name, length: entry.value.length }));
      let verified = true;
      if (options.verify !== false) {
        const names = await listUserEnvironmentNames({ runner });
        verified = wanted.every((entry) => names.has(entry.name));
      }
      return { ok: true, written, failed, acl, verified, error: '' };
    } catch (error) {
      return {
        ok: false,
        written: [],
        failed: wanted.map((entry) => ({ name: entry.name, reason: 'ошибка записи' })),
        acl: null,
        verified: false,
        error: error?.message ?? String(error),
      };
    }
  })();

  const cleanup = await removePayload(directory, payloadPath);
  return {
    ...core,
    payloadDeleted: cleanup.deleted,
    ok: core.ok === true && cleanup.deleted,
    error: cleanup.deleted ? core.error : `${core.error === '' ? '' : `${core.error}; `}временный файл с секретами не удалён: ${cleanup.reason}`,
  };
}
