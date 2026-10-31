/**
 * Skill tests: status classification, dedupe against the shared root, copy
 * idempotency and the update path (old copy moves to `.bak`, never silently
 * overwritten).
 *
 * Everything runs in temporary directories; the real `~/.dsh/skills` is untouched.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { classifySkill, copySkill, scanSkills } from '../lib/assets/skills.js';

/** Write one fake skill directory with a SKILL.md. */
async function writeSkill(root, name, description = 'test skill') {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8');
  return dir;
}

/** A temporary workspace with foreign roots and a DSH skill root. */
async function workspace() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-assets-skills-'));
  const claude = join(base, 'claude', 'skills');
  const zcode = join(base, 'zcode', 'skills');
  const shared = join(base, 'agents', 'skills');
  const target = join(base, 'dsh', 'skills');
  await mkdir(claude, { recursive: true });
  await mkdir(zcode, { recursive: true });
  await mkdir(shared, { recursive: true });
  return {
    base,
    claude,
    zcode,
    shared,
    target,
    roots: [
      { id: 'claude-code', label: 'Claude Code', dir: () => claude, kind: 'agent' },
      { id: 'zcode', label: 'ZCode', dir: () => zcode, kind: 'agent' },
      { id: 'shared', label: 'Общие ~/.agents', dir: () => shared, kind: 'agent' },
    ],
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

test('a fresh skill is «новый» and a second identical scan makes it «обновит» only after the source got newer', async () => {
  const space = await workspace();
  try {
    await writeSkill(space.claude, 'alpha');
    const first = await scanSkills({ skillsRoot: space.target, agentsRoot: space.shared, roots: space.roots });
    const alpha = first.items.find((item) => item.name === 'alpha');
    assert.equal(alpha.status, 'new');
    assert.equal(alpha.selectable, true);

    const copied = await copySkill(alpha, { skillsRoot: space.target });
    assert.equal(copied.action, 'copied');
    assert.equal(existsSync(join(space.target, 'alpha', 'SKILL.md')), true);

    const second = await scanSkills({ skillsRoot: space.target, agentsRoot: space.shared, roots: space.roots });
    const again = second.items.find((item) => item.name === 'alpha');
    assert.equal(again.status, 'exists');
    assert.equal(again.selectable, false, 'an already-present skill is not selectable');

    const skip = await copySkill(again, { skillsRoot: space.target });
    assert.equal(skip.action, 'skipped');
    assert.match(skip.reason, /уже есть/u);

    // Make the source clearly newer: the row becomes an update, and the copy keeps
    // the old directory as a backup instead of destroying it.
    const future = new Date(Date.now() + 60_000);
    await utimes(join(space.claude, 'alpha'), future, future);
    const third = await scanSkills({ skillsRoot: space.target, agentsRoot: space.shared, roots: space.roots });
    const update = third.items.find((item) => item.name === 'alpha');
    assert.equal(update.status, 'update');
    assert.equal(update.selectable, true);

    const updated = await copySkill(update, { skillsRoot: space.target });
    assert.equal(updated.action, 'updated');
    assert.notEqual(updated.backupPath, '');
    assert.equal(existsSync(updated.backupPath), true, 'the previous copy must survive under .bak');
  } finally {
    await space.cleanup();
  }
});

test('a skill DSH already reads from ~/.agents/skills is «уже читается», not a copy candidate', async () => {
  const space = await workspace();
  try {
    await writeSkill(space.shared, 'shared-skill');
    await writeSkill(space.claude, 'shared-skill');
    await writeSkill(space.zcode, 'shared-skill');
    const scanned = await scanSkills({ skillsRoot: space.target, agentsRoot: space.shared, roots: space.roots });
    const rows = scanned.items.filter((item) => item.name === 'shared-skill');
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.status, 'available', `${row.source} must report the shared root as already read`);
      assert.equal(row.selectable, false);
    }
  } finally {
    await space.cleanup();
  }
});

test('the same new name in two sources is offered once, the other row is a duplicate', async () => {
  const space = await workspace();
  try {
    await writeSkill(space.claude, 'twin');
    await writeSkill(space.zcode, 'twin');
    const scanned = await scanSkills({ skillsRoot: space.target, agentsRoot: space.shared, roots: space.roots });
    const rows = scanned.items.filter((item) => item.name === 'twin');
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.status === 'new').length, 1);
    const duplicate = rows.find((row) => row.status === 'duplicate');
    assert.equal(duplicate.selectable, false);
    assert.match(duplicate.note, /то же имя/u);
  } finally {
    await space.cleanup();
  }
});

test('a directory without SKILL.md is not a skill and is never copied', async () => {
  const space = await workspace();
  try {
    await mkdir(join(space.claude, 'not-a-skill'), { recursive: true });
    await writeFile(join(space.claude, 'not-a-skill', 'README.md'), 'nope', 'utf8');
    const scanned = await scanSkills({ skillsRoot: space.target, agentsRoot: space.shared, roots: space.roots });
    const row = scanned.items.find((item) => item.name === 'not-a-skill');
    assert.equal(row.status, 'invalid');
    assert.equal(row.selectable, false);
    const report = await copySkill(row, { skillsRoot: space.target });
    assert.equal(report.action, 'skipped');
    assert.match(report.reason, /SKILL\.md/u);
    assert.equal(existsSync(join(space.target, 'not-a-skill')), false);
  } finally {
    await space.cleanup();
  }
});

test('copying twice never duplicates and never overwrites without a backup', async () => {
  const space = await workspace();
  try {
    const dir = await writeSkill(space.claude, 'beta');
    const scanned = await scanSkills({ skillsRoot: space.target, agentsRoot: space.shared, roots: space.roots });
    const row = scanned.items.find((item) => item.name === 'beta');
    const first = await copySkill(row, { skillsRoot: space.target });
    assert.equal(first.action, 'copied');
    const targetInfo = await stat(join(space.target, 'beta'));

    const second = await copySkill(row, { skillsRoot: space.target });
    assert.equal(second.action, 'skipped');
    const after = await stat(join(space.target, 'beta'));
    assert.equal(after.mtimeMs, targetInfo.mtimeMs, 'the destination must not be rewritten');
    assert.equal(existsSync(dir), true, 'the source is only read');
    const text = await readFile(join(space.target, 'beta', 'SKILL.md'), 'utf8');
    assert.match(text, /name: beta/u);
  } finally {
    await space.cleanup();
  }
});

test('classifySkill refuses a path-unsafe name', async () => {
  const classified = classifySkill({ name: '../escape', hasManifest: true, updatedAt: Date.now() }, { targetInfo: new Map(), sharedNames: new Set(), claimedBy: new Map() });
  assert.equal(classified.status, 'new', 'the classifier itself does not sanitize; the copy does');

  const space = await workspace();
  try {
    const report = await copySkill({ id: 'x', name: '../escape', realPath: space.claude }, { skillsRoot: space.target });
    assert.equal(report.action, 'failed');
    assert.match(report.reason, /недопустимое имя/u);
  } finally {
    await space.cleanup();
  }
});
