/**
 * Daily spend ledger behind the `cost-day` cell of `@local/composer-cost`.
 *
 * The session cell needs nothing from the Host, but "today, by model" spans every
 * Session, so this half
 *
 *  - taps the `llm/stream` waterfall and folds each provider-reported usage sample
 *    into a per-day, per-route token ledger;
 *  - keeps that ledger in one JSON file under the profile's home, so a restart
 *    does not lose the morning;
 *  - serves it from a loopback HTTP route, guarded by a token this process
 *    injects into the page it serves.
 *
 * It prices nothing: the Client owns the tariff table, so each route's tokens
 * travel raw and one table stays authoritative.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/** Ledger schema generation; bump when the stored shape changes. */
const STORE_VERSION = 1;

/** Coalesce bursts of model calls into one write. */
const SAVE_DEBOUNCE_MS = 1500;

/** Days retained in the ledger before pruning. */
const KEEP_DAYS = 60;

/** Route path the page reads; kept beside the route registration below. */
const ROUTE_PATH = "/composer-cost/today";

/** Injected page global carrying the per-process read token. */
const TOKEN_GLOBAL = "__DSH_COST_TOKEN__";

/** The web carrier is the one Host service this half cannot work without. */
export const inject = ["webServer"];

/**
 * Local calendar day of one instant, as `YYYY-MM-DD`.
 * @param date - instant to describe; defaults to now.
 * @returns the machine's local day, so "today" matches the user's clock.
 */
function localDay(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** One route's four additive token buckets. */
function zeroBuckets() {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/**
 * Fold one provider usage sample into a bucket, mirroring the `tokenUsage`
 * projection: `inputTokens` is the uncached share, cache traffic is separate.
 * @param bucket - the route's running totals.
 * @param usage - the `TokenUsage` a stream chunk carried.
 */
function addUsage(bucket, usage) {
  bucket.uncached += Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  bucket.cacheRead += Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0;
  bucket.cacheWrite += Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0;
  bucket.output += Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
}

/** Drop day keys older than {@link KEEP_DAYS}; the ledger otherwise grows forever. */
function prune(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const floor = localDay(cutoff);
  for (const day of Object.keys(days)) {
    if (day < floor) delete days[day];
  }
}

/** @returns the ledger read from disk, or an empty one when nothing is readable. */
function loadLedger(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && parsed.days !== null && typeof parsed.days === "object") {
      const days = parsed.days;
      prune(days);
      return days;
    }
  } catch {
    // A missing or malformed ledger starts empty; the next save replaces it.
  }
  return {};
}

export function apply(ctx) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  const file = path.join(home, "storages", "composer-cost", "daily.json");
  const token = crypto.randomUUID();

  const days = loadLedger(file);
  let saveTimer = null;

  const flush = async () => {
    try {
      prune(days);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      await fsp.writeFile(temporary, JSON.stringify({ version: STORE_VERSION, days }), "utf8");
      await fsp.rename(temporary, file);
    } catch (error) {
      console.warn("[composer-cost] ledger write failed:", error instanceof Error ? error.message : error);
    }
  };

  const scheduleSave = () => {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  };

  /**
   * Record one billed model call under today's date and its own route.
   * @param provider - provider route that answered the call.
   * @param model - exact model id of that route.
   * @param usage - provider-reported token usage.
   */
  const record = (provider, model, usage) => {
    if (typeof provider !== "string" || typeof model !== "string") return;
    const day = localDay();
    const routes = (days[day] ??= {});
    const key = `${provider}/${model}`;
    const bucket = (routes[key] ??= zeroBuckets());
    addUsage(bucket, usage);
    scheduleSave();
  };

  ctx.effect(
    () =>
      ctx.on("llm/stream", (options, next) => {
        const inner = next();
        // Observe without changing the call: every chunk passes through untouched.
        return (async function* observed() {
          for await (const chunk of inner) {
            if (chunk?.type === "usage" && chunk.usage !== undefined) {
              record(options?.provider, options?.model, chunk.usage);
            }
            yield chunk;
          }
        })();
      }),
    "composer-cost-day: usage tap",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: ROUTE_PATH,
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405);
            response.end();
            return;
          }
          const url = new URL(request.url ?? "/", "http://localhost");
          if (url.searchParams.get("token") !== token) {
            response.writeHead(403);
            response.end();
            return;
          }
          const day = localDay();
          response.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify({ version: STORE_VERSION, date: day, models: days[day] ?? {} }));
        },
      }),
    "composer-cost-day: today route",
  );

  ctx.effect(
    () =>
      ctx.webServer.tapIndex((html) => {
        const marker = "</head>";
        if (!html.includes(marker)) return html;
        const script = `<script>window.${TOKEN_GLOBAL}=${JSON.stringify(token)}</script>`;
        return html.replace(marker, `${script}${marker}`);
      }),
    "composer-cost-day: page token",
  );

  ctx.effect(
    () => () => {
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
        void flush();
      }
    },
    "composer-cost-day: last write",
  );
}
