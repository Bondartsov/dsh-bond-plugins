/**
 * MCP tests: parsing, secret-safe normalization, the YAML fragment, and the
 * idempotency + backup contract of the only privileged write this plugin has.
 *
 * Every write test runs against a temporary profile patch; the real profile is
 * never touched.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyMcpRows,
  buildFragment,
  normalizeServer,
  parseCodexToml,
  parseConfiguredServers,
  rowBlocker,
  sanitizeArgs,
  slugOf,
  wrapLauncher,
} from '../lib/assets/mcp.js';

/** A profile patch shaped like the live one, including two MCP rows. */
const PROFILE = [
  '# patch layer',
  '- id: ui-settings',
  '  name: "@deepseek-ai/dsh-client-ui-settings"',
  '  config:',
  '    enabled: true',
  '- insert:',
  '    - id: mcp-github',
  '      name: "@deepseek-ai/dsh-mcp-client"',
  '      config:',
  '        serverName: github',
  '        transport: streamable-http',
  '        url: https://api.githubcopilot.com/mcp',
  '',
].join('\n');

/** A temporary profile directory. */
async function tempProfile() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-assets-mcp-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  await writeFile(patchPath, PROFILE, 'utf8');
  return { dir, patchPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A backup runner that always succeeds. */
const okBackup = async () => ({ ok: true, savedAs: 'cordis.patch.yml.29.10.2026-120000.good', output: 'saved: x' });

test('TOML reader understands multi-line arrays and sub-tables', async () => {
  const toml = [
    '[mcp_servers.demo]',
    'command = "npx"',
    'args = [',
    '    "-y",',
    '    "demo-server@1.0.0",',
    ']',
    'env_vars = ["SHARED_VAR"]',
    '',
    '[mcp_servers.demo.env]',
    'DEMO_API_KEY = "abc"',
    'DEMO_LOG_LEVEL = "info"',
    '',
    '[mcp_servers.remote]',
    'url = "https://example.invalid/mcp"',
    '',
    '[mcp_servers.remote.http_headers]',
    'Authorization = "Bearer abcdef1234567890"',
  ].join('\n');
  const parsed = await parseCodexToml(toml);
  const demo = parsed.find((entry) => entry.name === 'demo');
  assert.deepEqual(demo.args, ['-y', 'demo-server@1.0.0']);
  assert.equal(demo.env.DEMO_API_KEY, 'abc');
  assert.equal(demo.env.SHARED_VAR, '${SHARED_VAR}', 'env_vars names a variable without a value');
  const remote = parsed.find((entry) => entry.name === 'remote');
  assert.equal(remote.headers.Authorization, 'Bearer abcdef1234567890');
  assert.equal(parsed.length, 2, 'sub-tables must attach to their parent server');
});

test('secret arguments become environment references and are reported as needed variables', () => {
  const sanitized = sanitizeArgs('ctx', ['-y', 'pkg', '--api-key', 'ctx7sk-0123456789abcdef', '--verbose']);
  assert.deepEqual(sanitized.args, ['-y', 'pkg', '--api-key', { js: 'process.env.CTX_API_KEY' }, '--verbose']);
  assert.deepEqual(sanitized.needsEnv, ['CTX_API_KEY']);

  const inline = sanitizeArgs('ssh', ['--host=10.0.0.1', '--password=hunter2hunter2']);
  assert.deepEqual(inline.args, ['--host=10.0.0.1', '--password=', { js: 'process.env.SSH_PASSWORD' }], 'a password flag hides its value even without a token shape');

  const spaced = sanitizeArgs('ssh', ['--password', 'hunter2hunter2']);
  assert.deepEqual(spaced.args, ['--password', { js: 'process.env.SSH_PASSWORD' }]);
});

test('normalization keeps no credential value at all', () => {
  const server = normalizeServer(
    {
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'demo', '--token', 'tok_0123456789abcdef'],
      env: { DEMO_API_KEY: 'super-secret-key', DEMO_MODE: 'stdio' },
      headers: { Authorization: 'Bearer ghp_0123456789abcdefghijKL' },
    },
    { name: 'demo', source: 'codex', configPath: 'x' },
  );
  const serialized = JSON.stringify(server);
  assert.equal(serialized.includes('super-secret-key'), false);
  assert.equal(serialized.includes('tok_0123456789abcdef'), false);
  assert.equal(serialized.includes('ghp_0123456789abcdefghijKL'), false);
  assert.equal(server.transport, 'stdio');
  assert.ok(server.needsEnv.includes('DEMO_API_KEY'));
  assert.ok(server.needsEnv.includes('DEMO_TOKEN') || server.needsEnv.some((name) => name.includes('TOKEN')));
});

test('a server with credentials baked into its url is refused instead of half-copied', () => {
  const server = normalizeServer({ url: 'https://user:pass@example.invalid/mcp' }, { name: 'x', source: 'zcode', configPath: 'p' });
  assert.match(rowBlocker(server), /учётные данные/u);
  const query = normalizeServer({ url: 'https://example.invalid/mcp?token=abc' }, { name: 'y', source: 'zcode', configPath: 'p' });
  assert.match(rowBlocker(query), /учётные данные/u);
});

test('windows shims run through cmd, absolute executables do not', () => {
  assert.deepEqual(wrapLauncher('npx', ['-y', 'x']), { command: 'cmd', args: ['/c', 'npx', '-y', 'x'] });
  assert.deepEqual(wrapLauncher('C:\\bin\\node.exe', ['a']), { command: 'C:\\bin\\node.exe', args: ['a'] });
  assert.deepEqual(wrapLauncher('docker', ['mcp']), { command: 'docker', args: ['mcp'] });
});

test('fragment carries the insert shape the profile loader expects', () => {
  const server = normalizeServer({ command: 'npx', args: ['-y', 'demo'], env: { DEMO_API_KEY: 'k' } }, { name: 'demo', source: 'codex', configPath: 'p' });
  const { fragment, rows } = buildFragment([server], { usedIds: new Set(['mcp-demo']) });
  assert.equal(rows[0].id, 'mcp-demo-2', 'an id already present must not be reused');
  assert.match(fragment, /^- insert:$/mu);
  assert.match(fragment, /- id: mcp-demo-2/u);
  assert.match(fragment, /name: "@deepseek-ai\/dsh-mcp-client"/u);
  assert.match(fragment, /serverName: "demo"/u);
  assert.match(fragment, /transport: stdio/u);
  assert.match(fragment, /command: "cmd"/u);
  assert.match(fragment, /DEMO_API_KEY: !!js process\.env\.DEMO_API_KEY/u);
});

test('a dry run returns the fragment and writes nothing', async () => {
  const profile = await tempProfile();
  try {
    const server = normalizeServer({ command: 'npx', args: ['-y', 'demo'] }, { name: 'demo', source: 'codex', configPath: 'p' });
    const result = await applyMcpRows([server], { patchPath: profile.patchPath, dryRun: true, runBackup: okBackup });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.match(result.fragment, /serverName: "demo"/u);
    assert.equal(await readFile(profile.patchPath, 'utf8'), PROFILE, 'a dry run must not touch the patch');
    assert.equal(result.backupPath, '');
  } finally {
    await profile.cleanup();
  }
});

test('a failed backup aborts the write', async () => {
  const profile = await tempProfile();
  try {
    const server = normalizeServer({ command: 'npx', args: ['-y', 'demo'] }, { name: 'demo', source: 'codex', configPath: 'p' });
    const result = await applyMcpRows([server], {
      patchPath: profile.patchPath,
      runBackup: async () => ({ ok: false, savedAs: '', output: 'access denied' }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /резервная копия/u);
    assert.equal(await readFile(profile.patchPath, 'utf8'), PROFILE, 'no backup means no write');
  } finally {
    await profile.cleanup();
  }
});

test('the first real run appends exactly one row, and the second adds nothing', async () => {
  const profile = await tempProfile();
  try {
    const server = normalizeServer({ command: 'npx', args: ['-y', 'demo'] }, { name: 'demo', source: 'codex', configPath: 'p' });
    const first = await applyMcpRows([server], { patchPath: profile.patchPath, runBackup: okBackup });
    assert.equal(first.ok, true);
    assert.equal(first.verified, true);
    assert.equal(first.added.length, 1);
    assert.equal(first.backupPath, 'cordis.patch.yml.29.10.2026-120000.good');

    const written = await readFile(profile.patchPath, 'utf8');
    assert.equal((written.match(/serverName: "demo"/gu) ?? []).length, 1);
    assert.equal((written.match(/serverName: github/gu) ?? []).length, 1, 'the existing row must survive untouched');
    const configured = parseConfiguredServers(written);
    assert.ok(configured.names.has('demo'));
    assert.ok(configured.names.has('github'));

    const second = await applyMcpRows([server], { patchPath: profile.patchPath, runBackup: okBackup });
    assert.equal(second.ok, true);
    assert.equal(second.added.length, 0, 'a repeat run must not add a duplicate');
    assert.equal(second.skipped.length, 1);
    assert.match(second.skipped[0].reason, /уже настроен/u);
    assert.equal(await readFile(profile.patchPath, 'utf8'), written, 'the second run must leave the file byte-identical');
  } finally {
    await profile.cleanup();
  }
});

test('a missing patch file is an error, not an empty write', async () => {
  const profile = await tempProfile();
  try {
    const server = normalizeServer({ command: 'npx', args: ['-y', 'demo'] }, { name: 'demo', source: 'codex', configPath: 'p' });
    const result = await applyMcpRows([server], { patchPath: join(profile.dir, 'missing.yml'), runBackup: okBackup });
    assert.equal(result.ok, false);
    assert.match(result.error, /не найден/u);
  } finally {
    await profile.cleanup();
  }
});

test('slugOf is stable and idempotent', () => {
  assert.equal(slugOf('MCP_DOCKER'), 'mcp-mcp-docker');
  assert.equal(slugOf('ssh-mcp'), 'mcp-ssh-mcp');
  assert.equal(slugOf('web-search-prime'), 'mcp-web-search-prime');
});
