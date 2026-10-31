window.__ModuleLoader__.load({
	id: "@local/composer-cost",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		/** `react-dom` supplies the portaled panel; a missing module falls back inline. */
		let createPortal = null;
		try {
			const reactDom = require("react-dom");
			createPortal = typeof reactDom.createPortal === "function" ? reactDom.createPortal : null;
		} catch {
			createPortal = null;
		}

		/** Locale namespace this bundle owns. */
		const NS = "composerCost";

		/**
		 * Provider tariffs in rubles per 1M tokens, as published by Polza.AI for the
		 * routes configured in this profile (`GET /models/{model}` →
		 * `top_provider.pricing`, read 28.10.2026). `cacheRead` is the cache-hit
		 * input rate; a cache write is charged at the ordinary input rate because
		 * the provider publishes no separate write price.
		 *
		 * Update these numbers (or add another `provider/model` key) when the
		 * provider changes its price list; a route absent here renders no cell.
		 */
		const TARIFFS = {
			"polza/deepseek/deepseek-v4.1-flash-1017": {
				input: 11.530968,
				output: 17.1252,
				cacheRead: 0.76892148,
			},
			"polza/minimax/minimax-m3.1-flash": {
				input: 16.26894,
				output: 65.07576,
				cacheRead: 1.626894,
			},
		};

		/**
		 * Route assumed when no assistant step names one (a session whose loaded
		 * window no longer holds a routable step): the profile's default model.
		 */
		const DEFAULT_ROUTE = "polza/deepseek/deepseek-v4.1-flash-1017";

		/** Pill geometry copied from the host statistics strip, plus the hover panel. */
		const CSS = [
			".dshCost_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);",
			"line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex;",
			"position:relative}",
			".dshCost_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;",
			"color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;",
			"line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;",
			"padding:1px 8px;display:inline-flex;cursor:default}",
			".dshCost_pill svg{flex:none;width:14px;height:14px}",
			".dshCost_label{text-overflow:ellipsis;min-width:0;overflow:hidden}",
			".dshCost_panel{box-sizing:border-box;border-radius:var(--dsw-radius-lg);",
			"background:var(--dsw-specific-menu);width:max-content;max-width:min(420px,100vw - 24px);",
			"backdrop-filter:var(--dsw-menu-backdrop-filter);",
			"--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);",
			"color:var(--dsw-alias-label-secondary);cursor:default;padding:16px;font-size:12px;",
			"line-height:18px;z-index:1100}",
			".dshCost_panelFloating{position:fixed}",
			".dshCost_panelInline{position:absolute;bottom:calc(100% + 8px);right:0}",
			".dshCost_panelTitle{color:var(--dsw-alias-label-primary);justify-content:space-between;",
			"gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
			".dshCost_panelRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
			".dshCost_panelValue{font-variant-numeric:tabular-nums}",
			".dshCost_details{color:var(--dsw-alias-label-tertiary);",
			"grid-template-columns:minmax(76px,auto) minmax(0,1fr) minmax(0,auto);gap:6px 16px;margin:0;display:grid}",
			".dshCost_details dt,.dshCost_details dd{min-width:0;margin:0}",
			".dshCost_details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;",
			"text-align:right}",
			".dshCost_route{overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary)!important}",
			".dshCost_models{color:var(--dsw-alias-label-tertiary);",
			"grid-template-columns:minmax(0,1fr) auto;gap:6px 16px;margin:0;display:grid}",
			".dshCost_models dt,.dshCost_models dd{min-width:0;margin:0;overflow-wrap:anywhere}",
			".dshCost_models dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;",
			"text-align:right}",
			".dshCost_panelNote{color:var(--dsw-alias-label-tertiary);margin:0}",
			".dshCost_section+.dshCost_section{margin-top:14px;padding-top:14px;",
			"border-top:1px solid var(--dsw-alias-border-l2)}",
			".dshCost_sectionHead{align-items:baseline;gap:8px;margin-bottom:8px;display:flex}",
			".dshCost_sectionTitle{color:var(--dsw-alias-label-primary);font-weight:500;flex:none}",
			".dshCost_sectionPeriod{min-width:0;color:var(--dsw-alias-label-tertiary);",
			"text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
			".dshCost_sectionHead .dshCost_panelValue{margin-left:auto;color:var(--dsw-alias-label-primary)}",
			".dshCost_footnote{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:11px}",
		].join("");

		/** Russian wording — what this owner reads (see {@link DICTIONARIES}). */
		const RUSSIAN = {
			"pill.cost": "≈ {amount} ₽ · {model}",
			"pill.unknown": "— ₽ · {model}",
			"panel.title": "Расход сессии (оценка)",
			"panel.input": "Вход без кэша",
			"panel.cacheRead": "Чтение из кэша",
			"panel.cacheWrite": "Запись в кэш",
			"panel.output": "Выход",
			"panel.total": "Итого",
			"panel.route": "Маршрут",
			"panel.tokens": "{count} ток",
			"pill.total": "Итого: ≈ {amount} ₽",
			"panel.dayTitle": "За день",
			"panel.weekTitle": "За неделю",
			"panel.dayEmpty": "Пока не тратилось",
			"panel.noTariff": "нет тарифа",
			"panel.since": "данные с {date}",
			"panel.note": "весь лог сессии по тарифу текущей модели",
		};

		/** English wording, kept for a quick switch and for the unrelated `zh` seat. */
		const ENGLISH = {
			"pill.cost": "≈ {amount} ₽ · {model}",
			"pill.unknown": "— ₽ · {model}",
			"panel.title": "Session spend (estimate)",
			"panel.input": "Input, uncached",
			"panel.cacheRead": "Cache read",
			"panel.cacheWrite": "Cache write",
			"panel.output": "Output",
			"panel.total": "Total",
			"panel.route": "Route",
			"panel.tokens": "{count} tok",
			"pill.total": "Total ≈ {amount} ₽",
			"panel.dayTitle": "Today",
			"panel.weekTitle": "This week",
			"panel.dayEmpty": "Nothing spent yet",
			"panel.noTariff": "no tariff",
			"panel.since": "data since {date}",
			"panel.note": "whole session log at the current model's rate",
		};

		/**
		 * One dictionary per locale id. This build ships no `ru` UI language, so the
		 * page answers as `en`, and `en` therefore carries the Russian wording this
		 * owner asked for. Point `en` at `ENGLISH` to restore the English labels.
		 */
		const DICTIONARIES = {
			en: RUSSIAN,
			ru: RUSSIAN,
			zh: ENGLISH,
		};

		/** Key one `provider/model` route holds in {@link TARIFFS}. */
		function routeKey(route) {
			if (route === undefined || route === null) return undefined;
			if (typeof route.provider !== "string" || typeof route.model !== "string") return undefined;
			return `${route.provider}/${route.model}`;
		}

		/**
		 * Route of the most recent routable step. The `tokenUsage` projection carries
		 * buckets only, so the model comes from the steps themselves — and the last one
		 * names the model actually in use, which matters after a mid-session switch.
		 * @param useChat - Session-standard Chat selector hook.
		 * @returns the `provider/model` key, or undefined when no step names one.
		 */
		function useLatestRoute(useChat) {
			if (typeof useChat !== "function") return undefined;
			return useChat((snapshot) => {
				const nodes = snapshot.legacy.nodes;
				for (let index = nodes.length - 1; index >= 0; index -= 1) {
					const route = routeKey(nodes[index].usage?.routes?.[0]);
					if (route !== undefined) return route;
				}
				return undefined;
			});
		}

		/**
		 * Route whose tariff prices this Session: the model of the last request, else the
		 * pending switch, else the last routable step, else the profile default.
		 * @param selection - the modelSelection projection value, when served.
		 * @param detected - route recovered from the chat window, as a fallback.
		 * @returns the `provider/model` key.
		 */
		function pickRoute(selection, detected) {
			return routeKey(selection?.lastUsed) ?? routeKey(selection?.next) ?? detected ?? DEFAULT_ROUTE;
		}

		/** Model part of a `provider/model` route, for a compact row label. */
		function shortRoute(route) {
			const parts = route.split("/");
			return parts.length > 1 ? parts[parts.length - 1] : route;
		}

		/** The four disjoint billing buckets a session reports, in display order. */
		function buckets(usage, tariff) {
			const uncached = usage.uncachedInputTokens ?? 0;
			const cacheRead = usage.cacheReadTokens ?? 0;
			const cacheWrite = usage.cacheWriteTokens ?? 0;
			const output = usage.outputTokens ?? 0;
			const rub = (tokens, rate) => (tokens * rate) / 1e6;
			return [
				{ key: "panel.input", tokens: uncached, rub: rub(uncached, tariff.input) },
				{ key: "panel.cacheRead", tokens: cacheRead, rub: rub(cacheRead, tariff.cacheRead) },
				{ key: "panel.cacheWrite", tokens: cacheWrite, rub: rub(cacheWrite, tariff.input) },
				{ key: "panel.output", tokens: output, rub: rub(output, tariff.output) },
			];
		}

		/** Russian money text: thousands in thin spaces, a comma before the kopeks. */
		function formatAmount(rub) {
			if (rub > 0 && rub < 0.01) return "<0,01";
			const [whole, fraction] = rub.toFixed(2).split(".");
			return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009")},${fraction}`;
		}

		/** Exact token count with grouped thousands. */
		function formatTokens(tokens) {
			return String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
		}

		/** `YYYY-MM-DD` from the ledger as the day a person reads: `ДД.ММ.ГГГГ`. */
		function formatDay(value) {
			if (typeof value !== "string") return "";
			const parts = value.split("-");
			return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : value;
		}

		/** Ruble mark drawn in the host's 14px pill slot. */
		function RubleMark() {
			return h(
				"svg",
				{ viewBox: "0 0 16 16", "aria-hidden": true, fill: "none" },
				h("path", {
					d: "M5.5 13V3.5h3.25a2.75 2.75 0 0 1 0 5.5H5.5M3.75 9.5h5.5",
					stroke: "currentColor",
					"stroke-width": 1.3,
					"stroke-linecap": "round",
					"stroke-linejoin": "round",
				}),
			);
		}

		/**
		 * Build one translator over the slot's locale seat.
		 * @param t - translate function supplied when this namespace is registered.
		 * @returns a translator that falls back to the Russian labels.
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
		 * The page's own day ledger: `{ "YYYY-MM-DD": { [sessionId]: { route, buckets } } }`.
		 *
		 * The desktop shell serves this page from `dsh-app://app`, so no page can read
		 * the Host's HTTP ledger route; the shell origin is stable, while the Web GUI's
		 * port is not, which makes `localStorage` the one durable container here. Every
		 * Session records its own whole-log totals the moment this cell sees it, and
		 * a later reading replaces an earlier one because `tokenUsage` only grows.
		 */
		const LEDGER_KEY = "dshCost.ledger.v1";

		/** Days the page ledger keeps. */
		const LEDGER_KEEP_DAYS = 30;

		/** The page's local day as `YYYY-MM-DD`. */
		function localDayKey(now = new Date()) {
			const pad = (value) => String(value).padStart(2, "0");
			return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		}

		/** @returns the page ledger, or an empty one when storage is unavailable. */
		function readPageLedger() {
			try {
				const raw = window.localStorage.getItem(LEDGER_KEY);
				const parsed = raw === null ? undefined : JSON.parse(raw);
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
			} catch {
				// Private mode or a hostile storage policy leaves the ledger empty.
			}
			return {};
		}

		/** Persist the page ledger, dropping days past {@link LEDGER_KEEP_DAYS}. */
		function writePageLedger(ledger) {
			const floor = localDayKey(new Date(Date.now() - LEDGER_KEEP_DAYS * 86400000));
			for (const day of Object.keys(ledger)) {
				if (day < floor) delete ledger[day];
			}
			try {
				window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
			} catch {
				// A full or refused storage keeps this page's reading in memory only.
			}
		}

		/** Sum one day's per-session buckets into one bucket set per route. */
		function foldDay(dayEntry) {
			const models = {};
			if (dayEntry === undefined || dayEntry === null) return models;
			for (const key of Object.keys(dayEntry)) {
				const record = dayEntry[key];
				if (record === undefined || record === null || typeof record.route !== "string") continue;
				const target = (models[record.route] ??= { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
				const source = record.buckets ?? {};
				target.uncached += source.uncached ?? 0;
				target.cacheRead += source.cacheRead ?? 0;
				target.cacheWrite += source.cacheWrite ?? 0;
				target.output += source.output ?? 0;
			}
			return models;
		}

		/**
		 * Anchor element and hover state for one cell's own panel. Leaving starts a
		 * short grace period so the pointer can travel into the panel.
		 */
		function useHoverPanel() {
			const anchorRef = React.useRef(null);
			const [open, setOpen] = React.useState(false);
			const [position, setPosition] = React.useState(undefined);
			const closeTimer = React.useRef(null);
			React.useEffect(
				() => () => {
					if (closeTimer.current !== null) clearTimeout(closeTimer.current);
				},
				[],
			);
			const enter = () => {
				if (closeTimer.current !== null) clearTimeout(closeTimer.current);
				closeTimer.current = null;
				const element = anchorRef.current;
				if (element !== null) {
					const rect = element.getBoundingClientRect();
					setPosition({
						right: Math.max(8, window.innerWidth - rect.right),
						bottom: Math.max(8, window.innerHeight - rect.top + 8),
					});
				}
				setOpen(true);
			};
			const leave = () => {
				if (closeTimer.current !== null) clearTimeout(closeTimer.current);
				closeTimer.current = setTimeout(() => {
					closeTimer.current = null;
					setOpen(false);
				}, 160);
			};
			return { anchorRef, open, position, enter, leave };
		}

		/** Ruble value of one route's ledger buckets under one tariff. */
		function ledgerRub(buckets, tariff) {
			return (
				((buckets.uncached ?? 0) * tariff.input +
					(buckets.cacheRead ?? 0) * tariff.cacheRead +
					(buckets.cacheWrite ?? 0) * tariff.input +
					(buckets.output ?? 0) * tariff.output) /
				1e6
			);
		}

		/**
		 * Hover panel: one row per billing bucket with its tokens, the rate applied,
		 * and the rubles that bucket cost.
		 * @param props - locale seat, route key, rows, and the estimated total.
		 */
		function SpendPanel({ tr, route, rows, total, floating, position }) {
			const details = [];
			// Every bucket is always listed: a zero row is information (this provider
			// caches implicitly and never reports a write), not noise.
			for (const row of rows) {
				details.push(h("dt", { key: `${row.key}:label` }, tr(row.key)));
				details.push(h("dd", { key: `${row.key}:tokens` }, tr("panel.tokens", { count: formatTokens(row.tokens) })));
				details.push(h("dd", { key: `${row.key}:rub` }, `${formatAmount(row.rub)} ₽`));
			}
			details.push(h("dt", { key: "route:label" }, tr("panel.route")));
			details.push(h("dd", { key: "route:value", className: "dshCost_route" }, route));
			return h(
				"div",
				{
					className: `dshCost_panel ${floating ? "dshCost_panelFloating" : "dshCost_panelInline"}`,
					role: "tooltip",
					style: position,
					"data-composer-stat-details": "cost",
				},
				h(
					"div",
					{ className: "dshCost_panelTitle" },
					h("span", null, tr("panel.title")),
					h("span", { className: "dshCost_panelValue" }, `≈ ${formatAmount(total)} ₽`),
				),
				h("div", { className: "dshCost_panelRule", "aria-hidden": true }),
				h("dl", { className: "dshCost_details" }, details),
				h("p", { className: "dshCost_footnote" }, tr("panel.note")),
			);
		}

		/**
		 * Composer statistics cell: estimated whole-session spend in rubles, with the
		 * per-bucket breakdown on hover.
		 * @param props - Session-standard projection selector and locale seat.
		 */
		const CostPill = React.memo(function CostPill({ useProjection, useChat, t }) {
			const tr = makeTranslator(t);
			const { anchorRef, open, position, enter, leave } = useHoverPanel();

			const usage = typeof useProjection === "function" ? useProjection("tokenUsage") : undefined;
			const selection = typeof useProjection === "function" ? useProjection("modelSelection") : undefined;
			const detected = useLatestRoute(useChat);

			if (usage === undefined || usage === null) return null;
			const key = pickRoute(selection, detected);
			const model = shortRoute(key);
			const tariff = TARIFFS[key];
			if (tariff === undefined) {
				// A route without a published rate still shows which model it is.
				return h(
					"span",
					{ className: "dshCost_anchor", "data-composer-stat": "cost" },
					h(
						"span",
						{ className: "dshCost_pill", title: key },
						h(RubleMark, null),
						h("span", { className: "dshCost_label" }, tr("pill.unknown", { model })),
					),
				);
			}
			const rows = buckets(usage, tariff);
			const total = rows.reduce((sum, row) => sum + row.rub, 0);
			if (total === 0) return null;

			const panel = open
				? h(SpendPanel, {
						tr,
						route: key,
						rows,
						total,
						floating: createPortal !== null && position !== undefined,
						position: createPortal !== null && position !== undefined ? position : undefined,
					})
				: null;

			return h(
				"span",
				{
					ref: anchorRef,
					className: "dshCost_anchor",
					"data-composer-stat": "cost",
					onPointerEnter: enter,
					onPointerLeave: leave,
				},
				h(
					"span",
					{ className: "dshCost_pill" },
					h(RubleMark, null),
					h(
						"span",
						{ className: "dshCost_label" },
						tr("pill.cost", { amount: formatAmount(total), model }),
					),
				),
				panel !== null && createPortal !== null && position !== undefined
					? createPortal(
							h("span", { onPointerEnter: enter, onPointerLeave: leave }, panel),
							document.body,
						)
					: panel,
			);
		});

		/**
		 * Hover panel of the total cell: one section per window (today, then the week),
		 * each listing its rows per model route and ending with the period it covers.
		 * @param props - locale seat, the sections, and the floating placement.
		 */
		function TotalsPanel({ tr, sections, footnote, floating, position }) {
			const blocks = sections.map((section, index) => {
				const models = [];
				for (const row of section.rows) {
					models.push(h("dt", { key: `r:${row.route}`, title: row.route }, shortRoute(row.route)));
					models.push(
						h(
							"dd",
							{ key: `v:${row.route}` },
							row.priced ? `${formatAmount(row.rub)} ₽` : tr("panel.noTariff"),
						),
					);
				}
				return h(
					"div",
					{ key: `section:${index}`, className: "dshCost_section" },
					h(
						"div",
						{ className: "dshCost_sectionHead" },
						h("span", { className: "dshCost_sectionTitle" }, section.title),
						h("span", { className: "dshCost_sectionPeriod" }, section.period),
						h("span", { className: "dshCost_panelValue" }, `≈ ${formatAmount(section.total)} ₽`),
					),
					h("div", { className: "dshCost_panelRule", "aria-hidden": true }),
					models.length === 0
						? h("p", { className: "dshCost_panelNote" }, tr("panel.dayEmpty"))
						: h("dl", { className: "dshCost_models" }, models),
				);
			});
			if (footnote !== undefined) {
				blocks.push(h("p", { key: "footnote", className: "dshCost_footnote" }, footnote));
			}
			return h(
				"div",
				{
					className: `dshCost_panel ${floating ? "dshCost_panelFloating" : "dshCost_panelInline"}`,
					role: "tooltip",
					style: position,
				},
				blocks,
			);
		}

		/**
		 * Price one route→buckets map into display rows plus their sum.
		 * @param models - folded buckets per route.
		 * @returns rows ascending by rubles, and the total of the priced ones.
		 */
		function pricedRoutes(models) {
			const rows = Object.keys(models)
				.map((route) => {
					const tariff = TARIFFS[route];
					return {
						route,
						rub: tariff === undefined ? 0 : ledgerRub(models[route], tariff),
						priced: tariff !== undefined,
					};
				})
				.sort((left, right) => right.rub - left.rub);
			return { rows, total: rows.reduce((sum, row) => sum + row.rub, 0) };
		}

		/** Sum the ledger over a trailing window of days, one bucket set per route. */
		function foldRange(ledger, windowDays) {
			const floor = localDayKey(new Date(Date.now() - (windowDays - 1) * 86400000));
			const models = {};
			for (const day of Object.keys(ledger)) {
				if (day < floor) continue;
				const folded = foldDay(ledger[day]);
				for (const route of Object.keys(folded)) {
					const target = (models[route] ??= { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
					target.uncached += folded[route].uncached;
					target.cacheRead += folded[route].cacheRead;
					target.cacheWrite += folded[route].cacheWrite;
					target.output += folded[route].output;
				}
			}
			return models;
		}

		/** First and last day text of a trailing window, as a person reads dates. */
		function periodOf(windowDays, day) {
			const floor = localDayKey(new Date(Date.now() - (windowDays - 1) * 86400000));
			return windowDays === 1 ? formatDay(day) : `${formatDay(floor)} — ${formatDay(day)}`;
		}

		/**
		 * Record one Session's whole-log totals into today's ledger.
		 * @param day - today's `YYYY-MM-DD` key.
		 * @param sessionId - the Session the reading belongs to.
		 * @param route - the `provider/model` that answered it.
		 * @param buckets - its four token totals.
		 */
		function recordSession(day, sessionId, route, buckets) {
			if (typeof sessionId !== "string") return;
			const ledger = readPageLedger();
			const today = (ledger[day] ??= {});
			const stored = today[sessionId];
			// `tokenUsage` is a whole-log total, so only a different reading is news.
			if (
				stored !== undefined &&
				stored.route === route &&
				(stored.buckets?.uncached ?? -1) === buckets.uncached &&
				(stored.buckets?.cacheRead ?? -1) === buckets.cacheRead &&
				(stored.buckets?.cacheWrite ?? -1) === buckets.cacheWrite &&
				(stored.buckets?.output ?? -1) === buckets.output
			) {
				return;
			}
			today[sessionId] = { route, buckets };
			writePageLedger(ledger);
		}

		/**
		 * Statistics cell of the whole-machine total: the headline is today's spend and
		 * the hover panel opens both today's and the week's breakdown by model. Every
		 * Session this cell sees records its own whole-log totals into the page ledger,
		 * and the figures are priced with the same {@link TARIFFS} table as the session
		 * cell.
		 * @param props - Session-standard selectors and the locale seat.
		 */
		function TotalSpend({ useProjection, useChat, sessionId, t }) {
			const tr = makeTranslator(t);
			const { anchorRef, open, position, enter, leave } = useHoverPanel();
			const usage = typeof useProjection === "function" ? useProjection("tokenUsage") : undefined;
			const selection = typeof useProjection === "function" ? useProjection("modelSelection") : undefined;
			const detected = useLatestRoute(useChat);

			const day = localDayKey();
			const uncached = usage === undefined || usage === null ? 0 : usage.uncachedInputTokens ?? 0;
			const cacheRead = usage === undefined || usage === null ? 0 : usage.cacheReadTokens ?? 0;
			const cacheWrite = usage === undefined || usage === null ? 0 : usage.cacheWriteTokens ?? 0;
			const output = usage === undefined || usage === null ? 0 : usage.outputTokens ?? 0;
			const [ledger, setLedger] = React.useState(() => readPageLedger());

			React.useEffect(() => {
				if (uncached + cacheRead + cacheWrite + output > 0) {
					recordSession(day, sessionId, pickRoute(selection, detected), {
						uncached,
						cacheRead,
						cacheWrite,
						output,
					});
				}
				setLedger(readPageLedger());
			}, [day, sessionId, selection, detected, uncached, cacheRead, cacheWrite, output]);

			const today = pricedRoutes(foldRange(ledger, 1));
			const week = pricedRoutes(foldRange(ledger, 7));
			if (today.total === 0 && week.total === 0) return null;
			// The first day the ledger holds explains why a week can equal a day.
			const firstDay = Object.keys(ledger).sort()[0];

			const panel = open
				? h(TotalsPanel, {
						tr,
						sections: [
							{
								title: tr("panel.dayTitle"),
								period: periodOf(1, day),
								rows: today.rows,
								total: today.total,
							},
							{
								title: tr("panel.weekTitle"),
								period: periodOf(7, day),
								rows: week.rows,
								total: week.total,
							},
						],
						footnote:
							firstDay === undefined
								? undefined
								: tr("panel.since", { date: formatDay(firstDay) }),
						floating: createPortal !== null && position !== undefined,
						position: createPortal !== null && position !== undefined ? position : undefined,
					})
				: null;

			return h(
				"span",
				{
					ref: anchorRef,
					className: "dshCost_anchor",
					"data-composer-stat": "cost-total",
					onPointerEnter: enter,
					onPointerLeave: leave,
				},
				h(
					"span",
					{ className: "dshCost_pill" },
					h(RubleMark, null),
					h("span", { className: "dshCost_label" }, tr("pill.total", { amount: formatAmount(today.total) })),
				),
				panel !== null && createPortal !== null && position !== undefined
					? createPortal(
							h("span", { onPointerEnter: enter, onPointerLeave: leave }, panel),
							document.body,
						)
					: panel,
			);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "@local/composer-cost";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "composer-cost: styles");
			ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "composer-cost: dictionaries");
			ctx.slots.inject("conversation.composer.dock", function* () {
				yield ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "cost",
						order: 2,
						locale: NS,
					},
					CostPill,
				);
				yield ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "cost-total",
						order: 3,
						locale: NS,
					},
					TotalSpend,
				);
			});
		}

		return { inject, apply };
	},
});
