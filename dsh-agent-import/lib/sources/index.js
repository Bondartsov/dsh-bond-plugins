/**
 * The source registry.
 *
 * Every adapter exposes the same four members: `id`, `label`, `status()`,
 * `listSessions(options)` and `readSession(ref)`. Adding an agent means adding
 * one module here and nothing else in the plugin.
 */
import { join } from 'node:path';

import { userHome } from '../paths.js';
import * as claudeCode from './claude-code.js';
import * as codex from './codex.js';
import { createSqliteFamilySource } from './sqlite-agent-family.js';
import * as zcodeV2 from './zcode-v2.js';

/** ZCode CLI store: the same session/message/part shape as the other two. */
const zcodeCli = createSqliteFamilySource({
  id: 'zcode-cli',
  label: 'ZCode',
  dbPath: () => join(userHome(), '.zcode', 'cli', 'db', 'db.sqlite'),
  unavailableHint: 'ZCode keeps its CLI database under ~/.zcode/cli/db/db.sqlite',
});

/** KiloCode store. `KILO_HOME` is honoured because the store also moves with XDG. */
const kilo = createSqliteFamilySource({
  id: 'kilo',
  label: 'KiloCode',
  dbPath: () => join(process.env.KILO_HOME ?? join(userHome(), '.local', 'share', 'kilo'), 'kilo.db'),
  unavailableHint: 'KiloCode keeps its database under ~/.local/share/kilo/kilo.db',
});

/** OpenCode store. */
const opencode = createSqliteFamilySource({
  id: 'opencode',
  label: 'OpenCode',
  dbPath: () => join(userHome(), '.local', 'share', 'opencode', 'opencode.db'),
  unavailableHint: 'OpenCode keeps its database under ~/.local/share/opencode/opencode.db',
});

/** Every adapter, in the order the panel shows them. */
export const SOURCES = [claudeCode, codex, zcodeCli, zcodeV2, kilo, opencode];

/** One adapter by id. */
export function sourceById(id) {
  return SOURCES.find((source) => source.id === id);
}
