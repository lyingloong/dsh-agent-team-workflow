window.__ModuleLoader__.load({
	id: "dsh-agent-team-workflow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useRef, useState } = React;

		const API = "/plugins/dsh-agent-team-workflow/api";
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
  background: var(--dsw-alias-bg-base, transparent);
}
.atw-hero {
  flex: none;
  padding: 10px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
}
.atw-hero-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.atw-mark {
  width: 30px; height: 30px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 9px;
  color: var(--dsw-alias-brand-primary, #4f7cff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 13%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 24%, transparent);
  font-size: 14px; font-weight: 650;
}
.atw-hero-copy { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.atw-hero-copy strong { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.atw-hero-copy span { color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11.5px; }
.atw-live { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11px; white-space: nowrap; }
.atw-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #2f8a55); }
.atw-refresh {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px;
  font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-tertiary, #8a929e);
  background: transparent;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm, 6px);
  cursor: pointer;
}
.atw-refresh:hover { color: var(--dsw-alias-label-primary, #1c2128); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); border-color: var(--dsw-alias-border-l1, rgba(127,127,127,.22)); }
.atw-progress {
  position: relative;
  height: 4px;
  margin-top: 9px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.16));
  overflow: hidden;
}
.atw-progress i { position: absolute; inset: 0 auto 0 0; border-radius: 999px; background: var(--dsw-alias-brand-primary, #4f7cff); transition: width .25s ease; }
.atw-legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11px; }
.atw-legend span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.atw-legend b { color: var(--dsw-alias-label-secondary, #5f6874); font-weight: 550; font-variant-numeric: tabular-nums; }
.atw-key { width: 6px; height: 6px; border-radius: 2px; background: var(--dsw-alias-brand-primary, #4f7cff); }
.atw-key.wait { background: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-key.done { background: var(--dsw-alias-state-success-primary, #2f8a55); }
.atw-key.idle { background: var(--dsw-alias-border-l3, #b8bec8); }
.atw-banner {
  flex: none;
  padding: 8px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 45%, transparent);
  border-radius: var(--dsw-radius-md, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 7%, transparent);
}
.atw-banner-title { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; color: var(--dsw-alias-state-warn-label, #b06b12); font-size: 12px; font-weight: 560; }
.atw-banner-title i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.atw-decision { display: flex; align-items: center; gap: 6px; padding: 3px 0; min-width: 0; }
.atw-decision span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.atw-btn {
  flex: none;
  font: inherit; font-size: 11.5px; line-height: 1.3;
  color: var(--dsw-alias-label-secondary, #5f6874);
  background: var(--dsw-alias-bg-base, transparent);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.atw-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.atw-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: 1px; }
.atw-btn[disabled] { opacity: .55; cursor: default; }
.atw-btn.atw-primary { color: var(--dsw-alias-label-primary-foreground, #fff); background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f7cff)); border-color: transparent; }
.atw-btn.atw-danger { color: var(--dsw-alias-state-error-primary, #c53b3b); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c53b3b) 45%, transparent); }
.atw-flow { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 2px 4px 0; }
.atw-node { display: flex; gap: 8px; }
.atw-node-rail { position: relative; width: 16px; flex: none; display: flex; justify-content: center; padding-top: 12px; }
.atw-node-dot { width: 8px; height: 8px; border-radius: 50%; z-index: 1; background: var(--dsw-alias-border-l3, #b8bec8); box-shadow: 0 0 0 3px var(--dsw-alias-bg-base, #fff); }
.atw-node-dot.active { background: var(--dsw-alias-brand-primary, #4f7cff); }
.atw-node-dot.wait { background: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-node-dot.done { background: var(--dsw-alias-state-success-primary, #2f8a55); }
.atw-node:not(:last-child) .atw-node-rail::after { content: ""; position: absolute; top: 20px; bottom: -2px; width: 1px; background: var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.atw-node-card {
  flex: 1; min-width: 0;
  padding: 8px;
  margin-bottom: 8px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
}
.atw-node-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.atw-node-head strong { font-size: 12.5px; font-weight: 600; }
.atw-role { padding: 0 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 10.5px; white-space: nowrap; }
.atw-node-count { margin-left: auto; color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11px; font-variant-numeric: tabular-nums; }
.atw-node-items { display: flex; flex-direction: column; gap: 6px; margin-top: 7px; }
.atw-idle { color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11.5px; padding: 1px 0; }
.atw-card {
  padding: 7px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-base, #fff);
  display: flex; flex-direction: column; gap: 4px;
  box-shadow: var(--dsw-elevation-soft, 0 1px 2px rgba(0,0,0,.03));
}
.atw-card.is-blocked { border-left: 2px solid var(--dsw-alias-state-warn-label, #b06b12); }
.atw-card.is-done { opacity: .75; }
.atw-card-top { display: flex; align-items: flex-start; gap: 6px; }
.atw-card-top strong { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 550; line-height: 1.4; overflow-wrap: anywhere; }
.atw-chip { flex: none; padding: 0 6px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 10.5px; white-space: nowrap; }
.atw-chip.active { color: var(--dsw-alias-brand-primary, #4f7cff); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 42%, transparent); }
.atw-chip.blocked { color: var(--dsw-alias-state-warn-label, #b06b12); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 42%, transparent); }
.atw-chip.done { color: var(--dsw-alias-state-success-primary, #2f8a55); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f8a55) 42%, transparent); }
.atw-card-meta { color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11px; overflow-wrap: anywhere; }
.atw-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 1px; }
.atw-actions .atw-btn { padding: 2px 7px; }
.atw-detail { margin: 0; }
.atw-detail summary { cursor: pointer; color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 10.5px; }
.atw-detail pre { margin: 4px 0 0; padding: 6px; max-height: 150px; overflow: auto; border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22)); border-radius: 4px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); font-size: 10.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.atw-foot { flex: none; display: flex; flex-direction: column; gap: 6px; }
.atw-lanes { display: flex; flex-wrap: wrap; gap: 7px; }
.atw-lane { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #8a929e); }
.atw-lane-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #2f8a55); flex: none; }
.atw-lane-dot.degraded { background: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-lane-dot.blocked { background: var(--dsw-alias-state-error-primary, #c53b3b); }
.atw-compose { display: flex; gap: 6px; }
.atw-compose input {
  flex: 1; min-width: 0;
  font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-primary, #1c2128);
  background: var(--dsw-alias-bg-base, transparent);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  border-radius: var(--dsw-radius-sm, 6px);
  padding: 4px 7px;
}
.atw-compose input:focus { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: -1px; }
.atw-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; flex: 1; min-height: 120px; padding: 20px; text-align: center;
  color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 12px;
}
.atw-empty-mark {
  width: 38px; height: 38px; border-radius: 11px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-brand-primary, #4f7cff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 12%, transparent);
  font-size: 17px;
}
.atw-empty strong { color: var(--dsw-alias-label-secondary, #5f6874); font-size: 12.5px; font-weight: 550; }
.atw-error { margin: 0; color: var(--dsw-alias-state-error-primary, #c53b3b); font-size: 12px; }
.atw-header-btn {
  font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary, #5f6874);
  background: transparent; border: 0; border-radius: var(--dsw-radius-sm, 6px);
  padding: 2px 6px; cursor: pointer; white-space: nowrap;
}
.atw-header-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); color: var(--dsw-alias-label-primary, #1c2128); }
.atw-header-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: 1px; }
`;

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

		function initialOf(name) {
			const text = typeof name === "string" ? name.trim() : "";
			return text === "" ? "\u25c7" : text.slice(0, 1).toUpperCase();
		}

		function nodeTone(column) {
			if (column.items.some(item => item.status === "blocked")) return "wait";
			if (column.items.some(item => item.status === "active")) return "active";
			if (column.items.length > 0 && column.items.every(item => item.status === "done")) return "done";
			return "";
		}

		function WorkflowPanel({ sessionId }) {
			const [payload, setPayload] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);
			const [draft, setDraft] = useState("");
			const alive = useRef(true);

			const load = useCallback(async () => {
				if (!sessionId) return;
				try {
					const result = await getJson(`${API}/board?session=${encodeURIComponent(sessionId)}`);
					if (!alive.current) return;
					setPayload(result);
					setError("");
				} catch (cause) {
					if (alive.current) setError(cause.message);
				}
			}, [sessionId]);

			useEffect(() => {
				alive.current = true;
				if (!sessionId) return undefined;
				load();
				const timer = setInterval(() => {
					if (!document.hidden) load();
				}, 3000);
				return () => {
					alive.current = false;
					clearInterval(timer);
				};
			}, [sessionId, load]);

			const act = async (path, body) => {
				if (!sessionId) return;
				setBusy(true);
				try {
					await postJson(API + path, { session: sessionId, ...body });
					await load();
				} catch (cause) {
					setError(cause.message);
				} finally {
					setBusy(false);
				}
			};

			if (!sessionId) {
				return h("div", { className: "atw-panel" },
					h("div", { className: "atw-empty" },
						h("span", { className: "atw-empty-mark" }, "\u25c7"),
						h("strong", {}, TITLE),
						h("span", {}, "当前面板没有绑定会话。"),
					),
				);
			}

			if (error) {
				return h("div", { className: "atw-panel" },
					h("p", { className: "atw-error" }, error),
					h("button", { className: "atw-btn", type: "button", onClick: load }, "重试"),
				);
			}
			if (!payload) {
				return h("div", { className: "atw-panel" }, h("div", { className: "atw-empty" }, "载入中…"));
			}
			if (!payload.defined) {
				return h("div", { className: "atw-panel" },
					h("div", { className: "atw-empty" },
						h("span", { className: "atw-empty-mark" }, "\u25c7"),
						h("strong", {}, "这个会话还没有工作流"),
						h("span", {}, "对助手说“创建一个自动开发的工作流”即可。"),
					),
				);
			}

			const board = payload.board;
			const workflow = board.workflow;
			const counts = board.counts;
			const total = counts.items;
			const percent = total === 0 ? 0 : Math.round((counts.done / total) * 100);
			const pending = board.pendingGates ?? [];

			const hero = h("header", { className: "atw-hero" },
				h("div", { className: "atw-hero-top" },
					h("span", { className: "atw-mark" }, initialOf(workflow.name)),
					h("div", { className: "atw-hero-copy" },
						h("strong", { title: workflow.name }, workflow.name),
						h("span", {}, `${workflow.stages.length} 个节点 · ${workflow.roles.length} 个角色`),
					),
					h("span", { className: "atw-live", title: "工作流与会话绑定" }, h("i", {}), "会话工作流"),
					h("button", { className: "atw-refresh", type: "button", title: "刷新", onClick: load }, "\u21bb"),
				),
				h("div", { className: "atw-progress" }, h("i", { style: { width: `${percent}%` } })),
				h("div", { className: "atw-legend" },
					h("span", {}, h("i", { className: "atw-key" }), "进行中 ", h("b", {}, counts.active)),
					h("span", {}, h("i", { className: "atw-key wait" }), "阻塞 ", h("b", {}, counts.blocked)),
					h("span", {}, h("i", { className: "atw-key done" }), "完成 ", h("b", {}, counts.done)),
					h("span", {}, h("i", { className: "atw-key idle" }), "待决策 ", h("b", {}, counts.pendingGates)),
					h("span", { style: { marginLeft: "auto" } }, h("b", {}, percent), "%"),
				),
			);

			const banner = pending.length === 0 ? null : h("div", { className: "atw-banner" },
				h("div", { className: "atw-banner-title" }, h("i", {}), `${pending.length} 个节点等待你决策`),
				...pending.map(gate => h("div", { className: "atw-decision", key: `${gate.itemId}:${gate.gate}` },
					h("span", { title: `${gate.itemTitle} · ${gate.gate}` }, `${gate.itemTitle} · ${gate.gate}`),
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

			const flow = h("div", { className: "atw-flow" },
				...board.columns.map(column => h("div", { className: "atw-node", key: column.id },
					h("div", { className: "atw-node-rail" }, h("span", { className: `atw-node-dot ${nodeTone(column)}` })),
					h("div", { className: "atw-node-card" },
						h("div", { className: "atw-node-head" },
							h("strong", {}, column.title),
							h("span", { className: "atw-role" }, column.role),
							h("span", { className: "atw-node-count" }, String(column.items.length)),
						),
						h("div", { className: "atw-node-items" },
							column.items.length === 0
								? h("span", { className: "atw-idle" }, "空闲")
								: column.items.map(item => card(item, act, busy)),
						),
					),
				)),
			);

			const lanes = board.providers.length === 0 ? null : h("div", { className: "atw-lanes" },
				...board.providers.map(provider => h("span", { className: "atw-lane", key: provider.id, title: HEALTH[provider.health] ?? provider.health },
					h("i", { className: `atw-lane-dot ${provider.health}` }),
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
					act("/enqueue", { title, input: {} });
				},
			},
				h("input", {
					value: draft,
					placeholder: "新建任务并加入入口节点",
					"aria-label": "新建任务标题",
					onChange: event => setDraft(event.currentTarget.value),
				}),
				h("button", { className: "atw-btn atw-primary", type: "submit", disabled: busy || draft.trim() === "" }, "添加"),
			);

			return h("div", { className: "atw-panel" }, hero, banner, flow, h("footer", { className: "atw-foot" }, lanes, composer));
		}

		function card(item, act, busy) {
			const pendingGates = item.gates.filter(gate => gate.status === "pending");
			const task = item.task;
			const meta = task
				? `${TASK_STATUS[task.status] ?? task.status} · ${task.assignee ?? "未指派"}${task.provider ? ` · ${task.provider}` : ""}`
				: "没有活动任务";
			return h("article", { className: `atw-card${item.status === "blocked" ? " is-blocked" : ""}${item.status === "done" ? " is-done" : ""}`, key: item.id },
				h("div", { className: "atw-card-top" },
					h("strong", { title: item.title }, item.title),
					h("span", { className: `atw-chip ${item.status}` }, ITEM_STATUS[item.status] ?? item.status),
				),
				h("div", { className: "atw-card-meta" }, meta),
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
			ctx.effect(() => {
				if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return () => {};
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, "dsh-agent-team-workflow: styles");
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
