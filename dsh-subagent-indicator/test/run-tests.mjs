/**
 * Guard tests for @local/dsh-subagent-indicator (client half).
 * Run: node test/run-tests.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDom, createMiniReact, loadClient, createClientContext, makeSessionsHooks } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientFile = path.resolve(here, "..", "client.js");

const results = [];
function test(name, body) {
  try {
    body();
    results.push({ name, ok: true });
    console.log("OK   " + name);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log("FAIL " + name + " -> " + (error && error.message ? error.message : String(error)));
  }
}

/**
 * Fresh bundle + injected stylesheet + recorded context.
 * @param settings - optional object written to localStorage before apply(),
 *   so the mode-dependent seat is decided the way the owner configured it.
 */
function boot(settings) {
  const dom = createDom();
  if (settings !== undefined) {
    dom.window.localStorage.setItem("dsh.subagentIndicator", JSON.stringify(settings));
  }
  const miniReact = createMiniReact();
  const { module } = loadClient({ file: clientFile, dom, miniReact });
  const { ctx, recorded } = createClientContext();
  module.apply(ctx);
  return { dom, miniReact, module, recorded, testHelpers: module.__test };
}

boot(); // warm-up so a broken bundle fails loudly before the first assertion

test("ModuleLoader shim produced the expected bundle id and API", () => {
  const dom = createDom();
  const miniReact = createMiniReact();
  const { module, registry } = loadClient({ file: clientFile, dom, miniReact });
  assert.ok(registry.has("@local/dsh-subagent-indicator"), "bundle id must be registered");
  assert.equal(typeof module.apply, "function");
  assert.deepEqual(Array.from(module.inject), ["slots", "locale"]);
});

test("apply() injects exactly one owned style tag into <head>", () => {
  const { dom, testHelpers } = boot();
  const tags = dom.head.children;
  assert.equal(tags.length, 1, "exactly one <style> tag");
  assert.equal(tags[0].tagName, "STYLE");
  assert.equal(tags[0].getAttribute("data-plugin-css"), testHelpers.STYLE_ID);
  assert.equal(tags[0].getAttribute("data-plugin"), "@local/dsh-subagent-indicator");
  assert.ok(tags[0].textContent.length > 200, "stylesheet is not empty");
});

test("apply() registers dictionaries for the en/ru/zh locales", () => {
  const { recorded } = boot();
  assert.equal(recorded.locales.length, 1);
  assert.equal(recorded.locales[0].namespace, "subagentIndicator");
  for (const locale of ["en", "ru", "zh"]) {
    assert.ok(recorded.locales[0].dictionaries[locale], "dictionary for " + locale);
  }
  assert.match(recorded.locales[0].dictionaries.en["pill.running.other"], /\{count\} субагентов работают/);
});

test("default glow mode claims the seat but renders no node", () => {
  const { recorded, testHelpers, miniReact, dom } = boot();
  // The seat must be claimed even in glow: it publishes <html data-dsw-subind>, which is the
  // only state signal that does not depend on the built-in package's hashed class names.
  assert.deepEqual(recorded.injectedSlots, ["conversation.session.header.actions"]);
  assert.equal(recorded.seats.length, 1, "one seat is registered");
  const rendered = miniReact.render(testHelpers.SubagentIndicator, {
    sessionId: "session-x",
    useSessions: () => ({}),
    useSessionStatus: (selector) => selector(new Map()),
  });
  assert.equal(rendered, null, "glow renders nothing into the header");
  assert.equal((dom.body?.children ?? []).length, 0, "no DOM node added to the page");
});

test("pill mode claims the session-header actions seat after the built-in chip (order 20 > 10)", () => {
  const { recorded } = boot({ mode: "pill" });
  assert.deepEqual(recorded.injectedSlots, ["conversation.session.header.actions"]);
  assert.equal(recorded.seats.length, 1);
  const seat = recorded.seats[0];
  assert.equal(seat.spec.name, "conversation.session.header.actions");
  assert.equal(seat.spec.id, "subagent-indicator");
  assert.ok(seat.spec.order > 10, "must follow the built-in catalogue chip at order 10");
  assert.equal(typeof seat.component, "function");
});

test("running state: chip selector matches the real built-in markup hooks", () => {
  const { testHelpers } = boot();
  const css = testHelpers.CSS;
  assert.ok(
    css.includes('button[aria-haspopup="tree"][class*="_trigger"]:has([class*="_activitySlot"])'),
    "chip selector must key off aria-haspopup=tree + the activity slot",
  );
  assert.ok(
    css.includes("--dsw-subind-color:var(--dsw-alias-state-success-primary)"),
    "the accent defaults to the published success (green) token",
  );
  assert.ok(css.includes("color:var(--dsw-subind-color)"), "the chip takes the accent variable");
  assert.equal(/state-business-/.test(css), false, "no alias this build does not publish");
});

test("pulse animation is declared and bound to the activity dot", () => {
  const { testHelpers } = boot();
  const css = testHelpers.CSS;
  assert.ok(css.includes("@keyframes dshSubIndPulse"), "keyframes exist");
  const ring = css.split("}").find((rule) => rule.includes('_activitySlot"]::after'));
  assert.ok(ring !== undefined, "ring pseudo-element rule exists");
  assert.match(ring, /animation:dshSubIndPulse var\(--dsw-subind-pulse-duration\)/);
  assert.match(ring, /animation:dshSubIndPulse/);
  const keyframes = css.split("@keyframes dshSubIndPulse")[1].split("@keyframes")[0];
  assert.match(keyframes, /transform:scale\(var\(--dsw-subind-pulse-scale\)\)/, "keyframes scale by the intensity variable");
  assert.match(keyframes, /opacity:var\(--dsw-subind-pulse-opacity\)/, "keyframes fade via the intensity variable");
  assert.match(keyframes, /100%\{transform:scale\(var\(--dsw-subind-pulse-scale\)\);opacity:0\}/, "ring collapses at the end");
  assert.match(css, /--dsw-subind-pulse-duration:2000ms/);
});

test("the running ring is keyed on our own attribute, not on a hashed class name", () => {
  const { testHelpers } = boot();
  const css = testHelpers.CSS;
  assert.match(
    css,
    /html\[data-dsw-subind="running"\] button\[aria-haspopup="tree"\]::after/,
    "the ring rides on the published state attribute",
  );
  assert.match(css, /@keyframes dshSubIndRing/, "the ring pulse has its own keyframes");
  assert.match(css, /animation:dshSubIndRing var\(--dsw-subind-pulse-duration\)/, "the ring honours the intensity knob");
  assert.match(css, /box-shadow:0 0 0 1\.5px var\(--dsw-subind-color\)/, "the ring is drawn with the accent variable");
  const media = css.indexOf("@media (prefers-reduced-motion: reduce)");
  const staticRing = css.indexOf('html[data-dsw-subind="running"] button[aria-haspopup="tree"]::after{animation:none;opacity:.9}');
  assert.ok(media > 0, "the reduced-motion block exists");
  assert.ok(staticRing > media, "reduced motion keeps a static ring instead of dropping the state");
});
test("prefers-reduced-motion drops every animation but keeps the colour", () => {
  const { testHelpers } = boot();
  const css = testHelpers.CSS;
  const index = css.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(index > 0, "reduced-motion block exists");
  const block = css.slice(index);
  assert.match(block, /::after\{animation:none;opacity:0\}/);
  assert.match(block, /\.dshSubInd_dot\{animation:none\}/);
  assert.equal(css.includes("@media (prefers-reduced-motion: reduce){color"), false, "colour is not reset");
});

test("no hard-coded colours: only --dsw-alias-* / --dsw-subind-* custom properties", () => {
  const { testHelpers } = boot();
  const css = testHelpers.CSS;
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g);
  assert.equal(literals, null, "found colour literals: " + JSON.stringify(literals));
  const variables = Array.from(css.matchAll(/var\((--[a-z0-9-]+)/g)).map((match) => match[1]);
  assert.ok(variables.length > 0);
  for (const name of variables) {
    assert.ok(
      name.startsWith("--dsw-alias-") || name.startsWith("--dsw-subind-") || name === "--dsw-radius-sm",
      "unexpected theme variable " + name,
    );
  }
  const aliasOnly = variables.filter((name) => !name.startsWith("--dsw-subind-"));
  assert.ok(aliasOnly.every((name) => name.startsWith("--dsw-")), "theme tokens only");
});

/** Every alias this DSH build publishes (Theme inspect provider); nothing else resolves. */
const PUBLISHED_ALIAS = [
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-brand-primary",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-idle-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-specific-sidebar-fill",
];

test("every theme alias the stylesheet uses is one this build publishes", () => {
  const { testHelpers } = boot();
  const { CSS, COLORS } = testHelpers;
  const used = Array.from(CSS.matchAll(/var\((--dsw-alias-[a-z0-9-]+)/g)).map((match) => match[1]);
  assert.ok(used.length > 0, "the stylesheet references theme aliases");
  for (const name of new Set(used)) {
    assert.ok(
      PUBLISHED_ALIAS.includes(name),
      "alias not published by this build (it would silently resolve to nothing): " + name,
    );
  }
  for (const [key, token] of Object.entries(COLORS)) {
    assert.ok(PUBLISHED_ALIAS.includes(token), "colour \"" + key + "\" must point at a published alias: " + token);
  }
});

test("the accent is green by default and follows the color setting in every mode", () => {
  const green = boot();
  assert.equal(
    green.dom.documentElement.style.getPropertyValue("--dsw-subind-color"),
    "var(--dsw-alias-state-success-primary)",
    "green success token by default",
  );

  const yellow = boot({ color: "yellow" });
  assert.equal(
    yellow.dom.documentElement.style.getPropertyValue("--dsw-subind-color"),
    "var(--dsw-alias-state-warn-primary)",
    "yellow switches to the warn token",
  );
  assert.equal(yellow.dom.documentElement.dataset.dswSubindColor, "yellow", "the choice is published on <html>");

  const blue = boot({ mode: "glow", color: "blue" });
  assert.equal(
    blue.dom.documentElement.style.getPropertyValue("--dsw-subind-color"),
    "var(--dsw-alias-brand-primary)",
    "glow mode still honours the choice (no seat needed)",
  );

  const nonsense = boot({ color: "purple" });
  assert.equal(nonsense.testHelpers.readSettings().color, "green", "an unknown colour falls back to green");
});

test("running render publishes state and counts on <html data-dsw-subind=...>", () => {
  const { dom, miniReact, module, testHelpers } = boot();
  const sessionId = "session-parent";
  const hooks = makeSessionsHooks({
    sessionId,
    catalog: [
      { id: "sub-a", label: "alpha", activity: "running" },
      { id: "sub-b", label: "beta", activity: "running" },
      { id: "sub-c", label: "gamma", activity: "inactive" },
    ],
  });
  const rendered = miniReact.render(testHelpers.SubagentIndicator, {
    sessionId,
    useSessions: hooks.useSessions,
    useSessionStatus: (selector) =>
      selector(
        new Map([
          ["sub-a", { running: true }],
          ["sub-b", { running: true }],
          ["sub-c", { running: false }],
        ]),
      ),
  });
  assert.equal(rendered, null, "default glow mode draws no extra element");
  assert.equal(dom.documentElement.dataset.dswSubind, "running");
  assert.equal(dom.documentElement.dataset.dswSubindCount, "2");
  assert.equal(dom.documentElement.dataset.dswSubindTotal, "3");
  assert.equal(dom.documentElement.style.getPropertyValue("--dsw-subind-pulse-duration"), "2000ms");
  assert.equal(dom.documentElement.style.getPropertyValue("--dsw-subind-pulse-scale"), "2.2");
});

test("idle render marks the state idle and reports zero running", () => {
  const { dom, miniReact, module, testHelpers } = boot();
  const sessionId = "session-parent";
  const hooks = makeSessionsHooks({
    sessionId,
    catalog: [
      { id: "sub-a", activity: "inactive" },
      { id: "sub-b", activity: "inactive" },
    ],
  });
  miniReact.render(testHelpers.SubagentIndicator, {
    sessionId,
    useSessions: hooks.useSessions,
    useSessionStatus: (selector) => selector(new Map()),
  });
  assert.equal(dom.documentElement.dataset.dswSubind, "idle");
  assert.equal(dom.documentElement.dataset.dswSubindCount, "0");
  assert.equal(dom.documentElement.dataset.dswSubindTotal, "2");
});

test("unmount removes the published state attributes", () => {
  const { dom, miniReact, testHelpers } = boot();
  const sessionId = "session-parent";
  const hooks = makeSessionsHooks({ sessionId, catalog: [{ id: "sub-a", activity: "running" }] });
  miniReact.render(testHelpers.SubagentIndicator, {
    sessionId,
    useSessions: hooks.useSessions,
    useSessionStatus: (selector) => selector(new Map([["sub-a", { running: true }]])),
  });
  assert.equal(dom.documentElement.dataset.dswSubind, "running");
  miniReact.unmount();
  assert.equal(dom.documentElement.dataset.dswSubind, undefined);
  assert.equal(dom.documentElement.dataset.dswSubindCount, undefined);
});

test("pill mode renders a counted accent pill with Russian wording", () => {
  const { dom, miniReact, testHelpers } = boot();
  dom.window.localStorage.setItem(testHelpers.SETTINGS_KEY, JSON.stringify({ mode: "pill", intensity: "strong" }));
  const sessionId = "session-parent";
  const hooks = makeSessionsHooks({
    sessionId,
    catalog: [
      { id: "sub-a", activity: "running" },
      { id: "sub-b", activity: "running" },
    ],
  });
  const rendered = miniReact.render(testHelpers.SubagentIndicator, {
    sessionId,
    useSessions: hooks.useSessions,
    useSessionStatus: (selector) => selector(new Map([["sub-a", { running: true }], ["sub-b", { running: true }]])),
  });
  assert.ok(rendered, "pill element rendered");
  assert.equal(rendered.type, "span");
  assert.equal(rendered.props.className, "dshSubInd_pill dshSubInd_running");
  assert.equal(rendered.props.title, "2 субагентов работают");
  const count = rendered.props.children[1];
  assert.equal(count.props.children, "2", "the count is visible");
  assert.equal(dom.documentElement.style.getPropertyValue("--dsw-subind-pulse-duration"), "1300ms", "intensity preset applied");
});

test("pill wording is singular for one running subagent and idle renders nothing", () => {
  const { dom, miniReact, testHelpers } = boot();
  dom.window.localStorage.setItem(testHelpers.SETTINGS_KEY, JSON.stringify({ mode: "both" }));
  const sessionId = "session-parent";
  const runningHooks = makeSessionsHooks({ sessionId, catalog: [{ id: "sub-a", activity: "running" }] });
  const pill = miniReact.render(testHelpers.SubagentIndicator, {
    sessionId,
    useSessions: runningHooks.useSessions,
    useSessionStatus: (selector) => selector(new Map([["sub-a", { running: true }]])),
  });
  assert.equal(pill.props.title, "1 субагент работает");

  const idleHooks = makeSessionsHooks({ sessionId, catalog: [{ id: "sub-a", activity: "inactive" }] });
  const idle = miniReact.render(testHelpers.SubagentIndicator, {
    sessionId,
    useSessions: idleHooks.useSessions,
    useSessionStatus: (selector) => selector(new Map()),
  });
  assert.equal(idle, null, "no pill while everything is idle");
});

test("catalogState tolerates missing projections and summarised running flags", () => {
  const { testHelpers } = boot();
  assert.deepEqual({ ...testHelpers.catalogState(undefined, undefined, undefined) }, { total: 0, running: 0, state: "idle" });
  assert.deepEqual({ ...testHelpers.catalogState([], null, null) }, { total: 0, running: 0, state: "idle" });
  const fromSummaries = testHelpers.catalogState(
    [{ id: "sub-a" }, { id: "sub-b" }],
    undefined,
    { "sub-a": { running: true }, "sub-b": { running: false } },
  );
  assert.deepEqual({ ...fromSummaries }, { total: 2, running: 1, state: "running" });
});

test("readSettings validates junk instead of throwing", () => {
  const { dom, testHelpers } = boot();
  dom.window.localStorage.setItem(testHelpers.SETTINGS_KEY, "{not json");
  assert.deepEqual({ ...testHelpers.readSettings() }, { mode: "glow", intensity: "normal", color: "green" });
  dom.window.localStorage.setItem(testHelpers.SETTINGS_KEY, JSON.stringify({ mode: "nonsense", intensity: "loud", color: 42 }));
  assert.deepEqual({ ...testHelpers.readSettings() }, { mode: "glow", intensity: "normal", color: "green" });
});

const failed = results.filter((result) => !result.ok);
console.log("");
console.log("passed " + (results.length - failed.length) + "/" + results.length);
process.exit(failed.length === 0 ? 0 : 1);
