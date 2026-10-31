/**
 * Instruction documents and foreign configs.
 *
 * These never reach the profile automatically: the plugin can show them (with
 * every credential masked) and, when the owner ticks an instruction, store a
 * masked review copy under `<DSH_HOME>/assets-import/instructions`. A config file
 * such as `settings.json` or `config.toml` is view-only — its settings belong to
 * the origin agent and half of them are secrets.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dshPath, instructionsDir, readTextOrUndefined, stampForFile, statOrUndefined, userHome } from './paths.js';
import { MASK, redactText } from './redact.js';

/** Bounded read; an instruction file is a document, not a log. */
const MAX_CONTENT_BYTES = 256 * 1024;

/** Documents and configs this plugin knows about. */
export const INSTRUCTION_FILES = [
  { id: 'claude-code:CLAUDE.md', source: 'claude-code', sourceLabel: 'Claude Code', path: () => join(userHome(), '.claude', 'CLAUDE.md'), kind: 'instructions', label: 'CLAUDE.md — глобальные инструкции Claude Code' },
  { id: 'claude-code:settings.json', source: 'claude-code', sourceLabel: 'Claude Code', path: () => join(userHome(), '.claude', 'settings.json'), kind: 'config', label: 'settings.json — настройки Claude Code' },
  { id: 'codex:AGENTS.md', source: 'codex', sourceLabel: 'Codex', path: () => join(userHome(), '.codex', 'AGENTS.md'), kind: 'instructions', label: 'AGENTS.md — глобальные инструкции Codex' },
  { id: 'codex:config.toml', source: 'codex', sourceLabel: 'Codex', path: () => join(userHome(), '.codex', 'config.toml'), kind: 'config', label: 'config.toml — настройки Codex' },
  { id: 'zcode:AGENTS.md', source: 'zcode', sourceLabel: 'ZCode', path: () => join(userHome(), '.zcode', 'AGENTS.md'), kind: 'instructions', label: 'AGENTS.md — глобальные инструкции ZCode' },
  { id: 'zcode:config.json', source: 'zcode', sourceLabel: 'ZCode', path: () => join(userHome(), '.zcode', 'cli', 'config.json'), kind: 'config', label: 'cli/config.json — настройки ZCode' },
  { id: 'shared:AGENTS.md', source: 'shared', sourceLabel: 'Общие ~/.agents', path: () => join(userHome(), '.agents', 'AGENTS.md'), kind: 'instructions', label: 'AGENTS.md — общие инструкции агентов' },
  { id: 'kilocode:settings.json', source: 'kilocode', sourceLabel: 'KiloCode', path: () => join(userHome(), '.kilocode', 'settings.json'), kind: 'config', label: 'settings.json — настройки KiloCode' },
  { id: 'opencode:AGENTS.md', source: 'opencode', sourceLabel: 'OpenCode', path: () => join(userHome(), '.config', 'opencode', 'AGENTS.md'), kind: 'instructions', label: 'AGENTS.md — глобальные инструкции OpenCode' },
  { id: 'opencode:opencode.json', source: 'opencode', sourceLabel: 'OpenCode', path: () => join(userHome(), '.config', 'opencode', 'opencode.json'), kind: 'config', label: 'opencode.json — настройки OpenCode' },
];

/** The DSH global instruction file, used only to explain the status. */
function dshGlobalInstructions() {
  return dshPath('AGENTS.md');
}

/** Scan the instruction documents that exist. */
export async function scanInstructions() {
  const items = [];
  const dshGlobal = await statOrUndefined(dshGlobalInstructions());
  for (const entry of INSTRUCTION_FILES) {
    const path = entry.path();
    const info = await statOrUndefined(path);
    if (info === undefined || !info.isFile()) continue;
    const instructions = entry.kind === 'instructions';
    const row = {
      type: 'instructions',
      id: entry.id,
      source: entry.source,
      sourceLabel: entry.sourceLabel,
      kind: entry.kind,
      name: entry.label,
      path,
      sizeBytes: info.size,
      updatedAt: info.mtimeMs ?? 0,
      target: instructions ? join(instructionsDir(), `${entry.id.replace(/[:\\/]/gu, '_')}`) : '',
      selectable: instructions,
      status: instructions ? (dshGlobal === undefined ? 'new' : 'exists') : 'view',
      note: instructions
        ? dshGlobal === undefined
          ? 'будет сохранена маскированная копия для просмотра; в профиль ничего не пишется'
          : 'в DSH уже есть глобальный ~/.dsh/AGENTS.md — копия кладётся только для просмотра, автоматически не применяется'
        : 'только просмотр: настройки чужого агента не переносятся, секреты маскируются',
      previewable: true,
    };
    items.push(row);
  }
  return { items, targetDir: instructionsDir(), dshGlobalPath: dshGlobalInstructions(), dshGlobalPresent: dshGlobal !== undefined };
}

/** Read at most the head of one instruction document, masked. */
export async function readInstruction(id) {
  const entry = INSTRUCTION_FILES.find((candidate) => candidate.id === id);
  if (entry === undefined) return { ok: false, error: `неизвестный документ: ${id}`, content: '', truncated: false };
  const text = await readTextOrUndefined(entry.path());
  if (text === undefined) return { ok: false, error: `документ не читается: ${entry.path()}`, content: '', truncated: false };
  const truncated = text.length > MAX_CONTENT_BYTES;
  const slice = truncated ? text.slice(0, MAX_CONTENT_BYTES) : text;
  const redacted = redactText(slice);
  return {
    ok: true,
    id,
    label: entry.label,
    source: entry.source,
    path: entry.path(),
    kind: entry.kind,
    content: redacted,
    truncated,
    masked: redacted !== slice,
    note: redacted !== slice ? `секреты заменены на ${MASK}` : 'секретов не найдено',
  };
}

/** Copy one instruction document into the review folder, masked. */
export async function copyInstruction(id) {
  const read = await readInstruction(id);
  if (read.ok !== true) return { id, action: 'failed', reason: read.error };
  const entry = INSTRUCTION_FILES.find((candidate) => candidate.id === id);
  if (entry.kind !== 'instructions') return { id, action: 'skipped', reason: 'конфиг чужого агента не копируется — только просмотр' };
  const directory = instructionsDir();
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${entry.id.replace(/[:\\/]/gu, '_')}`);
  const body = [`<!-- Копия из ${read.path}, сохранена ${stampForFile(Date.now())}. Секреты замаскированы. -->`, '', read.content].join('\n');
  await writeFile(target, body, 'utf8');
  return { id, action: 'copied', status: 'ok', target, reason: read.masked ? 'секреты заменены маской' : '' };
}
