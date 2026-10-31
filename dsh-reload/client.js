window.__ModuleLoader__.load({
	id: "@local/dsh-reload",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		/** Locale namespace this bundle owns. */
		const NS = "dshReload";

		/**
		 * Panel identity: the sidebar row id, the `main` slot key and the label the
		 * sidebar resolves all use this one string, so a click on the row selects the
		 * page registered under the same key.
		 */
		const PANEL_ID = "dsh-reload";

		/** Host routes (see `index.js`). */
		const ROUTE_RELOAD = "/dsh-reload/reload";
		const ROUTE_RESTART = "/dsh-reload/restart";
		const ROUTE_STATUS = "/dsh-reload/status";

		/** Header the Host routes demand, so only this page can call them. */
		const HEADER = "x-dsh-reload";

		/** Wording for the owner of this machine. */
		const RUSSIAN = {
			"panel.label": "Reload DSH",
			"panel.title": "Reload DSH",
			"panel.subtitle": "Применить изменения плагинов или поднять новый процесс Host.",
			"process.pid": "PID процесса: {pid}",
			"process.started": "запущен {at}",
			"process.unknown": "Состояние процесса недоступно",
			"process.refresh": "Обновить",
			"reload.title": "Перезагрузить плагины",
			"reload.body":
				"Профиль собирается заново: плагины с изменёнными на диске файлами перезапускаются, упавшие импорты повторяются, страница обновляется. Приложение остаётся открытым.",
			"reload.action": "Перезагрузить плагины",
			"reload.busy": "Перезагружаю…",
			"restart.title": "Перезапустить DSH полностью",
			"restart.body":
				"Новый процесс Host и приложения: окно закроется и откроется заново через несколько секунд. Нужно, когда изменение кэшируется на время жизни процесса — например, добавленная клиентская половина уже установленного плагина.",
			"restart.action": "Перезапустить DSH полностью",
			"restart.busy": "Перезапускаю…",
			"confirm.title": "Перезапустить DSH полностью?",
			"confirm.body": "Незавершённые ходы агентов будут прерваны. Логи сессий сливаются на диск перед выходом.",
			"confirm.go": "Перезапустить",
			"confirm.cancel": "Отмена",
			"agents.title": "Сейчас идёт работа агента",
			"agents.body": "Активных ходов: {count}. Перезапуск прервёт их: недописанный ответ пропадёт.",
			"agents.force": "Всё равно перезапустить",
			"restarting.title": "Перезапускаюсь…",
			"restarting.body":
				"Процесс Host {pid} завершается, приложение откроется заново само. Если окно не вернулось за минуту — запустите DeepSeek Harness вручную.",
			"failed.title": "Не удалось",
			"failed.body": "Хост вернул ошибку. Обычно это опечатка или исключение в плагине, который сейчас перезагружался.",
			"dismiss": "Скрыть",
			"reloadNotice.restartTitle": "Нужен полный перезапуск приложения",
			"reloadNotice.restartBody":
				"Часть изменений загрузится только новым процессом — используйте «Перезапустить DSH полностью». Страницу можно перезагрузить прямо сейчас.",
			"reloadNotice.pending": "Модулей до перезапуска: {count}",
			"reloadNotice.warnings": "Предупреждения профиля: {count}",
			"reloadNotice.reloadPage": "Перезагрузить страницу",
			"reason.no-hmr": "У Хоста нет службы горячей перезагрузки",
			"reason.package-moved": "Пакет плагина переехал на другой путь",
			"reason.host-module": "Изменён модуль самого Хоста",
			"reason.unmanaged-plugin": "Плагин загружен не из профиля",
			"reason.module-comparison": "Модуль изменился и требует нового процесса",
		};

		/** English wording, kept for a quick switch and for the unrelated `zh` seat. */
		const ENGLISH = {
			"panel.label": "Reload DSH",
			"panel.title": "Reload DSH",
			"panel.subtitle": "Apply plugin changes, or bring up a new Host process.",
			"process.pid": "Process pid: {pid}",
			"process.started": "started {at}",
			"process.unknown": "Process state is unavailable",
			"process.refresh": "Refresh",
			"reload.title": "Reload plugins",
			"reload.body":
				"The profile is recomposed: plugins whose files changed on disk restart, failed imports are retried, the page refreshes. The application stays open.",
			"reload.action": "Reload plugins",
			"reload.busy": "Reloading…",
			"restart.title": "Restart DSH completely",
			"restart.body":
				"A new Host and application process: the window closes and opens again in a few seconds. Needed when a change is cached for the process lifetime — for example a client half added to an already installed plugin.",
			"restart.action": "Restart DSH completely",
			"restart.busy": "Restarting…",
			"confirm.title": "Restart DSH completely?",
			"confirm.body": "Unfinished agent turns are interrupted. Session logs are flushed before the exit.",
			"confirm.go": "Restart",
			"confirm.cancel": "Cancel",
			"agents.title": "An agent is working right now",
			"agents.body": "Running turns: {count}. The restart interrupts them: an unfinished answer is lost.",
			"agents.force": "Restart anyway",
			"restarting.title": "Restarting…",
			"restarting.body":
				"Host process {pid} is shutting down; the application reopens by itself. If the window does not come back within a minute, start DeepSeek Harness by hand.",
			"failed.title": "Failed",
			"failed.body": "The Host returned an error. It is usually a typo or an exception in the plugin being reloaded.",
			"dismiss": "Dismiss",
			"reloadNotice.restartTitle": "A full application restart is required",
			"reloadNotice.restartBody":
				"Some changes only load in a new process — use \"Restart DSH completely\". The page itself can be reloaded right now.",
			"reloadNotice.pending": "Modules waiting for a restart: {count}",
			"reloadNotice.warnings": "Profile warnings: {count}",
			"reloadNotice.reloadPage": "Reload the page",
			"reason.no-hmr": "The Host has no hot-reload service",
			"reason.package-moved": "A plugin package moved to another path",
			"reason.host-module": "A Host module itself changed",
			"reason.unmanaged-plugin": "The plugin is not loaded from the profile",
			"reason.module-comparison": "A module changed and needs a new process",
		};

		/**
		 * One dictionary per locale id. This build ships no `ru` UI language, so the
		 * page answers as `en`; `en` therefore carries the Russian wording the owner
		 * asked for. Point `en` at `ENGLISH` to restore the English labels.
		 */
		const DICTIONARIES = { en: RUSSIAN, ru: RUSSIAN, zh: ENGLISH };

		/** Page, cards, status line and the inline result block. */
		const CSS = [
			".dshReload_page{box-sizing:border-box;height:100%;overflow:auto;padding:24px 28px 40px;",
			"color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
			".dshReload_pageHead{display:flex;align-items:flex-start;gap:16px;margin-bottom:20px}",
			".dshReload_pageTitle{font-size:18px;line-height:26px;font-weight:600}",
			".dshReload_pageSub{color:var(--dsw-alias-label-secondary);margin-top:2px}",
			".dshReload_cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));",
			"gap:12px;max-width:900px}",
			".dshReload_card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);",
			"border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);",
			"padding:16px;display:flex;flex-direction:column;gap:8px}",
			".dshReload_cardTitle{font-weight:500;color:var(--dsw-alias-label-primary)}",
			".dshReload_cardBody{color:var(--dsw-alias-label-secondary);flex:1;margin:0}",
			".dshReload_actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}",
			".dshReload_btn{box-sizing:border-box;font:inherit;border-radius:var(--dsw-radius-sm);",
			"padding:5px 12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);",
			"background:transparent;color:var(--dsw-alias-label-primary)}",
			".dshReload_btn:hover{background:var(--dsw-alias-bg-layer-2)}",
			".dshReload_btn:disabled{cursor:progress;opacity:.7}",
			".dshReload_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			// Inverted fill: the theme's strongest text colour, with the surface colour as
			// the label, so the pair contrasts in light and dark alike.
			".dshReload_btn[data-primary]{background:var(--dsw-alias-label-primary);",
			"border-color:transparent;color:var(--dsw-alias-bg-overlay);font-weight:500}",
			".dshReload_btn[data-primary]:hover{background:var(--dsw-alias-label-primary);opacity:.88}",
			".dshReload_btn[data-danger]{border-color:var(--dsw-alias-state-warn-primary);",
			"color:var(--dsw-alias-state-warn-primary)}",
			".dshReload_btn svg{width:14px;height:14px;vertical-align:-2px;margin-right:6px}",
			".dshReload_status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:18px 0 0;",
			"color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;max-width:900px}",
			".dshReload_dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}",
			".dshReload_message{box-sizing:border-box;margin:16px 0 0;max-width:900px;padding:14px 16px;",
			"border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);",
			"background:var(--dsw-alias-bg-layer-1)}",
			".dshReload_message[data-tone=warn]{border-color:var(--dsw-alias-state-warn-primary)}",
			".dshReload_message[data-tone=error]{border-color:var(--dsw-alias-state-error-primary)}",
			".dshReload_messageTitle{font-weight:500;margin-bottom:6px}",
			".dshReload_messageBody{margin:0 0 8px;color:var(--dsw-alias-label-secondary)}",
			".dshReload_messageList{margin:0 0 10px;padding-left:18px;color:var(--dsw-alias-label-tertiary)}",
			".dshReload_spin{animation:dshReload_spin .9s linear infinite}",
			"@keyframes dshReload_spin{to{transform:rotate(360deg)}}",
			"@media (prefers-reduced-motion:reduce){.dshReload_spin{animation:none}}",
		].join("");

		/**
		 * Build one translator over the page's locale seat.
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

		/** An instant as a person here reads it: ДД.ММ.ГГГГ ЧЧ:ММ:СС. */
		function formatTime(value) {
			const date = value instanceof Date ? value : new Date(value);
			if (Number.isNaN(date.getTime())) return String(value ?? "");
			const pad = (part) => String(part).padStart(2, "0");
			return (
				`${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ` +
				`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
			);
		}

		/** Circular-arrow mark; `size` comes from the sidebar strip. */
		function ReloadMark({ size }) {
			const edge = Number.isFinite(size) ? size : 16;
			return h(
				"svg",
				{ viewBox: "0 0 16 16", width: edge, height: edge, "aria-hidden": true, fill: "none" },
				h("path", {
					d: "M8 3.2a4.8 4.8 0 1 0 4.55 6.3",
					stroke: "currentColor",
					"stroke-width": 1.5,
					"stroke-linecap": "round",
				}),
				h("path", { d: "M8 1.1 11.1 3.3 8 5.5z", fill: "currentColor" }),
			);
		}

		/** POST a JSON body to one Host route. */
		async function postJson(route, body) {
			const response = await window.fetch(route, {
				method: "POST",
				headers: { [HEADER]: "1", "content-type": "application/json" },
				credentials: "same-origin",
				cache: "no-store",
				body: JSON.stringify(body ?? {}),
			});
			const text = await response.text();
			let value;
			try {
				value = text === "" ? {} : JSON.parse(text);
			} catch {
				value = { ok: false, error: text.slice(0, 200) };
			}
			return { status: response.status, value };
		}

		/** Read this Host process's facts. */
		async function readStatus() {
			const response = await window.fetch(ROUTE_STATUS, { credentials: "same-origin", cache: "no-store" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const value = await response.json();
			return value?.process ?? null;
		}

		/**
		 * Page «Reload DSH»: the two operations of this plugin side by side, the Host
		 * process's identity under them, and results reported inline — the panel stays
		 * open, so nothing hides behind a transient card.
		 * @param props - the locale seat.
		 */
		function ReloadPanel(props) {
			const tr = makeTranslator(props?.t);
			const [process, setProcess] = React.useState(null);
			const [processError, setProcessError] = React.useState(null);
			const [busy, setBusy] = React.useState(null);
			const [message, setMessage] = React.useState(null);
			const alive = React.useRef(true);

			const refreshStatus = React.useCallback(() => {
				readStatus()
					.then((value) => {
						if (!alive.current) return;
						setProcess(value);
						setProcessError(null);
					})
					.catch((error) => {
						if (!alive.current) return;
						setProcess(null);
						setProcessError(error instanceof Error ? error.message : String(error));
					});
			}, []);

			React.useEffect(() => {
				alive.current = true;
				refreshStatus();
				return () => {
					alive.current = false;
				};
			}, [refreshStatus]);

			/** Report one outcome inline. */
			const report = React.useCallback((next) => setMessage(next), []);

			/** Re-apply the profile, then rebuild the page. */
			const runReload = React.useCallback(async () => {
				if (busy !== null) return;
				setBusy("reload");
				setMessage(null);
				try {
					const { value } = await postJson(ROUTE_RELOAD);
					if (!alive.current) return;
					if (value?.ok !== true) {
						setBusy(null);
						report({
							tone: "error",
							title: tr("failed.title"),
							body: value?.error ?? tr("failed.body"),
							actions: [{ label: tr("dismiss"), onClick: () => setMessage(null) }],
						});
						return;
					}
					/*
					 * `unmanaged-plugin` is steady-state noise: a shared dependency that sits in
					 * the profile's `node_modules` without a Loader entry of its own (zod,
					 * schemastery, …) is listed on every reconcile and never restarts by design.
					 * Only a plugin-owned module or a profile-wide reason means a real restart.
					 */
					const pending = (Array.isArray(value.pending) ? value.pending : []).filter(
						(module) => module?.reason !== "unmanaged-plugin",
					);
					const warnings = Array.isArray(value.warnings) ? value.warnings : [];
					if (pending.length === 0 && value.restartReason == null) {
						window.location.reload();
						return;
					}
					setBusy(null);
					const lines = [];
					if (value.restartReason != null) lines.push(tr(`reason.${value.restartReason}`));
					if (pending.length > 0) lines.push(tr("reloadNotice.pending", { count: pending.length }));
					if (warnings.length > 0) lines.push(tr("reloadNotice.warnings", { count: warnings.length }));
					report({
						tone: "warn",
						title: tr("reloadNotice.restartTitle"),
						body: tr("reloadNotice.restartBody"),
						lines,
						actions: [
							{ label: tr("dismiss"), onClick: () => setMessage(null) },
							{ label: tr("reloadNotice.reloadPage"), primary: true, onClick: () => window.location.reload() },
						],
					});
				} catch (error) {
					if (!alive.current) return;
					setBusy(null);
					report({
						tone: "error",
						title: tr("failed.title"),
						body: error instanceof Error ? error.message : String(error),
						actions: [{ label: tr("dismiss"), onClick: () => setMessage(null) }],
					});
				}
			}, [busy, tr, report]);

			/** Ask, then restart the whole application. */
			const runRestart = React.useCallback(
				(force) => {
					postJson(ROUTE_RESTART, { force })
						.then(({ status, value }) => {
							if (!alive.current) return;
							if (status === 409 && force !== true) {
								const running = Array.isArray(value?.running) ? value.running : [];
								setBusy(null);
								report({
									tone: "warn",
									title: tr("agents.title"),
									body: tr("agents.body", { count: running.length }),
									actions: [
										{ label: tr("confirm.cancel"), onClick: () => setMessage(null) },
										{
											label: tr("agents.force"),
											danger: true,
											onClick: () => {
												setBusy("restart");
												setMessage(null);
												runRestart(true);
											},
										},
									],
								});
								return;
							}
							if (status === 202 && value?.ok === true) {
								setBusy("restart");
								report({
									tone: null,
									title: tr("restarting.title"),
									body: tr("restarting.body", { pid: value.pid }),
									actions: [],
								});
								return;
							}
							setBusy(null);
							report({
								tone: "error",
								title: tr("failed.title"),
								body: value?.error ?? value?.hint ?? `HTTP ${status}`,
								actions: [{ label: tr("dismiss"), onClick: () => setMessage(null) }],
							});
						})
						.catch((error) => {
							if (!alive.current) return;
							setBusy(null);
							report({
								tone: "error",
								title: tr("failed.title"),
								body: error instanceof Error ? error.message : String(error),
								actions: [{ label: tr("dismiss"), onClick: () => setMessage(null) }],
							});
						});
				},
				[tr, report],
			);

			const askRestart = React.useCallback(() => {
				if (busy !== null) return;
				setMessage({
					tone: "warn",
					title: tr("confirm.title"),
					body: tr("confirm.body"),
					actions: [
						{ label: tr("confirm.cancel"), onClick: () => setMessage(null) },
						{
							label: tr("confirm.go"),
							primary: true,
							onClick: () => {
								setBusy("restart");
								setMessage(null);
								runRestart(false);
							},
						},
					],
				});
			}, [busy, tr, runRestart]);

			const statusLine =
				process === null
					? h(
							"div",
							{ className: "dshReload_status" },
							h("span", { className: "dshReload_dot", style: { background: "var(--dsw-alias-state-idle-primary)" } }),
							h("span", null, processError === null ? tr("process.unknown") : `${tr("process.unknown")} (${processError})`),
						)
					: h(
							"div",
							{ className: "dshReload_status" },
							h("span", { className: "dshReload_dot" }),
							h("span", null, tr("process.pid", { pid: process.pid })),
							h("span", null, tr("process.started", { at: formatTime(process.startedAt) })),
						);

			const messageBlock =
				message === null
					? null
					: h(
							"div",
							{ className: "dshReload_message", "data-tone": message.tone ?? undefined, role: "status" },
							h("div", { className: "dshReload_messageTitle" }, message.title),
							message.body === undefined ? null : h("p", { className: "dshReload_messageBody" }, message.body),
							(message.lines ?? []).length === 0
								? null
								: h(
										"ul",
										{ className: "dshReload_messageList" },
										message.lines.map((line, index) => h("li", { key: `line:${index}` }, line)),
									),
							(message.actions ?? []).length === 0
								? null
								: h(
										"div",
										{ className: "dshReload_actions" },
										message.actions.map((action, index) =>
											h(
												"button",
												{
													key: `action:${index}`,
													type: "button",
													className: "dshReload_btn",
													"data-primary": action.primary === true ? "" : undefined,
													"data-danger": action.danger === true ? "" : undefined,
													onClick: action.onClick,
												},
												action.label,
											),
										),
									),
						);

			const card = (options) =>
				h(
					"section",
					{ className: "dshReload_card" },
					h("div", { className: "dshReload_cardTitle" }, options.title),
					h("p", { className: "dshReload_cardBody" }, options.body),
					h(
						"div",
						{ className: "dshReload_actions" },
						h(
							"button",
							{
								type: "button",
								className: "dshReload_btn",
								"data-primary": options.primary === true ? "" : undefined,
								"data-danger": options.danger === true ? "" : undefined,
								disabled: busy !== null,
								onClick: options.onClick,
							},
							h(ReloadMark, { size: 14 }),
							options.action,
						),
					),
				);

			return h(
				"div",
				{ className: "dshReload_page", "data-dsh-reload": "page" },
				h(
					"div",
					{ className: "dshReload_pageHead" },
					h(
						"div",
						null,
						h("div", { className: "dshReload_pageTitle" }, tr("panel.title")),
						h("div", { className: "dshReload_pageSub" }, tr("panel.subtitle")),
					),
				),
				h(
					"div",
					{ className: "dshReload_cards" },
					card({
						title: tr("reload.title"),
						body: tr("reload.body"),
						action: busy === "reload" ? tr("reload.busy") : tr("reload.action"),
						primary: true,
						onClick: runReload,
					}),
					card({
						title: tr("restart.title"),
						body: tr("restart.body"),
						action: busy === "restart" ? tr("restart.busy") : tr("restart.action"),
						danger: true,
						onClick: askRestart,
					}),
				),
				statusLine,
				messageBlock,
			);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "@local/dsh-reload";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "dsh-reload: styles");
			ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "dsh-reload: dictionaries");
			// The page itself: the `main` slot renders whichever key the sidebar selects.
			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, ReloadPanel),
			);
			// The row the user clicks in the left sidebar.
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 30,
						locale: NS,
						label: () => RUSSIAN["panel.label"],
					},
					ReloadMark,
				),
			);
		}

		return { inject, apply };
	},
});
