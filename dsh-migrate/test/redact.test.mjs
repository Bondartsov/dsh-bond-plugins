/**
 * Guard tests for the secret policy.
 *
 * The invariant is absolute: a credential VALUE never leaves its origin file.
 * These tests check the classifier, the masking of instruction documents, and —
 * against the real foreign configs of this host — that the plugin's own output
 * (tree, MCP fragment, status) contains no credential it discovered.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildTree, previewImport, buildStatus } from '../lib/assets/operations.js';
import { classifyEnvValue, isSecretKey, isSecretFlag, looksSecretValue, MASK, redactDeep, redactText, secretValuesIn } from '../lib/assets/redact.js';
import { readInstruction } from '../lib/assets/instructions.js';

/** A canary that only a leak can reveal. */
const CANARY = 'sk-canary-0123456789abcdefghijklmnop';

test('credential keys are recognised, mode-like keys are not', () => {
  for (const key of ['N8N_API_KEY', 'SSH_MCP_PASSWORD', 'AZURE_DEVOPS_PAT', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'TM_TOKEN', 'CLIENT_SECRET']) {
    assert.equal(isSecretKey(key), true, `${key} must count as a credential`);
  }
  for (const key of ['AZURE_DEVOPS_AUTH_METHOD', 'N8N_API_URL', 'MEMORY_FILE_PATH', 'QDRANT_MODE', 'NODE_TLS_REJECT_UNAUTHORIZED', 'EMBEDDING_DIMENSIONS']) {
    assert.equal(isSecretKey(key), false, `${key} must stay a plain setting`);
  }
});

test('a credential-shaped value is detected without its key name', () => {
  assert.equal(looksSecretValue(CANARY), true);
  assert.equal(looksSecretValue('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghij'), true);
  assert.equal(looksSecretValue('ghp_0123456789abcdefghijABCDEFGHIJ012345'), true);
  assert.equal(looksSecretValue('chrome,iab,mcpapps'), false);
  assert.equal(looksSecretValue('C:\\Users\\someone\\.codex'), false);
  assert.equal(looksSecretValue('1024'), false);
});

test('CLI flags that carry a password are recognised even when the value has no token shape', () => {
  assert.equal(isSecretFlag('--password'), true);
  assert.equal(isSecretFlag('--api-key'), true);
  assert.equal(isSecretFlag('--host'), false);
});

test('env classification turns a credential into a variable reference, never a value', () => {
  const secret = classifyEnvValue('N8N_API_KEY', 'literal-secret-value');
  assert.deepEqual(secret, { mode: 'reference', variable: 'N8N_API_KEY' });

  const mode = classifyEnvValue('AZURE_DEVOPS_AUTH_METHOD', 'pat');
  assert.deepEqual(mode, { mode: 'literal', value: 'pat' });

  const already = classifyEnvValue('MY_TOKEN', '${TM_TOKEN}');
  assert.deepEqual(already, { mode: 'reference', variable: 'TM_TOKEN' });

  const path = classifyEnvValue('MEMORY_FILE_PATH', 'C:\\memory\\memory.jsonl');
  assert.equal(path.mode, 'literal');

  const hidden = classifyEnvValue('HARMLESS_NAME', CANARY);
  assert.deepEqual(hidden, { mode: 'reference', variable: 'HARMLESS_NAME' }, 'a token shape wins over a harmless key name');
});

test('redaction masks JSON, TOML and YAML values', () => {
  const json = redactText('{"N8N_API_KEY": "secret-1", "url": "https://x/y"}');
  assert.equal(json.includes('secret-1'), false);
  assert.equal(json.includes(MASK), true);

  const toml = redactText('AZURE_DEVOPS_PAT = "abcd1234efgh"\nAZURE_DEVOPS_ORG_URL = "https://tfs"');
  assert.equal(toml.includes('abcd1234efgh'), false);
  assert.equal(toml.includes('https://tfs'), true, 'a non-secret value must survive');

  const header = redactText('Authorization: Bearer abcdef1234567890abcdef');
  assert.equal(header.includes('abcdef1234567890abcdef'), false);

  const jwt = redactText('token = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdefghij');
  assert.equal(jwt.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), false);
});

test('deep redaction masks credential keys of a parsed config', () => {
  const redacted = redactDeep({ env: { SSH_MCP_PASSWORD: 'top-secret', PORT: '22' }, mcpServers: { x: { headers: { Authorization: CANARY } } } });
  assert.equal(JSON.stringify(redacted).includes('top-secret'), false);
  assert.equal(JSON.stringify(redacted).includes(CANARY), false);
  assert.equal(redacted.env.PORT, '22');
});

test('real foreign configs contribute secrets that the guard can then look for', async () => {
  const paths = [join(homedir(), '.codex', 'config.toml'), join(homedir(), '.claude.json'), join(homedir(), '.zcode', 'cli', 'config.json')];
  let total = 0;
  for (const path of paths) {
    const text = await readFile(path, 'utf8').catch(() => '');
    total += secretValuesIn(text).length;
  }
  // This host's configs really do carry tokens; an empty result would make the
  // leak test below meaningless, so assert the detector sees them.
  assert.ok(total > 0, 'the host configs are expected to hold at least one credential');
});

test('no credential value appears in the tree, the MCP fragment or the status', async () => {
  const paths = [
    join(homedir(), '.codex', 'config.toml'),
    join(homedir(), '.claude.json'),
    join(homedir(), '.zcode', 'cli', 'config.json'),
    join(homedir(), '.opencode', 'mcp_settings.json'),
  ];
  const secrets = new Set();
  for (const path of paths) {
    const text = await readFile(path, 'utf8').catch(() => '');
    for (const value of secretValuesIn(text)) {
      // URL- and path-shaped findings are not credentials and legitimately travel.
      if (/^(?:https?|file|ssh):/iu.test(value) || /^[A-Za-z]:[\\/]/u.test(value)) continue;
      secrets.add(value);
    }
  }
  assert.ok(secrets.size > 0, 'the guard needs at least one real credential to be meaningful');

  const tree = await buildTree();
  const mcpItems = tree.sources
    .flatMap((source) => source.types.filter((group) => group.type === 'mcp').flatMap((group) => group.items))
    .filter((item) => item.status === 'new')
    .map((item) => ({ type: 'mcp', source: item.source, name: item.name }));
  const preview = await previewImport(mcpItems);
  const status = await buildStatus();

  const haystacks = { tree: JSON.stringify(tree), preview: JSON.stringify(preview), status: JSON.stringify(status) };
  for (const [label, haystack] of Object.entries(haystacks)) {
    for (const secret of secrets) {
      assert.equal(haystack.includes(secret), false, `credential leaked into ${label}: ${secret.slice(0, 6)}…`);
    }
  }
});

test('instruction documents are served masked', async () => {
  const read = await readInstruction('claude-code:settings.json');
  if (read.ok !== true) {
    // The document may be absent on another host; the invariant then holds trivially.
    assert.equal(read.ok, false);
    return;
  }
  assert.equal(typeof read.content, 'string');
  for (const match of read.content.matchAll(/gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}/gu)) {
    assert.fail(`an unmasked credential reached the instruction view: ${match[0].slice(0, 6)}…`);
  }
  assert.equal(read.note.includes(MASK) || read.masked === false, true);
});
