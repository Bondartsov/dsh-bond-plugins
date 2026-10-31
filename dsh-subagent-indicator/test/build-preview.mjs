/**
 * Builds preview.html - a still picture of how the indicator looks in the
 * session header, using the bundle's own stylesheet and the built-in chip
 * markup plus the real theme tokens. Not part of the plugin runtime.
 * Run: node test/build-preview.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDom, createMiniReact, loadClient } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dom = createDom();
const miniReact = createMiniReact();
const { module } = loadClient({ file: path.join(root, "client.js"), dom, miniReact });
/** One rule per line: keeps every line short, so the page survives text-based copies. */
const oneRulePerLine = (css) => css.replace(/\}\s*/g, "}\n").trim();
const pluginCss = oneRulePerLine(module.__test.CSS);

const builtInCss = [
  ".rezYhW_root{align-items:center;gap:10px;min-width:0;display:inline-flex;position:relative}",
  ".rezYhW_trigger,.rezYhW_switcherTrigger{border-radius:var(--dsw-radius-sm);min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;align-items:center;padding:3px 2px;font-size:12px;line-height:18px;display:inline-flex}",
  ".rezYhW_trigger{gap:4px}",
  ".rezYhW_activitySlot{flex:none;justify-content:center;align-items:center;width:14px;height:14px;display:inline-flex}",
  ".rezYhW_trigger:hover,.rezYhW_trigger:focus-visible{color:var(--dsw-alias-label-primary)}",
].join("");

const builtIn = oneRulePerLine(builtInCss);

const themes = {
  light: "--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#5b5f66;--dsw-alias-label-tertiary:#81858c;--dsw-alias-state-business-primary:#4176e6;--dsw-alias-state-business-tertiary:#e4edfd;--dsw-alias-border-l2:#e6e8ea;--dsw-radius-sm:6px;--dsw-alias-state-idle-primary:#d4d4d4;",
  dark: "--dsw-alias-bg-base:#151517;--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#adb2b8;--dsw-alias-label-tertiary:#adb2b8;--dsw-alias-state-business-primary:#7aaaff;--dsw-alias-state-business-tertiary:#34415b;--dsw-alias-border-l2:#353638;--dsw-radius-sm:6px;--dsw-alias-state-idle-primary:#545557;",
};

/** One header actions band: built-in chip (idle or running), optionally preceded by the pill. */
function band({ running, pill, withPlugin }) {
  const dot = running ? '<span class="rezYhW_activitySlot"><span class="dot"></span></span>' : "";
  const count = running ? "9 · 9 subagents" : "9 subagents";
  const chip =
    '<div class="rezYhW_root"><button type="button" class="rezYhW_trigger" aria-haspopup="tree">' +
    dot +
    "<span>" + count + "</span>" +
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
    "</button></div>";
  const pillMarkup = pill && running
    ? '<span class="dshSubInd_pill dshSubInd_running"><span class="dshSubInd_dot" aria-hidden="true"></span><span class="dshSubInd_count">9</span></span>'
    : "";
  return '<div class="band' + (withPlugin ? " withPlugin" : "") + '"><span class="meta">Agent Team</span>' + pillMarkup + chip + "</div>";
}

const rows = [];
for (const theme of ["light", "dark"]) {
  rows.push('<section class="theme" style="' + themes[theme] + '">');
  rows.push('<h2>' + (theme === "light" ? "Светлая тема" : "Тёмная тема") + "</h2>");
  rows.push('<div class="row"><span class="label">Было · простаивают</span>' + band({ running: false, withPlugin: false }) + "</div>");
  rows.push('<div class="row"><span class="label">Было · работают</span>' + band({ running: true, withPlugin: false }) + "</div>");
  rows.push('<div class="row"><span class="label">Стало · работают (glow)</span>' + band({ running: true, withPlugin: true }) + "</div>");
  rows.push('<div class="row"><span class="label">Стало · работают (glow + pill)</span>' + band({ running: true, pill: true, withPlugin: true }) + "</div>");
  rows.push('<div class="row"><span class="label">Стало · простаивают</span>' + band({ running: false, withPlugin: true }) + "</div>");
  rows.push("</section>");
}

const html = [
  '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Индикатор работающих субагентов — превью</title>',
  "<style>",
  '*{box-sizing:border-box}body{margin:0;font:13px/20px "Segoe UI",system-ui,sans-serif;background:#f2f3f5;color:#0f1115;padding:24px}',
  "h1{font-size:16px;margin:0 0 4px}p.note{margin:0 0 20px;color:#5b5f66;font-size:12px}",
  ".theme{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:10px;padding:16px 20px 8px;margin:0 0 18px;box-shadow:0 1px 3px #0002}",
  ".theme h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);margin:0 0 10px}",
  ".row{display:flex;align-items:center;gap:16px;border-top:1px solid var(--dsw-alias-border-l2);padding:8px 0}",
  ".label{width:230px;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}",
  ".band{display:inline-flex;align-items:center;gap:10px;font-size:13px;color:var(--dsw-alias-label-secondary)}",
  ".meta{color:var(--dsw-alias-label-primary);font-weight:500}",
  ".dot{display:block;width:8px;height:8px;border-radius:50%;background:currentColor}",
  builtIn,
  pluginCss,
  "</style></head><body>",
  "<h1>Индикатор работающих субагентов в шапке беседы</h1>",
  '<p class="note">Разметка чипа и его родные стили взяты из @deepseek-ai/dsh-client-ui-subagent; стили плагина — из client.js этого пакета (сгенерировано build-preview.mjs).</p>',
  rows.join("\n"),
  "</body></html>",
].join("\n");

// The build box confines child processes to %TEMP%, so the page is written
// where the caller asks (default: %TEMP%) and then copied into place.
const outFile = process.argv[2] ?? path.join(process.env.TEMP ?? ".", "dsh-subagent-indicator-preview.html");
fs.writeFileSync(outFile, html, "utf8");
console.log("written " + outFile + " (" + html.length + " bytes)");
