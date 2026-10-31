/**
 * Client half of "@local/dsh-subagent-indicator".
 *
 * The session header already carries the built-in descendant counter
 * ("@deepseek-ai/dsh-client-ui-subagent"): a button with aria-haspopup="tree",
 * a *_activitySlot dot that exists only while a child runs, the count text and
 * a chevron. That chip is rendered by a package we do not own and cannot hide,
 * so this bundle does not draw a second chip: it marks the existing one.
 *
 * Two independent halves:
 *   1. a stylesheet that recolours the chip with the theme business accent and
 *      adds a soft pulse ring around its activity dot while subagents run, and
 *      leaves it muted (native look) when they do not;
 *   2. a lightweight seat in "conversation.session.header.actions" that reads
 *      the subagent catalogue from the Sessions projections, publishes the
 *      running/total counts on <html data-dsw-subind=...> for CSS and
 *      tooling, and - in "pill" mode - renders a counted pill beside the chip.
 *
 * Colours come only from --dsw-alias-* theme tokens, so light and dark themes
 * both stay on-brand, and "prefers-reduced-motion: reduce" keeps the colour but
 * drops every animation.
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-subagent-indicator",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		/** Locale namespace this bundle owns. */
		const NS = "subagentIndicator";

		/** Russian wording - what this owner reads (see DICTIONARIES). */
		const RUSSIAN = {
			"pill.running.one": "{count} субагент работает",
			"pill.running.other": "{count} субагентов работают",
		};

		/** English wording, kept for a quick switch back. */
		const ENGLISH = {
			"pill.running.one": "{count} subagent running",
			"pill.running.other": "{count} subagents running",
		};

		/**
		 * One dictionary per locale id. The profile runs the UI as "en", so "en"
		 * carries the Russian wording the owner reads; point "en" at ENGLISH to
		 * restore the English labels.
		 */
		const DICTIONARIES = {
			en: RUSSIAN,
			ru: RUSSIAN,
			zh: ENGLISH,
		};

		/** Identifies this bundle style tag (data-plugin-css). */
		const STYLE_ID = "@local/dsh-subagent-indicator/subagent-indicator.css";

		/** Built-in session-header descendant-count chip (see ui-subagent). */
		const CHIP = 'button[aria-haspopup="tree"][class*="_trigger"]';

		/** The chip dot slot; the built-in renders it only while a child runs. */
		const ACTIVITY = '[class*="_activitySlot"]';

		/**
		 * Knobs. The --dsw-subind-* custom properties are ours; every colour below
		 * is a --dsw-alias-* theme token, never a literal. Only tokens this build
		 * actually publishes are used (see the Theme inspect provider): there is no
		 * `state-business-*` alias here, so the accent travels through our own
		 * --dsw-subind-color, which defaults to the success (green) token.
		 */
		const CSS = [
			":root{--dsw-subind-color:var(--dsw-alias-state-success-primary);--dsw-subind-pulse-duration:2000ms;--dsw-subind-pulse-scale:2.2;--dsw-subind-pulse-opacity:.55}",
			/* running: the chip itself takes the accent */
			CHIP + ":has(" + ACTIVITY + "){color:var(--dsw-subind-color);transition:color .18s ease}",
			CHIP + ":has(" + ACTIVITY + "):hover," + CHIP + ":has(" + ACTIVITY + "):focus-visible{color:var(--dsw-subind-color)}",
			/* running: a soft pulse ring behind the activity dot */
			'button[aria-haspopup="tree"] ' + ACTIVITY + "{position:relative;isolation:isolate;color:var(--dsw-subind-color)}",
			'button[aria-haspopup="tree"] ' + ACTIVITY + '::after{content:"";position:absolute;inset:0;border-radius:50%;background:color-mix(in srgb, var(--dsw-subind-color) 24%, transparent);box-shadow:0 0 0 1.5px var(--dsw-subind-color);opacity:0;animation:dshSubIndPulse var(--dsw-subind-pulse-duration) ease-out infinite;pointer-events:none;z-index:-1}',
			'button[aria-haspopup="tree"] ' + ACTIVITY + ">*{color:var(--dsw-subind-color);fill:currentColor}",
			"@keyframes dshSubIndPulse{0%{transform:scale(1);opacity:var(--dsw-subind-pulse-opacity)}70%{transform:scale(var(--dsw-subind-pulse-scale));opacity:0}100%{transform:scale(var(--dsw-subind-pulse-scale));opacity:0}}",
			/*
			 * The reliable half: keyed on OUR attribute, not on the built-in package's hashed class
			 * names, which change between DSH builds. A ring is drawn around the whole chip with a
			 * shadow pulse, so the state is visible even when the inner dot slot is absent.
			 */
			'html[data-dsw-subind="running"] button[aria-haspopup="tree"]{position:relative;color:var(--dsw-subind-color);transition:color .18s ease}',
			'html[data-dsw-subind="running"] button[aria-haspopup="tree"]::after{content:"";position:absolute;inset:-3px;border-radius:var(--dsw-radius-sm);box-shadow:0 0 0 1.5px var(--dsw-subind-color);opacity:.8;animation:dshSubIndRing var(--dsw-subind-pulse-duration) ease-out infinite;pointer-events:none}',
			"@keyframes dshSubIndRing{0%{opacity:.85}65%{opacity:0}100%{opacity:0}}",
			/* idle: no ring (the dot is absent) and the native muted colour kept */
			'html[data-dsw-subind="idle"] ' + CHIP + ":not(:hover):not(:focus-visible){color:var(--dsw-alias-label-secondary)}",
			/* optional counted pill (mode: pill | both) */
			".dshSubInd_pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:2px 9px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-subind-color);background:color-mix(in srgb, var(--dsw-subind-color) 14%, transparent);color:var(--dsw-subind-color);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:default}",
			".dshSubInd_dot{flex:none;width:8px;height:8px;border-radius:50%;background:currentColor;animation:dshSubIndBlink 1600ms ease-in-out infinite}",
			".dshSubInd_count{font-variant-numeric:tabular-nums}",
			"@keyframes dshSubIndBlink{0%,100%{opacity:1}50%{opacity:.35}}",
			/* reduced motion: colour says it, nothing moves */
			'@media (prefers-reduced-motion: reduce){button[aria-haspopup="tree"] ' + ACTIVITY + "::after{animation:none;opacity:0}html[data-dsw-subind=\"running\"] button[aria-haspopup=\"tree\"]::after{animation:none;opacity:.9}.dshSubInd_dot{animation:none}}",
		].join("");

		/**
		 * Accent palette. The key is the `color` setting; the value is the theme
		 * token this build publishes for that meaning.
		 */
		const COLORS = {
			green: "--dsw-alias-state-success-primary",
			yellow: "--dsw-alias-state-warn-primary",
			blue: "--dsw-alias-brand-primary",
		};

		/** Display modes: "glow" restyles the built-in chip, "pill" adds a count, "both" does both. */
		const MODES = ["glow", "pill", "both"];

		/** Pulse presets; "normal" ships by default. */
		const INTENSITIES = {
			subtle: { duration: "2800ms", scale: "1.8", opacity: "0.45" },
			normal: { duration: "2000ms", scale: "2.2", opacity: "0.55" },
			strong: { duration: "1300ms", scale: "2.9", opacity: "0.7" },
		};

		/** localStorage key holding {"mode":"glow","intensity":"normal"}. */
		const SETTINGS_KEY = "dsh.subagentIndicator";

		/** Default settings: restyle the built-in chip, normal pulse, green accent. */
		const DEFAULT_SETTINGS = { mode: "glow", intensity: "normal", color: "green" };

		/**
		 * Read the owner overrides from localStorage; never throws.
		 * @returns validated { mode, intensity, color } falling back to the defaults.
		 */
		function readSettings() {
			try {
				const storage = typeof window === "undefined" ? undefined : window.localStorage;
				const raw = storage === undefined || storage === null ? null : storage.getItem(SETTINGS_KEY);
				if (typeof raw !== "string" || raw.length === 0) return DEFAULT_SETTINGS;
				const parsed = JSON.parse(raw);
				const mode = MODES.indexOf(parsed?.mode) === -1 ? DEFAULT_SETTINGS.mode : parsed.mode;
				const intensity =
					Object.prototype.hasOwnProperty.call(INTENSITIES, parsed?.intensity) === true
						? parsed.intensity
						: DEFAULT_SETTINGS.intensity;
				const color =
					Object.prototype.hasOwnProperty.call(COLORS, parsed?.color) === true
						? parsed.color
						: DEFAULT_SETTINGS.color;
				return { mode, intensity, color };
			} catch {
				return DEFAULT_SETTINGS;
			}
		}

		/**
		 * Catalogue counters behind the indicator.
		 * @param entries - subagentCatalog entries of the current session.
		 * @param statuses - live UI status map (id -> { running }).
		 * @param summaries - Session summaries (id -> { running }).
		 * @returns { total, running, state }, where state is "running" or "idle".
		 */
		function catalogState(entries, statuses, summaries) {
			const list = Array.isArray(entries) ? entries : [];
			const running = list.filter((entry) => {
				if (entry === undefined || entry === null) return false;
				const status =
					statuses !== undefined && statuses !== null && typeof statuses.get === "function"
						? statuses.get(entry.id)
						: undefined;
				const summary = summaries !== undefined && summaries !== null ? summaries[entry.id] : undefined;
				if (status !== undefined && status !== null && status.running === true) return true;
				return summary !== undefined && summary !== null && summary.running === true;
			}).length;
			return { total: list.length, running, state: running > 0 ? "running" : "idle" };
		}

		/**
		 * Translate one key, falling back to the Russian dictionary when the host
		 * translation function is absent (tests, or a locale we do not ship).
		 * @param t - translate function supplied on locale registration.
		 * @returns (key, params) => string.
		 */
		function makeTranslator(t) {
			if (typeof t === "function") return (key, params) => t(key, params);
			return (key, params) => {
				const template = RUSSIAN[key] ?? key;
				if (params === undefined) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) =>
					params[name] === undefined ? match : String(params[name]),
				);
			};
		}

		/**
		 * Seat in "conversation.session.header.actions": publishes the state for the
		 * stylesheet and, in pill modes, renders the counted pill.
		 * @param props - Session standard props plus the locale translator.
		 * @returns The pill, or null in the default "glow" mode and while idle.
		 */
		function SubagentIndicator({ sessionId, useSessions, useSessionStatus, t }) {
			const settings = React.useRef(null);
			if (settings.current === null) settings.current = readSettings();
			const config = settings.current;
			const projections =
				typeof useSessions === "function" ? useSessions((state) => state.projectionsBySession) : undefined;
			const summaries = typeof useSessions === "function" ? useSessions((state) => state.byId) : undefined;
			const statuses = typeof useSessionStatus === "function" ? useSessionStatus((value) => value) : undefined;
			const entries = projections?.[sessionId]?.values?.subagentCatalog;
			const { total, running, state } = catalogState(entries, statuses, summaries);

			React.useEffect(() => {
				const root = document.documentElement;
				const preset = Object.prototype.hasOwnProperty.call(INTENSITIES, config.intensity)
					? INTENSITIES[config.intensity]
					: INTENSITIES.normal;
				root.dataset.dswSubind = state;
				root.dataset.dswSubindTotal = String(total);
				root.dataset.dswSubindCount = String(running);
				root.style.setProperty("--dsw-subind-pulse-duration", preset.duration);
				root.style.setProperty("--dsw-subind-pulse-scale", preset.scale);
				root.style.setProperty("--dsw-subind-pulse-opacity", preset.opacity);
				return () => {
					delete root.dataset.dswSubind;
					delete root.dataset.dswSubindTotal;
					delete root.dataset.dswSubindCount;
				};
			}, [state, total, running, config.intensity]);

			if (config.mode !== "pill" && config.mode !== "both") return null;
			if (running === 0) return null;
			const tr = makeTranslator(t);
			const label = tr(running === 1 ? "pill.running.one" : "pill.running.other", { count: running });
			return h(
				"span",
				{
					className: "dshSubInd_pill dshSubInd_" + state,
					"data-dsw-subind-pill": state,
					role: "status",
					title: label,
					"aria-label": label,
				},
				h("span", { className: "dshSubInd_dot", "aria-hidden": "true" }),
				h("span", { className: "dshSubInd_count" }, String(running)),
			);
		}

		/** Required client services: the seat registry and the locale store. */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: inject the stylesheet, publish the dictionaries and
		 * claim the header-actions seat.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]");
				if (existing !== null) return () => {};
				const tag = document.createElement("style");
				tag.dataset.plugin = "@local/dsh-subagent-indicator";
				tag.dataset.pluginCss = STYLE_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "subagent-indicator: styles");
			ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "subagent-indicator: dictionaries");
			// The accent travels through our own variable, so the "glow" mode - which claims no
			// seat and renders no node - still honours the chosen colour.
			ctx.effect(() => {
				const root = document.documentElement;
				const settings = readSettings();
				const token = COLORS[settings.color] ?? COLORS.green;
				root.style.setProperty("--dsw-subind-color", "var(" + token + ")");
				root.dataset.dswSubindColor = settings.color;
				return () => {
					root.style.removeProperty("--dsw-subind-color");
					delete root.dataset.dswSubindColor;
				};
			}, "subagent-indicator: accent");
			// The seat is claimed in EVERY mode: it renders nothing in "glow", but it is what
			// publishes `html[data-dsw-subind]` — and that attribute is the only reliable state
			// signal, because the built-in chip's hashed class names change between builds.
			ctx.slots.inject("conversation.session.header.actions", function* () {
				// The built-in catalogue chip claims order 10; this seat follows it.
				yield ctx.slots.register(
					{
						name: "conversation.session.header.actions",
						id: "subagent-indicator",
						order: 20,
						locale: NS,
					},
					SubagentIndicator,
				);
			});
		}

		return {
			inject,
			apply,
			/** Boundary exports for the local test harness; unused by the host. */
			__test: {
				CSS,
				STYLE_ID,
				CHIP,
				ACTIVITY,
				MODES,
				INTENSITIES,
				COLORS,
				SETTINGS_KEY,
				DEFAULT_SETTINGS,
				DICTIONARIES,
				catalogState,
				readSettings,
				SubagentIndicator,
			},
		};
	},
});
