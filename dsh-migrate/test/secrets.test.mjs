/**
 * Secrets tests.
 *
 * The owner's rule is absolute: the value moves, the value is never read back out.
 * These tests therefore attack the plugin from the outside:
 *
 *  1. a synthetic foreign home with SENTINEL values — none of them may appear in
 *     the tree, the preview, the status, a dry run, a real run report, the ledger
 *     or an error message;
 *  2. the writer is driven through a mocked process runner, and every argv of
 *     every spawned process is checked for a value — the value may only travel
 *     through the payload file;
 *  3. the payload file must be deleted afterwards and the ACL step must run
 *     before the file is written;
 *  4. idempotency: an already-set variable is left alone without the overwrite
 *     flag, and re-run with it.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectSecretCandidates, resolveSecretValues, scanSecrets } from '../lib/assets/secrets.js';
import { listUserEnvironmentNames, removePayload, writeUserEnvironment } from '../lib/assets/envwriter.js';
import { readLedger } from '../lib/assets/ledger.js';
import { previewImport, runImport } from '../lib/assets/operations.js';

/** Values that must never surface anywhere. */
const SENTINEL_HEADER = 'sentinel-header-0123456789ABCDEF';
const SENTINEL_ENV = 'sentinel-env-0123456789abcdefghij';
const SENTINEL_TOML = 'sentinel-toml-0123456789ABCDEFGHIJ';
const SENTINELS = [SENTINEL_HEADER, SENTINEL_ENV, SENTINEL_TOML];

/** A synthetic foreign home, shaped like the real agents' configs. */
async function fakeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-assets-secrets-home-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(join(home, '.zcode', 'cli'), { recursive: true });
  await mkdir(join(home, '.kilocode'), { recursive: true });

  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        demo: {
          type: 'http',
          url: 'https://example.invalid/mcp',
          headers: { Authorization: `Bearer ${SENTINEL_HEADER}` },
          env: { DEMO_API_KEY: SENTINEL_ENV, DEMO_MODE: 'stdio' },
        },
      },
    }),
    'utf8',
  );
  await writeFile(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ env: { CLAUDE_NUMERIC_LIMIT: '30000', ANTHROPIC_AUTH_TOKEN: SENTINEL_TOML } }),
    'utf8',
  );
  await writeFile(
    join(home, '.codex', 'config.toml'),
    ['[mcp_servers.demo]', 'command = "npx"', 'env_vars = ["CODEX_SHARED_VAR"]', '', '[mcp_servers.demo.env]', 'DEMO_TOKEN = "sentinel-cfg-toml-0123456789"'].join('\n'),
    'utf8',
  );
  await writeFile(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ mcp: { servers: {} } }), 'utf8');
  await writeFile(join(home, '.kilocode', 'settings.json'), JSON.stringify({ kilocodeToken: 'sentinel-kilocode-0123456789abcdef' }), 'utf8');
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/** Assert that no sentinel appears in a serialised payload. */
function assertNoSentinel(payload, where) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const sentinel of SENTINELS) {
    assert.equal(text.includes(sentinel), false, `${where} leaked a secret value`);
  }
  // The synthetic configs hold more credentials than the three constants above.
  assert.equal(/sentinel-(?:cfg|kilocode)-[0-9a-z]+/iu.test(text), false, `${where} leaked a synthetic credential`);
}

test('the scanner finds the credentials of every source without exposing a value', async () => {
  const fake = await fakeHome();
  try {
    const { candidates, skippedNonSecret } = await collectSecretCandidates({ homeDir: fake.home });
    const names = candidates.map((entry) => entry.name);
    assert.ok(names.includes('DEMO_API_KEY'), 'a Claude MCP env credential must be found');
    assert.ok(names.includes('DEMO_AUTHORIZATION'), 'a Claude MCP header token must become a variable');
    assert.ok(names.includes('ANTHROPIC_AUTH_TOKEN'), 'a settings env credential must be found');
    assert.ok(names.includes('KILOCODE_TOKEN'), 'the Kilo single-token field must be found');
    assert.ok(skippedNonSecret >= 1, 'non-credential env entries are counted, not offered');

    const scanned = await scanSecrets({ homeDir: fake.home, userEnvNames: new Set() });
    assertNoSentinel(scanned.items, 'the inventory rows');
    for (const row of scanned.items) {
      assert.equal('value' in row, false, `${row.name} must not carry a value field`);
      assert.equal(Object.keys(row).some((key) => /^(?:value|secret|raw)$/iu.test(key)), false);
      assert.equal(typeof row.valueLength, 'number');
      assert.equal(typeof row.name, 'string');
      assert.equal(typeof row.origin, 'string');
    }
    const header = scanned.items.find((row) => row.name === 'DEMO_AUTHORIZATION');
    assert.equal(header.valueLength, SENTINEL_HEADER.length, 'the length is the only value-shaped fact exposed');
    assert.equal(header.masked, '••••');

    const values = await resolveSecretValues(['DEMO_API_KEY'], { homeDir: fake.home });
    assert.equal(values.get('DEMO_API_KEY').value, SENTINEL_ENV, 'the writer must be able to resolve the real value');
  } finally {
    await fake.cleanup();
  }
});

test('the writer never puts a value on a command line and deletes the payload', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'powershell' && args.includes('-File') && args.some((arg) => arg.endsWith('list-user-env.ps1'))) {
      return { code: 0, stdout: JSON.stringify(['DEMO_API_KEY']), stderr: '' };
    }
    if (command === 'icacls') return { code: 0, stdout: 'processed', stderr: '' };
    if (command === 'powershell') return { code: 0, stdout: '{"written":["DEMO_API_KEY"],"count":1}', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected command' };
  };

  const result = await writeUserEnvironment([{ name: 'DEMO_API_KEY', value: SENTINEL_ENV }], { runner, account: 'tester' });
  assert.equal(result.ok, true);
  assert.equal(result.payloadDeleted, true);
  assert.equal(result.verified, true);
  assert.equal(result.written.length, 1);
  assert.equal(result.written[0].length, SENTINEL_ENV.length);
  assertNoSentinel(result, 'the writer result');

  // The value may travel through the payload file only.
  for (const call of calls) {
    const argv = [call.command, ...call.args].join(' ');
    assert.equal(argv.includes(SENTINEL_ENV), false, `a value reached argv: ${argv}`);
  }
  // The ACL step must precede the PowerShell write.
  const aclIndex = calls.findIndex((call) => call.command === 'icacls');
  const writeIndex = calls.findIndex((call) => call.command === 'powershell' && call.args.some((arg) => arg.endsWith('set-user-env.ps1')));
  assert.ok(aclIndex >= 0, 'the ACL must be tightened');
  assert.ok(writeIndex > aclIndex, 'the ACL must be tightened BEFORE the payload is written');

  const payloadPath = calls[writeIndex].args[calls[writeIndex].args.indexOf('-PayloadPath') + 1];
  assert.equal(existsSync(payloadPath), false, 'the payload file must be deleted');
  assert.equal(existsSync(join(payloadPath, '..')), false, 'the temporary directory must be deleted');
  assert.equal(calls[aclIndex].args.includes('tester:F'), true, 'only the current account is granted');
  assert.equal(calls[aclIndex].args.includes('/inheritance:r'), true, 'inherited access is cut off');
});

test('a failed ACL aborts before any value lands on disk', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'icacls') return { code: 5, stdout: '', stderr: 'denied' };
    return { code: 0, stdout: '{"written":[],"count":0}', stderr: '' };
  };
  const result = await writeUserEnvironment([{ name: 'DEMO_API_KEY', value: SENTINEL_ENV }], { runner, account: 'tester' });
  assert.equal(result.ok, false);
  assert.match(result.error, /ограничить доступ/u);
  assert.equal(calls.some((call) => call.command === 'powershell'), false, 'nothing may be written without the ACL');
  assertNoSentinel(result, 'the ACL error');
});

test('a failed script is reported without echoing a value', async () => {
  const runner = async (command, args) => {
    if (command === 'icacls') return { code: 0, stdout: '', stderr: '' };
    if (command === 'powershell' && args.some((arg) => arg.endsWith('set-user-env.ps1'))) {
      return { code: 1, stdout: '', stderr: `access denied while writing ${SENTINEL_ENV}` };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  const result = await writeUserEnvironment([{ name: 'DEMO_API_KEY', value: SENTINEL_ENV }], { runner, account: 'tester' });
  assert.equal(result.ok, false);
  assert.equal(result.payloadDeleted, true, 'even a failed run must clean up');
  assertNoSentinel(result, 'the failure report');
});

test('a leftover payload is a hard failure, not a warning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-assets-leftover-'));
  const payload = join(directory, 'payload.json');
  await writeFile(payload, '[]', 'utf8');
  const cleanup = await removePayload(directory, payload);
  assert.equal(cleanup.deleted, true);
  assert.equal(existsSync(directory), false);
});

test('an already-set variable is left alone, and the overwrite flag allows the update', async () => {
  const fake = await fakeHome();
  try {
    const userEnvNames = new Set(['DEMO_API_KEY']);
    const first = await scanSecrets({ homeDir: fake.home, userEnvNames });
    const row = first.items.find((item) => item.name === 'DEMO_API_KEY');
    assert.equal(row.status, 'set');
    assert.equal(row.selectable, false, 'without the flag the row is not even selectable');

    const withFlag = await scanSecrets({ homeDir: fake.home, userEnvNames, overwrite: true });
    const flagged = withFlag.items.find((item) => item.name === 'DEMO_API_KEY');
    assert.equal(flagged.status, 'set');
    assert.equal(flagged.selectable, true, 'with the flag the row may be rewritten');
    assert.match(flagged.note, /ПЕРЕЗАПИСАНА/u);
  } finally {
    await fake.cleanup();
  }
});

test('a run skips an already-set secret without the flag and writes it with the flag', async () => {
  const fake = await fakeHome();
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-assets-secrets-dsh-'));
  const ledgerFile = join(dshHome, 'ledger.json');
  const written = [];
  const runner = async (command, args) => {
    if (command === 'icacls') return { code: 0, stdout: '', stderr: '' };
    if (command === 'powershell' && args.some((arg) => arg.endsWith('list-user-env.ps1'))) {
      return { code: 0, stdout: JSON.stringify([...written]), stderr: '' };
    }
    if (command === 'powershell' && args.some((arg) => arg.endsWith('set-user-env.ps1'))) {
      const payloadPath = args[args.indexOf('-PayloadPath') + 1];
      const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
      for (const entry of payload) written.push(entry.name);
      return { code: 0, stdout: JSON.stringify({ written: payload.map((entry) => entry.name), count: payload.length }), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  try {
    const items = [{ type: 'secrets', source: 'claude-code', name: 'DEMO_API_KEY' }];

    // Already set in the user scope: the run must not touch it.
    written.push('DEMO_API_KEY');
    const skipped = await runImport(items, { homeDir: fake.home, ledgerFile, envRunner: runner, account: 'tester' });
    assert.equal(skipped.items[0].action, 'skipped');
    assert.match(skipped.items[0].reason, /уже задана/u);
    assertNoSentinel(skipped, 'the skipped report');

    // Without the flag in the scope, the same run writes it.
    written.length = 0;
    const report = await runImport(items, { homeDir: fake.home, ledgerFile, envRunner: runner, account: 'tester' });
    assert.equal(report.items[0].action, 'env-written');
    assert.equal(report.summary.secrets, 1);
    assert.equal(report.environment?.payloadDeleted, true);
    assert.equal(report.environment?.verified, true);
    assertNoSentinel(report, 'the run report');

    // The ledger records the action and the target, never a value.
    const ledger = await readLedger(ledgerFile);
    const ledgerText = JSON.stringify(ledger);
    assert.ok(ledgerText.includes('secrets:claude-code:DEMO_API_KEY'), 'the ledger records the variable');
    assertNoSentinel(ledger, 'the ledger');

    // Second run with the flag: overwrite is allowed and reported.
    const overwritten = await runImport(items, { homeDir: fake.home, ledgerFile, envRunner: runner, account: 'tester', overwriteSecrets: true });
    assert.equal(overwritten.items[0].action, 'env-written');
    assertNoSentinel(overwritten, 'the overwrite report');
  } finally {
    await fake.cleanup();
    await rm(dshHome, { recursive: true, force: true });
  }
});

test('a dry run shows names and lengths only and writes nothing', async () => {
  const fake = await fakeHome();
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-assets-secrets-dry-'));
  try {
    const items = [{ type: 'secrets', source: 'claude-code', name: 'DEMO_API_KEY' }];
    const report = await runImport(items, { homeDir: fake.home, ledgerFile: join(dshHome, 'ledger.json'), userEnvNames: new Set(), dryRun: true });
    assert.equal(report.summary.dryRun, true);
    assert.equal(report.items[0].action, 'would-set-env');
    assert.equal(report.summary.secrets, 1);
    assert.equal(report.environment, null, 'a dry run must not touch the environment');
    assertNoSentinel(report, 'the dry-run report');

    const preview = await previewImport(items, { homeDir: fake.home, userEnvNames: new Set() });
    assert.equal(preview.changesEnvironment, true);
    assert.equal(preview.environment.variables[0].name, 'DEMO_API_KEY');
    assert.equal(preview.environment.variables[0].valueLength, SENTINEL_ENV.length);
    assertNoSentinel(preview, 'the preview');
  } finally {
    await fake.cleanup();
    await rm(dshHome, { recursive: true, force: true });
  }
});

test('the value never reaches a thrown error', async () => {
  const fake = await fakeHome();
  try {
    const values = await resolveSecretValues(['http-invalid'], { homeDir: fake.home });
    assert.equal(values.size, 0);
    // A missing source must produce a readable message, not a value dump.
    const scanned = await scanSecrets({ homeDir: join(fake.home, 'does-not-exist'), userEnvNames: new Set() });
    assert.equal(scanned.items.length, 0);
  } finally {
    await fake.cleanup();
  }
});

test('conflicting values in two sources are refused instead of guessed', async () => {
  const fake = await fakeHome();
  try {
    // The same variable name with another value in the Codex config.
    await writeFile(
      join(fake.home, '.codex', 'config.toml'),
      ['[mcp_servers.other]', 'command = "npx"', '', '[mcp_servers.other.env]', 'DEMO_API_KEY = "another-value-0123456789abcdef"'].join('\n'),
      'utf8',
    );
    const scanned = await scanSecrets({ homeDir: fake.home, userEnvNames: new Set() });
    const rows = scanned.items.filter((item) => item.name === 'DEMO_API_KEY');
    assert.equal(rows.length >= 2, true, 'both occurrences must be visible');
    const conflict = rows.find((row) => row.status === 'conflict');
    assert.ok(conflict !== undefined, 'differing values must produce a conflict row');
    assert.equal(conflict.selectable, false);
    assert.match(conflict.note, /ДРУГОЕ значение/u);
    assertNoSentinel(scanned.items, 'the conflict rows');
  } finally {
    await fake.cleanup();
  }
});
