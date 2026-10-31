/**
 * Progress of one import run, kept in the Host for the browser panel to poll.
 *
 * A run is deliberately plain JSON: the panel renders it, the model-facing tool
 * may embed it, and nothing here touches the session store. The map only lives
 * for the Host process — a restart mid-import loses the report, which is honest:
 * the import itself either settled in the session store or it did not.
 *
 * Stage weights make the bar move while one long session is being written:
 * reading the source, building events, creating the session, writing events
 * (weighted by the number of events already appended), verification, done.
 */

/** Runs kept in memory; older ones are dropped so a long day cannot grow forever. */
const MAX_RUNS = 25;

/** Weight of each stage of one session inside its own progress slice. */
export const STAGE_WEIGHTS = {
  queued: 0,
  reading: 0.08,
  building: 0.18,
  creating: 0.3,
  writing: 0.62,
  verifying: 0.88,
  deleting: 0.35,
  reimporting: 0.4,
  done: 1,
  already: 1,
  skipped: 1,
  failed: 1,
};

/** Insertion-ordered runs; the Map keeps the newest snapshot addressable by id. */
const runs = new Map();

/** Monotonic counter so two runs started in one millisecond differ. */
let counter = 0;

/** Stage names the panel shows as a human sentence. */
export const STAGE_LABELS = {
  queued: 'в очереди',
  reading: 'чтение источника',
  building: 'сборка событий',
  creating: 'создание сессии',
  writing: 'запись событий',
  verifying: 'верификация',
  deleting: 'удаление старой копии',
  reimporting: 'переимпорт',
  done: 'готово',
  already: 'уже импортирована',
  skipped: 'пропущено',
  failed: 'ошибка',
};

/** Round a ratio into a whole percent of one item's own slice. */
function itemProgress(item) {
  const base = STAGE_WEIGHTS[item.stage] ?? 0;
  if (item.stage !== 'writing' || item.writeTotal <= 0) return base;
  const written = Math.max(0, Math.min(item.writeTotal, item.writeDone));
  // The writing stage spans creating..verifying, so interpolate inside it.
  return STAGE_WEIGHTS.creating + (STAGE_WEIGHTS.verifying - STAGE_WEIGHTS.creating) * (written / item.writeTotal);
}

/** Total percent of a run, always less than 100 until it finishes. */
function recompute(run) {
  let sum = 0;
  for (const item of run.items) {
    if (item.status === 'done' || item.status === 'failed' || item.status === 'skipped') sum += 1;
    else sum += itemProgress(item);
  }
  run.done = run.items.filter((item) => item.status === 'done' || item.status === 'failed' || item.status === 'skipped').length;
  run.percent = run.status === 'running' ? Math.min(99, Math.round((run.total === 0 ? 0 : sum / run.total) * 100)) : 100;
  run.updatedAt = Date.now();
  return run;
}

/** Keep the newest runs only, in insertion order (two runs may share a millisecond). */
function prune() {
  const entries = [...runs.values()];
  while (entries.length > MAX_RUNS) {
    const oldest = entries.shift();
    runs.delete(oldest.id);
  }
}

/**
 * Start a run.
 * @param kind - `import` or `reimport`.
 * @param items - `[{source, id, path?, title?}]` in the order the panel shows them.
 * @returns the mutable run object.
 */
export function createRun({ kind, items }) {
  const id = `run-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;
  const run = {
    id,
    kind: kind === 'reimport' ? 'reimport' : 'import',
    status: 'running',
    stage: 'queued',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: 0,
    total: items.length,
    done: 0,
    percent: 0,
    items: items.map((item, index) => ({
      index,
      source: String(item?.source ?? ''),
      id: String(item?.id ?? ''),
      path: String(item?.path ?? ''),
      title: String(item?.title ?? ''),
      status: 'pending',
      stage: 'queued',
      writeDone: 0,
      writeTotal: 0,
      messages: 0,
      turns: 0,
      warnings: [],
      error: '',
    })),
    summary: { imported: 0, reimported: 0, already: 0, skipped: 0, failed: 0 },
    projects: [],
    hint: { needed: false, text: '', refreshAttempted: false },
  };
  runs.set(id, run);
  prune();
  return run;
}

/** Update one item of a run; unknown fields are merged, the bar is recomputed. */
export function updateRunItem(run, index, patch = {}) {
  const item = run.items[index];
  if (item === undefined) return run;
  if (patch.stage !== undefined) item.progress = undefined;
  Object.assign(item, patch);
  if (patch.stage !== undefined) run.stage = patch.stage;
  recompute(run);
  return run;
}

/** Record part of the event append, so the «N из M» line moves. */
export function updateWriteProgress(run, index, written, total) {
  const item = run.items[index];
  if (item === undefined) return run;
  item.writeDone = Number(written) || 0;
  item.writeTotal = Number(total) || 0;
  item.stage = 'writing';
  run.stage = 'writing';
  recompute(run);
  return run;
}

/** Mark the whole run done or failed and attach the closing summary. */
export function finishRun(run, { summary, projects, hint, status } = {}) {
  if (summary !== undefined) run.summary = { ...run.summary, ...summary };
  if (Array.isArray(projects)) run.projects = projects;
  if (hint !== undefined) run.hint = { ...run.hint, ...hint };
  run.status = status === 'failed' ? 'failed' : 'done';
  run.stage = run.status === 'done' ? 'done' : 'failed';
  run.finishedAt = Date.now();
  recompute(run);
  return run;
}

/** One run by id, or `undefined`. */
export function getRun(id) {
  return runs.get(String(id ?? ''));
}

/** The most recently started run, or `undefined` (insertion order breaks ties). */
export function latestRun() {
  let newest;
  for (const run of runs.values()) if (newest === undefined || run.startedAt >= newest.startedAt) newest = run;
  return newest;
}

/** A plain-JSON copy safe to serialise into a route answer. */
export function snapshot(run) {
  if (run === undefined || run === null) return null;
  return JSON.parse(
    JSON.stringify({
      id: run.id,
      kind: run.kind,
      status: run.status,
      stage: run.stage,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
      total: run.total,
      done: run.done,
      percent: run.percent,
      items: run.items,
      summary: run.summary,
      projects: run.projects,
      hint: run.hint,
    }),
  );
}

/** Forget every run; a test helper. */
export function resetRuns() {
  runs.clear();
  counter = 0;
}
