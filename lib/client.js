window.__ModuleLoader__.load({
	id: "dsh-agent-team-workflow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useRef, useState } = React;

		const API = "/plugins/dsh-agent-team-workflow/api";
		const STORAGE_KEY = "dsh-agent-team-workflow.workspace";
		const STYLE_ID = "dsh-agent-team-workflow-styles";
		const TITLE = "\u5de5\u4f5c\u6d41";

		const ITEM_STATUS = { active: "\u8fdb\u884c\u4e2d", blocked: "\u963b\u585e", done: "\u5df2\u5b8c\u6210", cancelled: "\u5df2\u53d6\u6d88" };
		const TASK_STATUS = { pending: "\u5f85\u5b9a", ready: "\u5f85\u9886\u53d6", running: "\u6267\u884c\u4e2d", completed: "\u5df2\u5b8c\u6210", failed: "\u5931\u8d25", cancelled: "\u5df2\u53d6\u6d88" };
		const HEALTH = { ok: "\u6b63\u5e38", degraded: "\u964d\u7ea7", blocked: "\u5df2\u5c01\u7981" };

		const CSS = `
.atw-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 10px;
  box-sizing: border-box;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, #1c2128);
  font-family: var(--dsw-font-family, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.45;
}
.atw-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.atw-title { font-size: 13px; font-weight: 600; white-space: nowrap; }
.atw-count { color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 12px; font-variant-numeric: tabular-nums; }
.atw-workspace {
  margin-left: auto;
  max-width: 42%;
  min-width: 0;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #5f6874);
  background: transparent;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 2px 5px;
}
.atw-btn {
  font: inherit;
  font-size: 12px;
  line-height: 1.3;
  color: var(--dsw-alias-label-secondary, #5f6874);
  background: transparent;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.atw-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.atw-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: 1px; }
.atw-btn[disabled] { opacity: .55; cursor: default; }
.atw-btn.atw-primary {
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f7cff));
  border-color: transparent;
}
.atw-btn.atw-danger { color: var(--dsw-alias-state-error-primary, #c53b3b); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c53b3b) 50%, transparent); }
.atw-error { margin: 0; color: var(--dsw-alias-state-error-primary, #c53b3b); font-size: 12px; }
.atw-muted { color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 12px; }
.atw-stats { display: flex; flex-wrap: wrap; gap: 4px; }
.atw-stat {
  display: inline-flex; gap: 4px; align-items: baseline;
  padding: 1px 7px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: 999px;
  color: var(--dsw-alias-label-tertiary, #8a929e);
  font-size: 11.5px;
  white-space: nowrap;
}
.atw-stat b { color: var(--dsw-alias-label-primary, #1c2128); font-weight: 600; font-variant-numeric: tabular-nums; }
.atw-decisions { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 0.5px solid var(--dsw-alias-state-warn-label, #b06b12); border-radius: var(--dsw-radius-md, 8px); background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 7%, transparent); }
.atw-decision { display: flex; align-items: center; gap: 6px; min-width: 0; }
.atw-decision span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.atw-decision .atw-btn { margin-left: auto; }
.atw-columns { display: flex; gap: 8px; flex: 1; min-height: 0; overflow: auto; align-items: flex-start; padding-bottom: 4px; }
.atw-column {
  flex: 1 0 190px;
  min-width: 190px;
  max-width: 260px;
  display: flex;
  flex-direction: column;
  max-height: 100%;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-md, 8px);
}
.atw-column-head { display: flex; align-items: baseline; gap: 5px; padding: 6px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.atw-column-head strong { font-size: 12.5px; font-weight: 600; }
.atw-column-head span { color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11.5px; margin-left: auto; }
.atw-cards { display: flex; flex-direction: column; gap: 6px; padding: 6px; overflow-y: auto; }
.atw-empty { color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 12px; padding: 4px 2px; }
.atw-card { border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-base, #fff); padding: 7px 8px; display: flex; flex-direction: column; gap: 4px; }
.atw-card.is-blocked { border-left: 2px solid var(--dsw-alias-state-warn-label, #b06b12); }
.atw-card.is-done { opacity: .78; }
.atw-card-top { display: flex; align-items: flex-start; gap: 6px; }
.atw-card-top strong { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 550; line-height: 1.4; overflow-wrap: anywhere; }
.atw-chip { flex: none; padding: 0 6px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11px; white-space: nowrap; }
.atw-chip.active { color: var(--dsw-alias-brand-primary, #4f7cff); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 45%, transparent); }
.atw-chip.blocked { color: var(--dsw-alias-state-warn-label, #b06b12); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 45%, transparent); }
.atw-chip.done { color: var(--dsw-alias-state-success-primary, #2f8a55); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f8a55) 45%, transparent); }
.atw-meta { color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11.5px; overflow-wrap: anywhere; }
.atw-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.atw-actions .atw-btn { padding: 2px 7px; }
.atw-detail { margin: 0; }
.atw-detail summary { cursor: pointer; color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11.5px; }
.atw-detail pre { margin: 4px 0 0; padding: 6px; max-height: 160px; overflow: auto; border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius: 4px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
.atw-lanes { display: flex; flex-wrap: wrap; gap: 6px; }
.atw-lane { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, #8a929e); }
.atw-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #2f8a55); flex: none; }
.atw-dot.degraded { background: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-dot.blocked { background: var(--dsw-alias-state-error-primary, #c53b3b); }
.atw-compose { display: flex; gap: 6px; }
.atw-compose input { flex: 1; min-width: 0; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary, #1c2128); background: var(--dsw-alias-bg-base, transparent); border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); border-radius: var(--dsw-radius-sm, 6px); padding: 4px 7px; }
.atw-header-btn {
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary, #5f6874);
  background: transparent; border: 0; border-radius: var(--dsw-radius-sm, 6px);
  padding: 2px 6px; cursor: pointer; white-space: nowrap;
}
.atw-header-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); color: var(--dsw-alias-label-primary, #1c2128); }
.atw-header-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: 1px; }
`;

		function ensureStyles() {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		async function getJson(path) {
			const response = await fetch(path, { cache: "no-store", headers: { accept: "application/json" } });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
			return payload;
		}

		async function postJson(path, body) {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(body),
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
			return payload;
		}

		function savedWorkspace() {
			try {
				return localStorage.getItem(STORAGE_KEY) ?? "";
			} catch {
				return "";
			}
		}

		function rememberWorkspace(path) {
			try {
				if (path) localStorage.setItem(STORAGE_KEY, path);
				else localStorage.removeItem(STORAGE_KEY);
			} catch {
				// Storage can be disabled; the in-memory selection still works.
			}
		}

		function WorkflowPanel() {
			const [workspaces, setWorkspaces] = useState([]);
			const [workspace, setWorkspace] = useState(savedWorkspace);
			const [payload, setPayload] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);
			const [draft, setDraft] = useState("");
			const alive = useRef(true);

			useEffect(() => {
				alive.current = true;
				getJson(`${API}/workspaces`)
					.then(result => {
						if (!alive.current) return;
						const list = Array.isArray(result.workspaces) ? result.workspaces : [];
						setWorkspaces(list);
						setWorkspace(current => {
							if (current && list.some(item => item.path === current)) return current;
							const withWorkflow = list.find(item => item.defined);
							return withWorkflow?.path ?? list[0]?.path ?? "";
						});
					})
					.catch(cause => alive.current && setError(cause.message));
				return () => {
					alive.current = false;
				};
			}, []);

			const load = useCallback(async () => {
				if (!workspace) return;
				try {
					const result = await getJson(`${API}/board?workspace=${encodeURIComponent(workspace)}`);
					if (!alive.current) return;
					setPayload(result);
					setError("");
				} catch (cause) {
					if (alive.current) setError(cause.message);
				}
			}, [workspace]);

			useEffect(() => {
				if (!workspace) return undefined;
				load();
				const timer = setInterval(() => {
					if (!document.hidden) load();
				}, 3000);
				return () => clearInterval(timer);
			}, [workspace, load]);

			const choose = next => {
				setWorkspace(next);
				rememberWorkspace(next);
				setPayload(null);
			};

			const act = async (path, body) => {
				if (!workspace) return;
				setBusy(true);
				try {
					await postJson(API + path, { workspace, ...body });
					await load();
				} catch (cause) {
					setError(cause.message);
				} finally {
					setBusy(false);
				}
			};

			const board = payload?.defined ? payload.board : null;
			const counts = board?.counts;
			const pending = board?.pendingGates ?? [];

			const header = h("div", { className: "atw-head" },
				h("span", { className: "atw-title" }, TITLE),
				counts ? h("span", { className: "atw-count" }, `${counts.items} 项`) : null,
				h("select", {
					className: "atw-workspace",
					value: workspace,
					"aria-label": "工作区",
					onChange: event => choose(event.currentTarget.value),
				}, workspaces.length === 0
					? h("option", { value: "" }, "无工作区")
					: workspaces.map(item => h("option", { key: item.path, value: item.path }, item.title))),
				h("button", { className: "atw-btn", type: "button", onClick: load, title: "刷新" }, "刷新"),
			);

			if (error) {
				return h("div", { className: "atw-panel" }, header, h("p", { className: "atw-error" }, error));
			}
			if (!workspace) {
				return h("div", { className: "atw-panel" }, header, h("p", { className: "atw-empty" }, "没有可用的工作区。"));
			}
			if (!payload) {
				return h("div", { className: "atw-panel" }, header, h("p", { className: "atw-empty" }, "载入中…"));
			}
			if (!payload.defined) {
				return h("div", { className: "atw-panel" }, header,
					h("p", { className: "atw-empty" }, "这个工作区还没有工作流。对助手说“创建一个自动开发的工作流”即可。"));
			}

			const stats = h("div", { className: "atw-stats" },
				stat("进行中", counts.active),
				stat("阻塞", counts.blocked),
				stat("已完成", counts.done),
				stat("执行中", `${counts.tasksRunning}/${counts.capacity}`),
				stat("待决策", counts.pendingGates),
			);

			const decisions = pending.length === 0 ? null : h("div", { className: "atw-decisions" },
				...pending.map(gate => h("div", { className: "atw-decision", key: `${gate.itemId}:${gate.gate}` },
					h("span", { title: gate.itemTitle }, `${gate.itemTitle} · ${gate.gate}`),
					h("button", {
						className: "atw-btn atw-primary", type: "button", disabled: busy,
						onClick: () => act("/gate", { itemId: gate.itemId, gate: gate.gate, decision: "approve" }),
					}, "通过"),
					h("button", {
						className: "atw-btn atw-danger", type: "button", disabled: busy,
						onClick: () => act("/gate", { itemId: gate.itemId, gate: gate.gate, decision: "reject" }),
					}, "拒绝"),
				)),
			);

			const columns = h("div", { className: "atw-columns" },
				...board.columns.map(column => h("section", { className: "atw-column", key: column.id },
					h("header", { className: "atw-column-head" },
						h("strong", {}, column.title),
						h("span", {}, String(column.items.length)),
					),
					h("div", { className: "atw-cards" },
						column.items.length === 0
							? h("p", { className: "atw-empty" }, "暂无任务")
							: column.items.map(item => card(item, act, busy)),
					),
				)),
			);

			const lanes = board.providers.length === 0 ? null : h("div", { className: "atw-lanes" },
				...board.providers.map(provider => h("span", { className: "atw-lane", key: provider.id, title: HEALTH[provider.health] ?? provider.health },
					h("span", { className: `atw-dot ${provider.health}` }),
					`${provider.id} ${provider.active}/${provider.concurrency ?? "?"}`,
				)),
			);

			const composer = h("form", {
				className: "atw-compose",
				onSubmit: event => {
					event.preventDefault();
					const title = draft.trim();
					if (title === "" || busy) return;
					setDraft("");
					act("/enqueue", { title });
				},
			},
				h("input", {
					value: draft,
					placeholder: "新建任务标题",
					"aria-label": "新建任务标题",
					onChange: event => setDraft(event.currentTarget.value),
				}),
				h("button", { className: "atw-btn atw-primary", type: "submit", disabled: busy || draft.trim() === "" }, "添加"),
			);

			return h("div", { className: "atw-panel" }, header, stats, decisions, columns, lanes, composer);
		}

		function stat(label, value) {
			return h("span", { className: "atw-stat", key: label }, label, h("b", {}, String(value ?? 0)));
		}

		function card(item, act, busy) {
			const pendingGates = item.gates.filter(gate => gate.status === "pending");
			const task = item.task;
			const meta = task
				? [TASK_STATUS[task.status] ?? task.status, task.assignee ?? "未指派", task.provider ?? "自动 lane"].join(" · ")
				: "没有活动任务";
			return h("article", { className: `atw-card${item.status === "blocked" ? " is-blocked" : ""}${item.status === "done" ? " is-done" : ""}`, key: item.id },
				h("div", { className: "atw-card-top" },
					h("strong", { title: item.title }, item.title),
					h("span", { className: `atw-chip ${item.status}` }, ITEM_STATUS[item.status] ?? item.status),
				),
				h("div", { className: "atw-meta" }, meta),
				pendingGates.length === 0 ? null : h("div", { className: "atw-actions" },
					...pendingGates.flatMap(gate => [
						h("button", {
							className: "atw-btn atw-primary", type: "button", key: `${gate.id}:approve`, disabled: busy,
							onClick: () => act("/gate", { itemId: item.id, gate: gate.id, decision: "approve" }),
						}, `通过 ${gate.id}`),
						h("button", {
							className: "atw-btn atw-danger", type: "button", key: `${gate.id}:reject`, disabled: busy,
							onClick: () => act("/gate", { itemId: item.id, gate: gate.id, decision: "reject" }),
						}, "拒绝"),
					]),
				),
				h("details", { className: "atw-detail" },
					h("summary", {}, "详情"),
					h("pre", {}, JSON.stringify({ id: item.id, task, gates: item.gates, contract: item.contract, result: item.result }, null, 2)),
				),
			);
		}

		function OpenButton({ open }) {
			return h("button", { className: "atw-header-btn", type: "button", title: "打开工作流看板", onClick: open }, TITLE);
		}

		function apply(ctx) {
			ensureStyles();
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: "dsh-agent-team-workflow",
				kind: "team-workflow",
				title: () => TITLE,
			}), "dsh-agent-team-workflow: tab type");
			ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: "dsh-agent-team-workflow",
			}, WorkflowPanel));
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "team-workflow-open",
				order: 60,
				inject: () => ({
					open: () => {
						ctx.get("sidebarRight")?.openTab("team-workflow");
					},
				}),
			}, OpenButton));
		}

		exports.apply = apply;
		exports.inject = ["slots", "sidebarRightTabs"];
		return module.exports;
	}
});
