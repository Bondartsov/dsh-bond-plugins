/**
 * Secret handling for the import.
 *
 * One invariant holds everywhere in this plugin: a foreign secret VALUE never
 * leaves its origin file. Names of environment variables travel, values do not —
 * the exported profile row references `process.env.<NAME>` instead. The same
 * classifier drives the redaction of instruction documents the owner may view or
 * copy, so a leaked token cannot reach the panel, the report, the ledger or a log.
 */

/**
 * Suffixes that make a key non-secret even when it contains a word like `AUTH`.
 * `AZURE_DEVOPS_AUTH_METHOD = "pat"` is a mode, not a credential.
 */
/**
 * Suffixes that make a key non-secret even when it contains a word like `AUTH` or
 * `TOKEN`. `AZURE_DEVOPS_AUTH_METHOD = "pat"` is a mode, not a credential;
 * `MAX_THINKING_TOKENS = "30000"` is a budget, not a token.
 */
const NON_SECRET_SUFFIX = /^.*(?:^|_)(?:URL|URI|ENDPOINT|HOST|PORT|PATH|DIR|DIRS|MODE|LEVEL|PROFILE|TIMEOUT|TIMEOUTMS|TIMEOUTSECONDS|TIMEOUT_MS|TIMEOUT_SECONDS|METHOD|TYPE|ENABLED|DISABLED|FLAG|PREFIX|SUFFIX|MODEL|FORMAT|SIZE|LENGTH|LIMIT|COUNT|BATCH|INTERVAL|REGION|ORG(?:ANIZATION)?|PROJECT|COLLECTION|NAMESPACE|VERSION|SCOPE|CHANNEL|LANG|LOCALE|TOKENS)$/iu;

/** Key fragments that mark a value as a credential. */
const SECRET_KEY = /(?:token|secret|passw|passwd|pwd|api[-_]?key|apikey|_pat$|^pat$|credential|bearer|private[-_]?key|client[-_]?secret|access[-_]?key|subscription[-_]?key|cookie|session[-_]?key|connection[-_]?string|dsn)/iu;

/** Values that carry a well-known credential prefix. */
const SECRET_VALUE_PREFIX = /^(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|Bearer\s+\S{8,}|Basic\s+\S{8,})/u;

/** A single unwrapped token: long, dense, no whitespace. */
const DENSE_TOKEN = /^[A-Za-z0-9+/=_.~:-]{16,}$/u;

/** Mask text for a redacted value. */
export const MASK = '<скрыто>';

/** Whether a setting key names a credential. */
export function isSecretKey(key) {
  const name = String(key ?? '').trim();
  if (name === '') return false;
  if (NON_SECRET_SUFFIX.test(name)) return false;
  return SECRET_KEY.test(name);
}

/**
 * Whether a literal value looks like a credential regardless of its key name.
 * Deliberately conservative: a wrong `true` only costs an environment reference,
 * a wrong `false` writes a token into the profile.
 */
export function looksSecretValue(value) {
  const text = String(value ?? '');
  if (text === '') return false;
  if (SECRET_VALUE_PREFIX.test(text)) return true;
  const trimmed = text.trim();
  if (trimmed.length < 16) return false;
  if (/\s/u.test(trimmed)) return false;
  // A URL is a setting, not a credential: `https://n8n.example/mcp-server/http`
  // has digits, slashes and no spaces, exactly like a base64 blob.
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) return false;
  // A Windows or POSIX path is a setting too.
  if (/^[A-Za-z]:[\\/]/u.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\\\')) return false;
  if (!DENSE_TOKEN.test(trimmed)) return false;
  const hasDigit = /[0-9]/u.test(trimmed);
  const hasLower = /[a-z]/u.test(trimmed);
  const hasUpper = /[A-Z]/u.test(trimmed);
  if (!hasDigit) return false;
  // `deepseek/deepseek-v4.1-flash-1017`, `baai/bge-m3`: a lowercase identifier
  // carrying separators is a model or package name, never a credential.
  if (!hasUpper && /[/.]/u.test(trimmed)) return false;
  // A path or an identifier keeps its shape after 16 characters; a base64 blob
  // mixes cases. Require two of the three classes plus a digit.
  return trimmed.length >= 24 || (hasLower && hasUpper);
}

/** An environment reference the foreign config already wrote as `${VAR}`. */
export function envReferenceOf(value) {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(String(value ?? '').trim());
  return match === null ? '' : match[1];
}

/** CLI flags whose following value is a credential, whatever its shape. */
const SECRET_FLAG = /^--?(?:password|passwd|pwd|token|api[-_]?key|apikey|secret|pat|auth|authorization|access[-_]?token|bearer|credentials?)$/iu;

/**
 * Whether a command-line flag names a credential.
 * A password like `example-pass-not-a-secret` has no token shape at all; only its flag says so.
 */
export function isSecretFlag(flag) {
  return SECRET_FLAG.test(String(flag ?? '').trim());
}

/**
 * Decide how one `env` entry becomes a profile row.
 *
 * @param key - environment variable name.
 * @param value - the foreign value; it is never returned for a secret key.
 * @returns `{ mode: 'reference', variable }` or `{ mode: 'literal', value }`.
 */
export function classifyEnvValue(key, value) {
  const name = String(key ?? "").trim();
  const text = String(value ?? '');
  const reference = envReferenceOf(text);
  if (reference !== '') return { mode: 'reference', variable: reference };
  if (isSecretKey(name) || looksSecretValue(text)) return { mode: 'reference', variable: name };
  return { mode: 'literal', value: text };
}

/** Mask the credential part of an HTTP header value. */
export function headerReferenceName(serverName, headerName) {
  const slug = `${String(serverName ?? 'mcp')}_${String(headerName ?? 'header')}`
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toUpperCase();
  return slug === '' ? 'MCP_AUTHORIZATION' : slug;
}

/**
 * Redact one `key: value` line of JSON, TOML or YAML when the key is a credential.
 * @param text - the whole document.
 * @returns the document with credential values replaced by {@link MASK}.
 */
export function redactText(text) {
  let result = String(text ?? '');
  // JSON and YAML/TOML both reduce to `key` followed by `:`/`=` and a value.
  result = result.replace(
    /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^,}\]\r\n#]+)/gu,
    (whole, _quote, key, separator, rawValue) => {
      if (!isSecretKey(key)) return whole;
      const unquoted = rawValue.trim().replace(/^["']|["']$/gu, '');
      if (unquoted === '' || unquoted === MASK) return whole;
      return `${key}${separator}"${MASK}"`;
    },
  );
  // A bare token on its own (a header value, a shell export, a plugin field).
  result = result.replace(/(Bearer\s+|Basic\s+)([A-Za-z0-9+/=_.~:-]{8,})/gu, (_whole, prefix) => `${prefix}${MASK}`);
  result = result.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gu, MASK);
  return result;
}

/**
 * Redact a parsed config tree: credential keys and credential-shaped strings.
 * @param value - any JSON value.
 * @returns a copy safe to put in a report.
 */
export function redactDeep(value) {
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry));
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && looksSecretValue(value)) return MASK;
    return value;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key) && entry !== null && entry !== undefined && String(entry) !== '') {
      result[key] = MASK;
      continue;
    }
    result[key] = redactDeep(entry);
  }
  return result;
}

/**
 * Every credential-looking literal in a document, for the leak guard test.
 * @param text - raw document text.
 * @returns distinct values that must never appear in plugin output.
 */
export function secretValuesIn(text) {
  const found = new Set();
  const source = String(text ?? '');
  for (const match of source.matchAll(/["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/gu)) {
    const [, key, value] = match;
    if (isSecretKey(key) && !value.startsWith('${')) found.add(value);
    else if (looksSecretValue(value)) found.add(value);
  }
  for (const match of source.matchAll(/(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gu)) {
    found.add(match[0]);
  }
  return [...found];
}
