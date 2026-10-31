/**
 * Guard tests for the Host run registry — the state the progress bar renders.
 *
 * The panel trusts three things from this module: the percent really grows while
 * a long session is being written, «i из N» counts finished items only, and a
 * settled run always reports 100 % with a summary. A regression here turns the
 * progress bar back into decoration, hence the guards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRun, finishRun, getRun, latestRun, resetRuns, snapshot, updateRunItem, updateWriteProgress } from '../lib/sessions/runs.js';

const ITEMS = [
  { source: 'codex', id: 'a', title: 'Первый' },
  { source: 'codex', id: 'b', title: 'Второй' },
];

test('a fresh run starts at zero and exposes the items in order', () => {
  resetRuns();
  const run = createRun({ kind: 'import', items: ITEMS });
  assert.equal(run.status, 'running');
  assert.equal(run.total, 2);
  assert.equal(run.done, 0);
  assert.equal(run.percent, 0);
  assert.equal(run.items[0].id, 'a');
  assert.equal(run.items[1].stage, 'queued');
  assert.equal(getRun(run.id), run);
  assert.equal(latestRun(), run);
});

test('the percent grows through the stages and never reaches 100 while running', () => {
  resetRuns();
  const run = createRun({ kind: 'import', items: ITEMS });
  const seen = [];
  for (const stage of ['reading', 'building', 'creating', 'writing', 'verifying']) {
    updateRunItem(run, 0, { status: 'running', stage });
    seen.push(run.percent);
  }
  updateRunItem(run, 0, { status: 'done', stage: 'done' });
  const firstDone = run.percent;
  updateRunItem(run, 1, { status: 'running', stage: 'reading' });
  const secondStarted = run.percent;
  for (let index = 1; index < seen.length; index += 1) assert.ok(seen[index] >= seen[index - 1], 'the bar must not move backwards');
  assert.ok(seen.at(-1) > 0 && seen.at(-1) < 100, 'a running item never fills the whole bar');
  assert.ok(firstDone > seen.at(-1), 'a finished item counts fully');
  assert.ok(firstDone < 100, 'one of two items is still not the whole run');
  assert.ok(secondStarted >= firstDone, 'the second item starts from the first one\'s full share');
});

test('the writing stage interpolates by the number of events already appended', () => {
  resetRuns();
  const run = createRun({ kind: 'import', items: [ITEMS[0]] });
  updateRunItem(run, 0, { status: 'running', stage: 'creating' });
  const atCreating = run.percent;
  updateWriteProgress(run, 0, 0, 1000);
  const atStart = run.percent;
  updateWriteProgress(run, 0, 500, 1000);
  const atHalf = run.percent;
  updateWriteProgress(run, 0, 1000, 1000);
  const atEnd = run.percent;
  assert.ok(atStart >= atCreating, 'start of writing is not behind creating');
  assert.ok(atHalf > atStart, 'half the events must move the bar');
  assert.ok(atEnd > atHalf, 'all the events must move the bar further');
  assert.ok(atEnd < 100, 'writing is not done until verification finishes');
});

test('a settled run reports 100 %, the summary and the refresh hint', () => {
  resetRuns();
  const run = createRun({ kind: 'import', items: ITEMS });
  updateRunItem(run, 0, { status: 'done', stage: 'done', title: 'Первый', cwd: 'C:\\work\\demo', workspacePath: 'C:\\work\\demo', messages: 10, turns: 3 });
  updateRunItem(run, 1, { status: 'skipped', stage: 'already' });
  finishRun(run, {
    summary: { imported: 1, already: 1, skipped: 1, failed: 0 },
    projects: [{ path: 'C:\\work\\demo', title: 'demo', imported: 1 }],
    hint: { needed: true, text: 'перезагрузка плагинов' },
  });
  assert.equal(run.status, 'done');
  assert.equal(run.percent, 100);
  assert.equal(run.done, 2);
  assert.equal(run.summary.imported, 1);
  const plain = snapshot(run);
  assert.equal(plain.percent, 100);
  assert.equal(plain.projects[0].title, 'demo');
  assert.equal(plain.hint.text, 'перезагрузка плагинов');
  // The snapshot is a copy: mutating it must not touch the live run.
  plain.items[0].title = 'changed';
  assert.equal(run.items[0].title, 'Первый');
});

test('a failed run is settled too and carries the failed item', () => {
  resetRuns();
  const run = createRun({ kind: 'reimport', items: [ITEMS[0]] });
  updateRunItem(run, 0, { status: 'failed', stage: 'failed', error: 'диск недоступен' });
  finishRun(run, { status: 'failed', summary: { failed: 1 } });
  assert.equal(run.status, 'failed');
  assert.equal(run.percent, 100);
  assert.equal(snapshot(run).items[0].error, 'диск недоступен');
});

test('the run map is bounded and keeps the newest runs', () => {
  resetRuns();
  const runs = [];
  for (let index = 0; index < 30; index += 1) runs.push(createRun({ kind: 'import', items: [ITEMS[0]] }));
  assert.equal(getRun(runs[0].id), undefined, 'the oldest run is pruned');
  assert.notEqual(getRun(runs.at(-1).id), undefined, 'the newest run is kept');
  assert.equal(latestRun().id, runs.at(-1).id);
});
