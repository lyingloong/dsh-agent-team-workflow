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
		const TITLE = "工作流";
		const RUN_STATUS = { running: "运行中", waiting: "等待决策", done: "已完成", failed: "失败" };
		const TOKEN_STATUS = { ready: "就绪", running: "执行中", waiting: "等待", completed: "已完成", failed: "失败" };
		const NODE_TYPE = {
			agent: "模型",
			command: "命令",
			http: "HTTP",
			human: "人工",
			fanout: "扇出",
			join: "聚合",
			subworkflow: "子流程",
		};

		const CSS = `
.atw-panel { position:relative; display:flex; flex-direction:column; gap:7px; height:100%; min-height:0; padding:9px; box-sizing:border-box; overflow:hidden; color:var(--dsw-alias-label-primary,#1c2128); font-family:var(--dsw-font-family,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif); font-size:13px; line-height:1.4; background:var(--dsw-alias-bg-base,transparent); }
.atw-top { flex:none; display:flex; flex-direction:column; gap:6px; padding:9px 10px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:var(--dsw-radius-lg,10px); background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05)); }
.atw-top-main { display:flex; align-items:flex-start; gap:8px; min-width:0; }
.atw-mark { width:30px; height:30px; flex:none; display:inline-flex; align-items:center; justify-content:center; border-radius:9px; color:var(--dsw-alias-brand-primary,#4f7cff); background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 12%,transparent); border:0.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 25%,transparent); font-size:14px; font-weight:650; }
.atw-copy { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
.atw-name-row { display:flex; align-items:center; gap:6px; min-width:0; }
.atw-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13.5px; font-weight:620; letter-spacing:.1px; }
.atw-sub { color:var(--dsw-alias-label-tertiary,#8a929e); font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.atw-icon-btn { flex:none; width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; font:inherit; font-size:14px; color:var(--dsw-alias-label-tertiary,#8a929e); background:transparent; border:0.5px solid transparent; border-radius:var(--dsw-radius-sm,6px); cursor:pointer; }
.atw-icon-btn:hover { color:var(--dsw-alias-label-primary,#1c2128); background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.22)); }
.atw-icon-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f7cff); outline-offset:1px; }
.atw-status { flex:none; padding:0 6px; border-radius:999px; border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3)); color:var(--dsw-alias-label-tertiary,#8a929e); font-size:9.5px; line-height:16px; white-space:nowrap; }
.atw-status.running { color:var(--dsw-alias-brand-primary,#4f7cff); border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 40%,transparent); }
.atw-status.waiting { color:var(--dsw-alias-state-warn-label,#b06b12); border-color:color-mix(in srgb,var(--dsw-alias-state-warn-label,#b06b12) 42%,transparent); }
.atw-status.done { color:var(--dsw-alias-state-success-primary,#2f8a55); border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f8a55) 42%,transparent); }
.atw-status.failed { color:var(--dsw-alias-state-error-primary,#c53b3b); border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c53b3b) 42%,transparent); }
.atw-permissions { display:flex; flex-wrap:wrap; gap:4px; }
.atw-perm { padding:0 5px; border-radius:999px; background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08)); color:var(--dsw-alias-label-tertiary,#8a929e); font-size:9px; line-height:15px; white-space:nowrap; }
.atw-perm.on { color:var(--dsw-alias-state-success-primary,#2f8a55); }
.atw-stage { flex:1; min-height:0; overflow:auto; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:var(--dsw-radius-md,8px); background-color:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04)); background-image:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-border-l2,rgba(127,127,127,.3)) 38%,transparent) 0.7px,transparent 0.8px); background-size:16px 16px; background-position:center top; }
.atw-graph-wrap { height:100%; min-height:0; display:flex; align-items:center; justify-content:center; padding:7px; box-sizing:border-box; }
.atw-graph-svg { display:block; max-width:100%; max-height:100%; overflow:visible; }
.atw-graph-box { fill:var(--dsw-alias-bg-base,#fff); stroke:var(--dsw-alias-border-l2,rgba(127,127,127,.3)); stroke-width:.9; filter:drop-shadow(0 1px 2px rgba(0,0,0,.07)); transition:stroke .15s ease,fill .15s ease; }
.atw-graph-box.active { stroke:var(--dsw-alias-brand-primary,#4f7cff); }
.atw-graph-box.wait { stroke:var(--dsw-alias-state-warn-label,#b06b12); }
.atw-graph-box.done { stroke:var(--dsw-alias-state-success-primary,#2f8a55); }
.atw-graph-box.error { stroke:var(--dsw-alias-state-error-primary,#c53b3b); }
.atw-graph-node { cursor:pointer; }
.atw-graph-node:hover .atw-graph-box { fill:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); }
.atw-graph-node:focus-visible .atw-graph-box { stroke-width:1.7; stroke:var(--dsw-alias-brand-primary,#4f7cff); }
.atw-graph-title { font-size:10.5px; font-weight:600; fill:var(--dsw-alias-label-primary,#1c2128); }
.atw-graph-sub { font-size:8.5px; fill:var(--dsw-alias-label-tertiary,#8a929e); }
.atw-graph-model { font-size:8.5px; fill:var(--dsw-alias-label-secondary,#5f6874); }
.atw-graph-dot { stroke:var(--dsw-alias-bg-base,#fff); stroke-width:1.2; }
.atw-graph-count { fill:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08)); }
.atw-graph-count-text { font-size:8.5px; fill:var(--dsw-alias-label-secondary,#5f6874); font-variant-numeric:tabular-nums; }
.atw-edge-pill { fill:var(--dsw-alias-bg-base,#fff); stroke:var(--dsw-alias-border-l1,rgba(127,127,127,.22)); stroke-width:.5; }
.atw-edge-label { font-size:8.5px; fill:var(--dsw-alias-label-tertiary,#8a929e); }
.atw-waiting { flex:none; max-height:132px; overflow-y:auto; padding:7px 8px; border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-label,#b06b12) 36%,transparent); border-radius:var(--dsw-radius-md,8px); background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#b06b12) 6%,transparent); }
.atw-waiting-head { display:flex; align-items:center; gap:5px; margin-bottom:4px; color:var(--dsw-alias-state-warn-label,#b06b12); font-size:10.5px; font-weight:550; }
.atw-waiting-head i { width:5px; height:5px; border-radius:50%; background:currentColor; }
.atw-decision { display:flex; align-items:center; gap:5px; padding:2px 0; min-width:0; }
.atw-decision span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10.5px; }
.atw-bottom { flex:none; display:flex; align-items:center; gap:6px; }
.atw-bottom-right { margin-left:auto; display:flex; align-items:center; gap:5px; }
.atw-btn { flex:none; font:inherit; font-size:10.5px; line-height:1.3; color:var(--dsw-alias-label-secondary,#5f6874); background:var(--dsw-alias-bg-base,transparent); border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3)); border-radius:var(--dsw-radius-sm,6px); padding:3px 7px; cursor:pointer; white-space:nowrap; }
.atw-btn:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); }
.atw-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f7cff); outline-offset:1px; }
.atw-btn[disabled] { opacity:.45; cursor:default; }
.atw-btn.atw-primary { color:var(--dsw-alias-label-primary-foreground,#fff); background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f7cff)); border-color:transparent; }
.atw-btn.atw-danger { color:var(--dsw-alias-state-error-primary,#c53b3b); border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c53b3b) 40%,transparent); }
.atw-sheet-backdrop { position:absolute; inset:0; z-index:30; display:flex; align-items:center; justify-content:center; padding:9px; box-sizing:border-box; background:color-mix(in srgb,var(--dsw-alias-bg-base,#000) 34%,transparent); }
.atw-sheet { width:100%; max-height:90%; display:flex; flex-direction:column; overflow:hidden; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25)); border-radius:var(--dsw-radius-lg,10px); background:var(--dsw-alias-bg-base,#fff); box-shadow:0 12px 32px rgba(0,0,0,.18); }
.atw-sheet-head { flex:none; display:flex; align-items:center; gap:6px; padding:7px 9px; border-bottom:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); }
.atw-sheet-head strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:600; }
.atw-sheet-body { flex:1; min-height:0; overflow:auto; padding:8px 9px; display:flex; flex-direction:column; gap:7px; }
.atw-sheet-foot { flex:none; display:flex; gap:6px; justify-content:flex-end; padding:7px 9px; border-top:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); }
.atw-kv { display:grid; grid-template-columns:auto minmax(0,1fr); gap:3px 8px; margin:0; font-size:10.5px; }
.atw-kv dt { color:var(--dsw-alias-label-tertiary,#8a929e); white-space:nowrap; }
.atw-kv dd { margin:0; color:var(--dsw-alias-label-secondary,#5f6874); overflow-wrap:anywhere; }
.atw-pre { margin:0; padding:6px; max-height:180px; overflow:auto; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:4px; background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06)); font-size:10px; white-space:pre-wrap; overflow-wrap:anywhere; }
.atw-models { display:flex; flex-direction:column; gap:4px; padding:6px 7px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:var(--dsw-radius-sm,6px); background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04)); }
.atw-models-head { display:flex; align-items:baseline; gap:6px; }
.atw-models-head span { color:var(--dsw-alias-label-tertiary,#8a929e); font-size:10px; }
.atw-models-head em { margin-left:auto; color:var(--dsw-alias-label-tertiary,#8a929e); font-size:9px; font-style:normal; }
.atw-model-row { display:flex; align-items:center; gap:4px; min-width:0; }
.atw-model-index { flex:none; width:15px; height:15px; display:inline-flex; align-items:center; justify-content:center; border-radius:50%; background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08)); color:var(--dsw-alias-label-tertiary,#8a929e); font-size:8.5px; }
.atw-model-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary,#5f6874); font-size:10px; }
.atw-mini { flex:none; width:17px; height:17px; display:inline-flex; align-items:center; justify-content:center; font:inherit; font-size:11px; line-height:1; color:var(--dsw-alias-label-tertiary,#8a929e); background:transparent; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:4px; cursor:pointer; padding:0; }
.atw-mini:hover { color:var(--dsw-alias-label-primary,#1c2128); background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); }
.atw-mini[disabled] { opacity:.35; cursor:default; }
.atw-mini.danger:hover { color:var(--dsw-alias-state-error-primary,#c53b3b); border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c53b3b) 35%,transparent); }
.atw-model-add { display:flex; align-items:center; gap:4px; margin-top:1px; }
.atw-model-add em { flex:none; color:var(--dsw-alias-state-warn-label,#b06b12); font-size:9px; font-style:normal; }
.atw-model-select { flex:1; min-width:0; font:inherit; font-size:10px; color:var(--dsw-alias-label-primary,#1c2128); background:var(--dsw-alias-bg-base,transparent); border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3)); border-radius:4px; padding:2px 4px; }
.atw-model-select:focus { outline:2px solid var(--dsw-alias-brand-primary,#4f7cff); outline-offset:-1px; }
.atw-token { display:flex; align-items:center; gap:5px; min-width:0; padding:3px 5px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18)); border-radius:4px; font-size:10px; }
.atw-token strong { flex:none; }
.atw-token span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-tertiary,#8a929e); }
.atw-token b { margin-left:auto; flex:none; font-weight:500; color:var(--dsw-alias-label-tertiary,#8a929e); }
.atw-token b.done { color:var(--dsw-alias-state-success-primary,#2f8a55); }
.atw-token b.error { color:var(--dsw-alias-state-error-primary,#c53b3b); }
.atw-token b.wait { color:var(--dsw-alias-state-warn-label,#b06b12); }
.atw-token-list { display:flex; flex-direction:column; gap:3px; }
.atw-empty { flex:1; min-height:120px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; padding:18px; text-align:center; color:var(--dsw-alias-label-tertiary,#8a929e); font-size:11.5px; }
.atw-empty-mark { width:38px; height:38px; border-radius:11px; display:inline-flex; align-items:center; justify-content:center; color:var(--dsw-alias-brand-primary,#4f7cff); background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 12%,transparent); font-size:16px; }
.atw-empty strong { color:var(--dsw-alias-label-secondary,#5f6874); font-size:12px; font-weight:550; }
.atw-toast { position:absolute; left:9px; right:9px; bottom:9px; z-index:40; padding:6px 8px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:var(--dsw-radius-sm,6px); background:var(--dsw-alias-bg-base,#fff); box-shadow:0 4px 14px rgba(0,0,0,.12); font-size:10.5px; }
.atw-toast.ok { color:var(--dsw-alias-state-success-primary,#2f8a55); }
.atw-toast.error { color:var(--dsw-alias-state-error-primary,#c53b3b); }
.atw-spinner { width:17px; height:17px; border-radius:50%; border:2px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16)); border-top-color:var(--dsw-alias-brand-primary,#4f7cff); animation:atw-spin .8s linear infinite; }
@keyframes atw-spin { to { transform:rotate(360deg); } }
.atw-header-btn { font:inherit; font-size:12px; color:var(--dsw-alias-label-secondary,#5f6874); background:transparent; border:0; border-radius:var(--dsw-radius-sm,6px); padding:2px 6px; cursor:pointer; white-space:nowrap; }
.atw-header-btn:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); color:var(--dsw-alias-label-primary,#1c2128); }
.atw-header-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f7cff); outline-offset:1px; }
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

		function timeAgo(value) {
			const parsed = Date.parse(value ?? "");
			if (!Number.isFinite(parsed)) return "";
			const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
			if (seconds < 45) return "刚刚";
			if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
			if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
			return `${Math.floor(seconds / 86400)} 天前`;
		}

		function tokenTone(status) {
			if (status === "waiting") return "wait";
			if (status === "failed") return "error";
			if (status === "running" || status === "ready") return "active";
			if (status === "completed") return "done";
			return "";
		}

		function latestByNode(tokens) {
			const latest = new Map();
			for (const token of tokens ?? []) latest.set(token.nodeId, token);
			return latest;
		}

		function laneOf(node, definition) {
			return (definition.providers ?? []).find(provider => provider.id === node.config?.lane) ?? null;
		}

		function selectedModelsOf(node, definition) {
			const configured = Array.isArray(node.config?.models) ? node.config.models : [];
			if (configured.length > 0) {
				return configured
					.filter(entry => entry && typeof entry.provider === "string" && typeof entry.model === "string")
					.map(entry => ({ provider: entry.provider, model: entry.model }));
			}
			const lane = laneOf(node, definition);
			const provider = node.config?.provider ?? lane?.adapter ?? "";
			const model = node.config?.model ?? lane?.model ?? "";
			if (!provider || !model || model === "host-default") return [];
			return [{ provider, model }];
		}

		function modelTextOf(node, definition) {
			if (node.type !== "agent") return "";
			const models = selectedModelsOf(node, definition);
			if (models.length === 0) return "宿主默认";
			return models.length > 1 ? `${models[0].model} +${models.length - 1}` : models[0].model;
		}

		function modelKey(provider, model) {
			return `${provider}\u0000${model}`;
		}

		function clipText(text, maxWidth, charWidth = 5.8, wideWidth = 10.5) {
			let out = "";
			let width = 0;
			for (const char of String(text ?? "")) {
				const step = /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? wideWidth : charWidth;
				if (width + step > maxWidth) return `${out}…`;
				out += char;
				width += step;
			}
			return out;
		}

		/** Lay out the v2 node graph; back edges route around the side. */
		function buildGraph(definition) {
			const nodes = definition.nodes ?? [];
			const edges = definition.edges ?? [];
			const byId = new Map(nodes.map(node => [node.id, node]));
			const entry = definition.entry ?? nodes[0]?.id;
			const rank = new Map();
			const visit = (id, depth, path) => {
				if (path.has(id) || (rank.get(id) ?? -1) >= depth) return;
				rank.set(id, depth);
				const nextPath = new Set(path);
				nextPath.add(id);
				for (const edge of edges.filter(candidate => candidate.from === id)) {
					if (byId.has(edge.to)) visit(edge.to, depth + 1, nextPath);
				}
			};
			if (entry && byId.has(entry)) visit(entry, 0, new Set());
			let maxRank = 0;
			for (const node of nodes) {
				if (!rank.has(node.id)) rank.set(node.id, maxRank + 1);
				maxRank = Math.max(maxRank, rank.get(node.id));
			}
			const groups = new Map();
			for (const node of nodes) {
				const value = rank.get(node.id);
				if (!groups.has(value)) groups.set(value, []);
				groups.get(value).push(node);
			}
			const nodeW = 132;
			const nodeH = 64;
			const gap = 16;
			const rowH = 88;
			const padY = 12;
			const rowWidth = Math.max(0, ...[...groups.values()].map(list => list.length * nodeW + (list.length - 1) * gap));
			const width = Math.max(360, rowWidth + 64);
			const height = padY * 2 + (maxRank + 1) * rowH;
			const position = new Map();
			for (const [value, list] of groups) {
				const total = list.length * nodeW + (list.length - 1) * gap;
				let x = (width - total) / 2;
				for (const node of list) {
					position.set(node.id, { x, y: padY + value * rowH, w: nodeW, h: nodeH });
					x += nodeW + gap;
				}
			}
			const renderedEdges = [];
			for (const edge of edges) {
				const from = position.get(edge.from);
				const to = position.get(edge.to);
				if (!from || !to) continue;
				const back = (rank.get(edge.to) ?? 0) <= (rank.get(edge.from) ?? 0);
				if (!back) {
					const sx = from.x + from.w / 2;
					const sy = from.y + from.h;
					const tx = to.x + to.w / 2;
					const ty = to.y;
					const my = (sy + ty) / 2;
					renderedEdges.push({ d: `M${sx} ${sy} C${sx} ${my} ${tx} ${my} ${tx} ${ty - 1}`, lx: (sx + tx) / 2, ly: my, label: edge.on ?? "complete" });
				} else {
					const sx = from.x + from.w;
					const sy = from.y + from.h / 2;
					const tx = to.x + to.w;
					const ty = to.y + to.h / 2;
					const bx = Math.max(sx, tx) + 26;
					renderedEdges.push({ d: `M${sx} ${sy} C${bx} ${sy} ${bx} ${ty} ${tx + 1} ${ty}`, lx: Math.min(bx, width - 16), ly: (sy + ty) / 2, label: edge.on ?? "complete" });
				}
			}
			return {
				width,
				height,
				edges: renderedEdges,
				nodes: nodes.map(node => ({ id: node.id, title: node.title ?? node.id, type: node.type, role: node.role ?? "", entry: node.id === entry, ...position.get(node.id) })),
			};
		}

		const TYPE_COLOR = {
			agent: "var(--dsw-alias-brand-primary,#4f7cff)",
			command: "var(--dsw-alias-state-warn-label,#b06b12)",
			http: "#3b82f6",
			human: "#8b5cf6",
			fanout: "#64748b",
			join: "#0f766e",
			subworkflow: "var(--dsw-alias-state-success-primary,#2f8a55)",
		};

		function WorkflowGraph({ definition, tokens, onSelect }) {
			const graph = buildGraph(definition);
			const hostRef = useRef(null);
			const [box, setBox] = useState({ width: 0, height: 0 });
			useEffect(() => {
				const element = hostRef.current;
				if (!element) return undefined;
				const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
				measure();
				if (typeof ResizeObserver === "function") {
					const observer = new ResizeObserver(measure);
					observer.observe(element);
					return () => observer.disconnect();
				}
				window.addEventListener("resize", measure);
				return () => window.removeEventListener("resize", measure);
			}, [graph.width, graph.height]);
			const scale = box.width > 0 && box.height > 0
				? Math.max(0.55, Math.min(1.2, box.width / graph.width, box.height / graph.height))
				: 1;
			const latest = latestByNode(tokens);
			const counts = new Map();
			for (const token of tokens ?? []) counts.set(token.nodeId, (counts.get(token.nodeId) ?? 0) + 1);
			const nodesById = new Map(definition.nodes.map(node => [node.id, node]));
			return h("div", { className: "atw-graph-wrap", ref: hostRef },
				h("svg", {
					className: "atw-graph-svg",
					viewBox: `0 0 ${graph.width} ${graph.height}`,
					width: Math.round(graph.width * scale),
					height: Math.round(graph.height * scale),
					style: { width: Math.round(graph.width * scale), height: Math.round(graph.height * scale), maxWidth: "100%" },
					preserveAspectRatio: "xMidYMin meet",
					role: "img",
					"aria-label": "workflow graph",
				},
					h("defs", {}, h("marker", { id: "atw-arrow", viewBox: "0 0 6 6", refX: 5, refY: 3, markerWidth: 6, markerHeight: 6, orient: "auto" },
						h("path", { d: "M0 0 L6 3 L0 6 z", fill: "var(--dsw-alias-border-l3,#b8bec8)" }))),
					...graph.edges.map((edge, index) => h("g", { key: `e-${index}` },
						h("path", { d: edge.d, fill: "none", stroke: "var(--dsw-alias-border-l3,#b8bec8)", strokeWidth: 0.9, strokeLinecap: "round", markerEnd: "url(#atw-arrow)", opacity: 0.9 }),
						edge.label === "complete" ? null : h("g", {},
							h("rect", { x: edge.lx - Math.max(18, edge.label.length * 4.8 + 8) / 2, y: edge.ly - 6, width: Math.max(18, edge.label.length * 4.8 + 8), height: 12, rx: 6, className: "atw-edge-pill" }),
							h("text", { x: edge.lx, y: edge.ly + 3, textAnchor: "middle", className: "atw-edge-label" }, edge.label),
						),
					)),
					...graph.nodes.map(node => {
						const token = latest.get(node.id);
						const definitionNode = nodesById.get(node.id);
						const tone = tokenTone(token?.status);
						return h("g", {
							key: node.id,
							className: "atw-graph-node",
							role: "button",
							tabIndex: 0,
							"aria-label": `${node.title}，${NODE_TYPE[node.type] ?? node.type}`,
							onClick: () => onSelect(node.id),
							onKeyDown: event => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onSelect(node.id);
								}
							},
						},
							h("rect", { x: node.x, y: node.y, width: node.w, height: node.h, rx: 8, className: `atw-graph-box ${tone}` }),
							h("rect", { x: node.x, y: node.y + 8, width: 3, height: node.h - 16, rx: 1.5, fill: TYPE_COLOR[node.type] ?? "var(--dsw-alias-border-l3,#b8bec8)" }),
							h("circle", { cx: node.x + 12, cy: node.y + 12, r: 3, className: "atw-graph-dot", fill: tone === "error" ? "var(--dsw-alias-state-error-primary,#c53b3b)" : tone === "wait" ? "var(--dsw-alias-state-warn-label,#b06b12)" : tone === "done" ? "var(--dsw-alias-state-success-primary,#2f8a55)" : tone === "active" ? "var(--dsw-alias-brand-primary,#4f7cff)" : "var(--dsw-alias-border-l3,#b8bec8)" }),
							h("text", { x: node.x + 19, y: node.y + 18, className: "atw-graph-title" }, clipText(node.title, 80, 6.2, 10.8)),
							h("text", { x: node.x + 12, y: node.y + 34, className: "atw-graph-sub" }, `${NODE_TYPE[node.type] ?? node.type}${node.role ? ` · ${clipText(node.role, 54, 5, 9)}` : ""}`),
							definitionNode?.type === "agent" ? h("text", { x: node.x + 12, y: node.y + 49, className: "atw-graph-model" }, clipText(modelTextOf(definitionNode, definition), 84, 5, 9)) : null,
							(counts.get(node.id) ?? 0) > 0 ? h("g", {},
								h("circle", { cx: node.x + node.w - 13, cy: node.y + 12, r: 8, className: "atw-graph-count" }),
								h("text", { x: node.x + node.w - 13, y: node.y + 15, textAnchor: "middle", className: "atw-graph-count-text" }, String(counts.get(node.id))),
							) : null,
							node.entry ? h("circle", { cx: node.x + node.w - 5, cy: node.y + node.h - 5, r: 2.2, fill: "var(--dsw-alias-brand-primary,#4f7cff)" }) : null,
						);
					}),
				),
			);
		}

		function ModelPicker({ node, definition, catalog, catalogError, busy, onChange }) {
			const selected = selectedModelsOf(node, definition);
			const [pending, setPending] = useState("");
			const available = [];
			for (const provider of catalog?.providers ?? []) {
				for (const model of provider.models ?? []) {
					available.push({ provider: provider.id, model: model.id, label: `${model.name || model.id} · ${provider.name || provider.id}` });
				}
			}
			const remaining = available.filter(entry => !selected.some(item => item.provider === entry.provider && item.model === entry.model));
			const add = () => {
				const separator = pending.indexOf("\u0000");
				if (separator < 0) return;
				const provider = pending.slice(0, separator);
				const model = pending.slice(separator + 1);
				if (!provider || !model) return;
				onChange([...selected, { provider, model }]);
				setPending("");
			};
			const remove = index => onChange(selected.filter((_item, current) => current !== index));
			const move = (index, delta) => {
				const next = [...selected];
				const target = index + delta;
				if (target < 0 || target >= next.length) return;
				[next[index], next[target]] = [next[target], next[index]];
				onChange(next);
			};
			return h("div", { className: "atw-models" },
				h("div", { className: "atw-models-head" },
					h("span", {}, "模型"),
					h("em", {}, selected.length === 0 ? "宿主默认" : `${selected.length} 个，按顺序 fallback`),
				),
				...selected.map((item, index) => h("div", { className: "atw-model-row", key: `${item.provider}\u0000${item.model}\u0000${index}` },
					h("span", { className: "atw-model-index" }, String(index + 1)),
					h("span", { className: "atw-model-name", title: `${item.provider} / ${item.model}` }, `${item.provider} / ${item.model}`),
					h("button", { className: "atw-mini", type: "button", disabled: busy || index === 0, title: "上移", onClick: () => move(index, -1) }, "↑"),
					h("button", { className: "atw-mini", type: "button", disabled: busy || index === selected.length - 1, title: "下移", onClick: () => move(index, 1) }, "↓"),
					h("button", { className: "atw-mini danger", type: "button", disabled: busy, title: "移除", onClick: () => remove(index) }, "×"),
				)),
				h("div", { className: "atw-model-add" },
					h("select", {
						className: "atw-model-select",
						value: pending,
						disabled: busy || catalog === null || remaining.length === 0,
						"aria-label": "添加模型",
						onChange: event => setPending(event.currentTarget.value),
					},
						h("option", { value: "" }, remaining.length === 0 ? "没有更多模型" : "添加模型…"),
						...remaining.map(entry => h("option", { key: `${entry.provider}\u0000${entry.model}`, value: `${entry.provider}\u0000${entry.model}` }, entry.label)),
					),
					h("button", { className: "atw-btn", type: "button", disabled: busy || pending === "", onClick: add }, "添加"),
					catalog === null ? h("em", {}, catalogError ? "列表不可用" : "加载中") : null,
				),
			);
		}

		function Sheet({ title, onClose, children, footer }) {
			return h("div", { className: "atw-sheet-backdrop", onClick: event => { if (event.target === event.currentTarget) onClose(); } },
				h("section", { className: "atw-sheet", role: "dialog", "aria-label": title },
					h("header", { className: "atw-sheet-head" },
						h("strong", {}, title),
						h("button", { className: "atw-icon-btn", type: "button", "aria-label": "关闭", onClick: onClose }, "×"),
					),
					h("div", { className: "atw-sheet-body" }, children),
					footer ? h("footer", { className: "atw-sheet-foot" }, footer) : null,
				),
			);
		}

		function NodeSheet({ node, token, definition, catalog, catalogError, busy, onChangeModels, onClose }) {
			const model = node.type === "agent" ? h(ModelPicker, { node, definition, catalog, catalogError, busy, onChange: onChangeModels }) : null;
			return h(Sheet, { title: node.title ?? node.id, onClose },
				h("dl", { className: "atw-kv" },
					h("dt", {}, "类型"), h("dd", {}, NODE_TYPE[node.type] ?? node.type),
					node.role ? h("dt", {}, "角色") : null,
					node.role ? h("dd", {}, node.role) : null,
					token ? h("dt", {}, "状态") : null,
					token ? h("dd", {}, TOKEN_STATUS[token.status] ?? token.status) : null,
					token?.model ? h("dt", {}, "使用模型") : null,
					token?.model ? h("dd", {}, [token.model.provider, token.model.model].filter(Boolean).join(" / ") || "宿主默认") : null,
					token?.outcome ? h("dt", {}, "结果") : null,
					token?.outcome ? h("dd", {}, token.outcome) : null,
					token?.error ? h("dt", {}, "错误") : null,
					token?.error ? h("dd", {}, `${token.error.code}: ${token.error.message}`) : null,
				),
				model,
				token?.output === null || token?.output === undefined ? null : h("details", { open: true },
					h("summary", { style: { cursor: "pointer", color: "var(--dsw-alias-label-tertiary,#8a929e)", fontSize: "10px" } }, "输出"),
					h("pre", { className: "atw-pre", style: { marginTop: "4px" } }, JSON.stringify(token.output, null, 2)),
				),
				h("details", {},
					h("summary", { style: { cursor: "pointer", color: "var(--dsw-alias-label-tertiary,#8a929e)", fontSize: "10px" } }, "配置"),
					h("pre", { className: "atw-pre", style: { marginTop: "4px" } }, JSON.stringify({ type: node.type, role: node.role, config: node.config, inputs: node.inputs }, null, 2)),
				),
			);
		}

		function RunSheet({ run, onClose }) {
			if (!run) return null;
			const tokens = [...(run.tokens ?? [])].reverse();
			return h(Sheet, { title: "运行详情", onClose },
				h("dl", { className: "atw-kv" },
					h("dt", {}, "状态"), h("dd", {}, RUN_STATUS[run.status] ?? run.status),
					h("dt", {}, "Run"), h("dd", {}, run.runId),
					run.error ? h("dt", {}, "错误") : null,
					run.error ? h("dd", {}, run.error) : null,
				),
				tokens.length === 0 ? null : h("div", { className: "atw-token-list" },
					...tokens.map(token => h("div", { className: "atw-token", key: token.id },
						h("strong", {}, token.nodeId),
						h("span", {}, token.outcome ?? token.status),
						h("b", { className: token.status === "completed" ? "done" : token.status === "failed" ? "error" : token.status === "waiting" ? "wait" : "" }, TOKEN_STATUS[token.status] ?? token.status),
					)),
				),
				h("details", {},
					h("summary", { style: { cursor: "pointer", color: "var(--dsw-alias-label-tertiary,#8a929e)", fontSize: "10px" } }, "上下文"),
					h("pre", { className: "atw-pre", style: { marginTop: "4px" } }, JSON.stringify(run.context, null, 2)),
				),
			);
		}

		function StartSheet({ inputText, busy, onInput, onStart, onClose }) {
			return h(Sheet, { title: "新运行", onClose },
				h("textarea", {
					className: "atw-pre",
					style: { minHeight: "86px", resize: "vertical", width: "100%", boxSizing: "border-box", font: "inherit", fontSize: "10.5px" },
					value: inputText,
					"aria-label": "初始输入 JSON",
					onChange: event => onInput(event.currentTarget.value),
				}),
				h("div", { style: { display: "flex", justifyContent: "flex-end" } },
					h("button", { className: "atw-btn atw-primary", type: "button", disabled: busy, onClick: onStart }, busy ? "启动中…" : "启动"),
				),
			);
		}

		function WorkflowPanel({ sessionId }) {
			const [view, setView] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);
			const [selected, setSelected] = useState(null);
			const [sheet, setSheet] = useState(null);
			const [inputText, setInputText] = useState("{}");
			const [catalog, setCatalog] = useState(null);
			const [catalogError, setCatalogError] = useState("");
			const [toast, setToast] = useState(null);
			const alive = useRef(true);

			const load = useCallback(async () => {
				if (!sessionId) return;
				try {
					const result = await getJson(`${API}/state?session=${encodeURIComponent(sessionId)}`);
					if (!alive.current) return;
					setView(result);
					setError("");
				} catch (cause) {
					if (alive.current) setError(cause.message);
				}
			}, [sessionId]);

			useEffect(() => {
				alive.current = true;
				if (!sessionId) return undefined;
				load();
				getJson(`${API}/models?session=${encodeURIComponent(sessionId)}`)
					.then(result => { if (alive.current) setCatalog(result); })
					.catch(cause => { if (alive.current) setCatalogError(cause.message); });
				const timer = setInterval(() => {
					if (!document.hidden) load();
				}, 4000);
				return () => {
					alive.current = false;
					clearInterval(timer);
				};
			}, [sessionId, load]);

			useEffect(() => {
				if (!toast) return undefined;
				const timer = setTimeout(() => setToast(null), 2600);
				return () => clearTimeout(timer);
			}, [toast]);

			const call = async (path, body) => {
				setBusy(true);
				try {
					const result = await postJson(API + path, { session: sessionId, ...body });
					if (alive.current) setView(result);
					return result;
				} finally {
					setBusy(false);
				}
			};

			const startRun = async () => {
				let input;
				try {
					input = inputText.trim() === "" ? {} : JSON.parse(inputText);
				} catch (cause) {
					setToast({ tone: "error", text: `输入不是 JSON: ${cause.message}` });
					return;
				}
				if (input === null || typeof input !== "object" || Array.isArray(input)) {
					setToast({ tone: "error", text: "输入必须是 JSON 对象" });
					return;
				}
				try {
					const started = await call("/start", { input });
					setSheet(null);
					setToast({ tone: "ok", text: "已启动" });
					if (started?.run?.runId) await call("/run", { runId: started.run.runId });
				} catch (cause) {
					setToast({ tone: "error", text: cause.message });
				}
			};

			const runMore = async () => {
				if (!view?.run?.runId) return;
				try {
					await call("/run", { runId: view.run.runId });
				} catch (cause) {
					setToast({ tone: "error", text: cause.message });
				}
			};

			const decide = async (token, outcome) => {
				if (!view?.run?.runId) return;
				try {
					await call("/decide", { runId: view.run.runId, tokenId: token.tokenId, outcome });
					setToast({ tone: "ok", text: `已记录 ${outcome}` });
					await call("/run", { runId: view.run.runId });
				} catch (cause) {
					setToast({ tone: "error", text: cause.message });
				}
			};

			const changeModels = async models => {
				if (!selected) return;
				try {
					const result = await call("/node-model", {
						runId: view?.run?.runId,
						nodeId: selected,
						models,
					});
					if (Array.isArray(result.models?.providers)) setCatalog(result.models);
					setToast({ tone: "ok", text: models.length === 0 ? "已改用宿主默认" : `已保存 ${models.length} 个 fallback 模型` });
				} catch (cause) {
					setToast({ tone: "error", text: cause.message });
				}
			};

			if (!sessionId) {
				return h("div", { className: "atw-panel" }, h("div", { className: "atw-empty" },
					h("span", { className: "atw-empty-mark" }, "◇"), h("strong", {}, TITLE), h("span", {}, "当前面板没有绑定会话。")));
			}
			if (error && !view) {
				return h("div", { className: "atw-panel" }, h("div", { className: "atw-empty" },
					h("span", { className: "atw-empty-mark" }, "⚠"), h("strong", {}, "载入失败"), h("span", {}, error),
					h("button", { className: "atw-btn", type: "button", onClick: load }, "重试")));
			}
			if (!view) {
				return h("div", { className: "atw-panel" }, h("div", { className: "atw-empty" }, h("span", { className: "atw-spinner" }), h("span", {}, "正在读取工作流…")));
			}
			if (!view.defined) {
				return h("div", { className: "atw-panel" }, h("div", { className: "atw-empty" },
					h("span", { className: "atw-empty-mark" }, "◇"), h("strong", {}, "这个会话还没有工作流"),
					h("span", {}, "让助手通过工具创建工作流。")));
			}

			const definition = view.definition;
			const run = view.run;
			const waiting = run?.waiting ?? [];
			const tokens = run?.tokens ?? [];
			const latest = latestByNode(tokens);
			const selectedNode = definition.nodes.find(node => node.id === selected) ?? null;
			const selectedToken = selected ? latest.get(selected) ?? null : null;
			const permissions = view.permissions ?? {};
			const permissionText = section => {
				const value = permissions[section] ?? { mode: "deny" };
				if (value.mode === "full") return "完整";
				if (value.mode === "allowlist") return "列表";
				return "关闭";
			};
			const permissionOn = section => (permissions[section]?.mode ?? "deny") !== "deny";
			const statusClass = run ? (RUN_STATUS[run.status] ? run.status : "") : "";

			const top = h("header", { className: "atw-top" },
				h("div", { className: "atw-top-main" },
					h("span", { className: "atw-mark" }, initialOf(definition.name)),
					h("div", { className: "atw-copy" },
						h("div", { className: "atw-name-row" },
							h("strong", { className: "atw-name", title: definition.name }, definition.name),
							h("span", { className: `atw-status ${statusClass}` }, run ? (RUN_STATUS[run.status] ?? run.status) : "未运行"),
						),
						h("span", { className: "atw-sub" }, `${definition.nodes.length} 节点 · ${definition.edges.length} 边${run?.createdAt ? ` · ${timeAgo(run.createdAt)}` : ""}`),
					),
					h("button", { className: "atw-icon-btn", type: "button", title: "刷新", "aria-label": "刷新", onClick: load }, "↻"),
				),
				h("div", { className: "atw-permissions" },
					h("span", { className: `atw-perm ${permissionOn("command") ? "on" : ""}` }, `命令 ${permissionText("command")}`),
					h("span", { className: `atw-perm ${permissionOn("http") ? "on" : ""}` }, `HTTP ${permissionText("http")}`),
				),
			);

			const stage = h("div", { className: "atw-stage" },
				h(WorkflowGraph, { definition, tokens, onSelect: id => { setSelected(id); setSheet("node"); } }),
			);

			const waitingBox = waiting.length === 0 ? null : h("section", { className: "atw-waiting" },
				h("div", { className: "atw-waiting-head" }, h("i", {}), `${waiting.length} 个待决策`),
				...waiting.map(token => h("div", { className: "atw-decision", key: token.tokenId },
					h("span", { title: `${token.nodeId} · ${token.title}` }, `${token.title} · ${token.nodeId}`),
					...token.outcomes.map(outcome => h("button", {
						key: outcome,
						className: `atw-btn ${outcome === "reject" ? "atw-danger" : "atw-primary"}`,
						type: "button",
						disabled: busy,
						onClick: () => decide(token, outcome),
					}, outcome)),
				)),
			);

			const bottom = h("div", { className: "atw-bottom" },
				h("button", { className: "atw-btn", type: "button", disabled: !run, onClick: () => setSheet("run") }, "运行详情"),
				h("div", { className: "atw-bottom-right" },
					h("button", { className: "atw-btn", type: "button", disabled: busy, onClick: () => setSheet("start") }, "新运行"),
					run && run.status !== "done" && run.status !== "failed"
						? h("button", { className: "atw-btn atw-primary", type: "button", disabled: busy, onClick: runMore }, busy ? "处理中…" : "继续运行")
						: null,
				),
			);

			const sheetView = sheet === "node" && selectedNode
				? h(NodeSheet, { node: selectedNode, token: selectedToken, definition, catalog, catalogError, busy, onChangeModels: changeModels, onClose: () => setSheet(null) })
				: sheet === "run" && run
					? h(RunSheet, { run, onClose: () => setSheet(null) })
					: sheet === "start"
						? h(StartSheet, { inputText, busy, onInput: setInputText, onStart: startRun, onClose: () => setSheet(null) })
						: null;

			return h("div", { className: "atw-panel" },
				top,
				stage,
				waitingBox,
				bottom,
				sheetView,
				toast === null ? null : h("div", { className: `atw-toast ${toast.tone}`, role: "status", "aria-live": "polite" }, toast.text),
			);
		}

		function OpenButton({ open }) {
			return h("button", { className: "atw-header-btn", type: "button", title: "打开工作流面板", onClick: open }, TITLE);
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
