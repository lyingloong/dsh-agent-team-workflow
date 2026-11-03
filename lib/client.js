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
		const RUN_STATUS = { running: "\u8fd0\u884c\u4e2d", waiting: "\u7b49\u5f85\u51b3\u7b56", done: "\u5df2\u5b8c\u6210", failed: "\u5931\u8d25" };
		const TOKEN_STATUS = { ready: "\u5c31\u7eea", running: "\u6267\u884c\u4e2d", waiting: "\u7b49\u5f85", completed: "\u5df2\u5b8c\u6210", failed: "\u5931\u8d25" };
		const NODE_TYPE = {
			agent: "\u6a21\u578b",
			command: "\u547d\u4ee4",
			http: "HTTP",
			human: "\u4eba\u5de5",
			fanout: "\u6247\u51fa",
			join: "\u805a\u5408",
			subworkflow: "\u5b50\u6d41\u7a0b",
		};
		const TYPE_INITIAL = { agent: "A", command: "C", http: "H", human: "P", fanout: "F", join: "J", subworkflow: "S" };

		const CSS = `
.atw-panel { display:flex; flex-direction:column; gap:8px; height:100%; min-height:0; padding:10px; box-sizing:border-box; overflow:hidden; color:var(--dsw-alias-label-primary,#1c2128); font-family:var(--dsw-font-family,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif); font-size:13px; line-height:1.45; background:var(--dsw-alias-bg-base,transparent); }
.atw-hero { flex:none; padding:11px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:var(--dsw-radius-lg,10px); background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 7%,transparent),transparent 68%),var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05)); }
.atw-hero-top { display:flex; align-items:flex-start; gap:9px; min-width:0; }
.atw-mark { width:34px; height:34px; flex:none; display:inline-flex; align-items:center; justify-content:center; border-radius:10px; color:var(--dsw-alias-brand-primary,#4f7cff); background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 13%,transparent); border:0.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 26%,transparent); font-size:15px; font-weight:650; }
.atw-hero-copy { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
.atw-title-row { display:flex; align-items:center; gap:6px; min-width:0; }
.atw-name { flex:1; min-width:0; font-size:14px; font-weight:620; letter-spacing:.1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.atw-subtitle { color:var(--dsw-alias-label-tertiary,#8a929e); font-size:11.5px; overflow-wrap:anywhere; }
.atw-icon-btn { flex:none; display:inline-flex; align-items:center; justify-content:center; width:27px; height:27px; font:inherit; font-size:14px; color:var(--dsw-alias-label-tertiary,#8a929e); background:transparent; border:0.5px solid transparent; border-radius:var(--dsw-radius-sm,6px); cursor:pointer; }
.atw-icon-btn:hover { color:var(--dsw-alias-label-primary,#1c2128); background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); border-color:var(--dsw-alias-border-l1,rgba(127,127,127,.22)); }
.atw-icon-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f7cff); outline-offset:1px; }
.atw-live-line { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:8px; color:var(--dsw-alias-label-tertiary,#8a929e); font-size:10.5px; }
.atw-live { display:inline-flex; align-items:center; gap:5px; color:var(--dsw-alias-state-success-primary,#2f8a55); font-weight:550; }
.atw-live i { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary,#2f8a55); box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f8a55) 16%,transparent); }
.atw-live.waiting { color:var(--dsw-alias-state-warn-label,#b06b12); }
.atw-live.waiting i { background:var(--dsw-alias-state-warn-label,#b06b12); box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-label,#b06b12) 16%,transparent); }
.atw-live.failed { color:var(--dsw-alias-state-error-primary,#c53b3b); }
.atw-live.failed i { background:var(--dsw-alias-state-error-primary,#c53b3b); }
.atw-stats { display:flex; flex-wrap:wrap; gap:5px; margin-top:8px; }
.atw-stat { display:inline-flex; align-items:baseline; gap:4px; padding:2px 7px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:999px; background:var(--dsw-alias-bg-base,rgba(255,255,255,.35)); color:var(--dsw-alias-label-tertiary,#8a929e); font-size:10.5px; white-space:nowrap; }
.atw-stat b { color:var(--dsw-alias-label-primary,#1c2128); font-size:11.5px; font-weight:600; font-variant-numeric:tabular-nums; }
.atw-stat.warn b { color:var(--dsw-alias-state-warn-label,#b06b12); }
.atw-stat.done b { color:var(--dsw-alias-state-success-primary,#2f8a55); }
.atw-stat.error b { color:var(--dsw-alias-state-error-primary,#c53b3b); }
.atw-permissions { display:flex; flex-wrap:wrap; gap:5px; margin-top:7px; }
.atw-permission { padding:1px 6px; border-radius:999px; background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08)); color:var(--dsw-alias-label-tertiary,#8a929e); font-size:9.5px; }
.atw-permission.granted { color:var(--dsw-alias-state-success-primary,#2f8a55); }
.atw-graph-card { flex:none; padding:8px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:var(--dsw-radius-md,8px); background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05)); }
.atw-graph-head { display:flex; align-items:center; gap:6px; }
.atw-graph-kicker { font-size:12px; font-weight:600; }
.atw-link-btn { margin-left:auto; font:inherit; font-size:10.5px; color:var(--dsw-alias-label-tertiary,#8a929e); background:transparent; border:0; border-radius:4px; padding:1px 4px; cursor:pointer; }
.atw-link-btn:hover { color:var(--dsw-alias-brand-primary,#4f7cff); background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); }
.atw-link-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f7cff); outline-offset:1px; }
.atw-graph-svg { display:block; width:auto; max-width:100%; height:auto; overflow:visible; margin:2px auto 0; }
.atw-graph-box { fill:var(--dsw-alias-bg-base,#fff); stroke:var(--dsw-alias-border-l2,rgba(127,127,127,.3)); stroke-width:.8; transition:stroke .15s ease,fill .15s ease; }
.atw-graph-box.active { stroke:var(--dsw-alias-brand-primary,#4f7cff); }
.atw-graph-box.wait { stroke:var(--dsw-alias-state-warn-label,#b06b12); }
.atw-graph-box.done { stroke:var(--dsw-alias-state-success-primary,#2f8a55); }
.atw-graph-box.error { stroke:var(--dsw-alias-state-error-primary,#c53b3b); }
.atw-graph-box.selected { stroke-width:1.7; }
.atw-graph-node { cursor:pointer; }
.atw-graph-node:hover .atw-graph-box { fill:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); }
.atw-graph-node:focus-visible .atw-graph-box { stroke-width:1.7; stroke:var(--dsw-alias-brand-primary,#4f7cff); }
.atw-graph-title { font-size:10.5px; font-weight:600; fill:var(--dsw-alias-label-primary,#1c2128); }
.atw-graph-role { font-size:8.5px; fill:var(--dsw-alias-label-tertiary,#8a929e); }
.atw-graph-count { fill:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08)); }
.atw-graph-count-text { font-size:8.5px; fill:var(--dsw-alias-label-secondary,#5f6874); font-variant-numeric:tabular-nums; }
.atw-edge-pill { fill:var(--dsw-alias-bg-base,#fff); stroke:var(--dsw-alias-border-l1,rgba(127,127,127,.22)); stroke-width:.5; }
.atw-edge-label { font-size:8.5px; fill:var(--dsw-alias-label-tertiary,#8a929e); }
.atw-executor { flex:none; padding:0 5px; border-radius:999px; color:var(--dsw-alias-label-secondary,#5f6874); background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08)); font-size:9.5px; line-height:16px; }
.atw-banner { flex:none; padding:8px; border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-warn-label,#b06b12) 38%,transparent); border-radius:var(--dsw-radius-md,8px); background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#b06b12) 6%,transparent); }
.atw-banner-title { display:flex; align-items:center; gap:5px; margin-bottom:5px; color:var(--dsw-alias-state-warn-label,#b06b12); font-size:11.5px; font-weight:560; }
.atw-banner-title i { width:6px; height:6px; border-radius:50%; background:currentColor; }
.atw-decision { display:flex; align-items:center; gap:5px; padding:2px 0; min-width:0; }
.atw-decision span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
.atw-btn { flex:none; font:inherit; font-size:11px; line-height:1.3; color:var(--dsw-alias-label-secondary,#5f6874); background:var(--dsw-alias-bg-base,transparent); border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3)); border-radius:var(--dsw-radius-sm,6px); padding:3px 8px; cursor:pointer; white-space:nowrap; }
.atw-btn:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); }
.atw-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f7cff); outline-offset:1px; }
.atw-btn[disabled] { opacity:.5; cursor:default; }
.atw-btn.atw-primary { color:var(--dsw-alias-label-primary-foreground,#fff); background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f7cff)); border-color:transparent; }
.atw-btn.atw-danger { color:var(--dsw-alias-state-error-primary,#c53b3b); border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c53b3b) 42%,transparent); }
.atw-section { flex:none; padding:8px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:var(--dsw-radius-md,8px); background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04)); }
.atw-section-head { display:flex; align-items:center; gap:6px; min-width:0; }
.atw-section-head strong { font-size:12px; font-weight:600; }
.atw-chip { flex:none; padding:0 6px; border-radius:999px; border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3)); color:var(--dsw-alias-label-tertiary,#8a929e); font-size:10px; line-height:16px; white-space:nowrap; }
.atw-chip.active { color:var(--dsw-alias-brand-primary,#4f7cff); border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 42%,transparent); }
.atw-chip.wait { color:var(--dsw-alias-state-warn-label,#b06b12); border-color:color-mix(in srgb,var(--dsw-alias-state-warn-label,#b06b12) 42%,transparent); }
.atw-chip.done { color:var(--dsw-alias-state-success-primary,#2f8a55); border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f8a55) 42%,transparent); }
.atw-chip.error { color:var(--dsw-alias-state-error-primary,#c53b3b); border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c53b3b) 42%,transparent); }
.atw-kv { display:grid; grid-template-columns:auto minmax(0,1fr); gap:3px 8px; margin:5px 0 0; font-size:10.5px; }
.atw-kv dt { color:var(--dsw-alias-label-tertiary,#8a929e); white-space:nowrap; }
.atw-kv dd { margin:0; color:var(--dsw-alias-label-secondary,#5f6874); overflow-wrap:anywhere; }
.atw-pre { margin:5px 0 0; padding:6px; max-height:170px; overflow:auto; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:4px; background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06)); font-size:10px; white-space:pre-wrap; overflow-wrap:anywhere; }
.atw-detail { margin:0; }
.atw-detail summary { cursor:pointer; color:var(--dsw-alias-label-tertiary,#8a929e); font-size:10.5px; user-select:none; }
.atw-detail summary:hover { color:var(--dsw-alias-label-secondary,#5f6874); }
.atw-list { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:8px; padding:1px 2px 4px 0; }
.atw-token { display:flex; align-items:center; gap:6px; padding:4px 6px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); border-radius:var(--dsw-radius-sm,6px); background:var(--dsw-alias-bg-base,#fff); font-size:10.5px; }
.atw-token strong { font-size:11px; font-weight:550; }
.atw-token .atw-token-id { color:var(--dsw-alias-label-tertiary,#8a929e); font-size:9.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.atw-token .atw-chip { margin-left:auto; }
.atw-compose { display:flex; flex-direction:column; gap:6px; }
.atw-textarea { width:100%; min-height:54px; resize:vertical; box-sizing:border-box; font:inherit; font-size:11px; color:var(--dsw-alias-label-primary,#1c2128); background:var(--dsw-alias-bg-base,transparent); border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3)); border-radius:var(--dsw-radius-sm,6px); padding:5px 7px; }
.atw-textarea:focus { outline:2px solid var(--dsw-alias-brand-primary,#4f7cff); outline-offset:-1px; }
.atw-actions { display:flex; flex-wrap:wrap; gap:6px; }
.atw-toast { display:flex; align-items:center; gap:6px; padding:6px 9px; border-radius:var(--dsw-radius-sm,6px); font-size:11px; border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22)); background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05)); }
.atw-toast.ok { color:var(--dsw-alias-state-success-primary,#2f8a55); }
.atw-toast.error { color:var(--dsw-alias-state-error-primary,#c53b3b); }
.atw-inline-error { display:flex; align-items:center; gap:6px; padding:6px 8px; border:0.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#c53b3b) 32%,transparent); border-radius:var(--dsw-radius-sm,6px); color:var(--dsw-alias-state-error-primary,#c53b3b); font-size:11px; }
.atw-inline-error span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.atw-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px; flex:1; min-height:130px; padding:20px; text-align:center; color:var(--dsw-alias-label-tertiary,#8a929e); font-size:12px; }
.atw-empty-mark { width:42px; height:42px; border-radius:12px; display:inline-flex; align-items:center; justify-content:center; color:var(--dsw-alias-brand-primary,#4f7cff); background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 12%,transparent); font-size:18px; }
.atw-empty strong { color:var(--dsw-alias-label-secondary,#5f6874); font-size:12.5px; font-weight:550; }
.atw-spinner { width:18px; height:18px; border-radius:50%; border:2px solid var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16)); border-top-color:var(--dsw-alias-brand-primary,#4f7cff); animation:atw-spin .8s linear infinite; }
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
			if (seconds < 45) return "\u521a\u521a";
			if (seconds < 3600) return `${Math.floor(seconds / 60)} \u5206\u949f\u524d`;
			if (seconds < 86400) return `${Math.floor(seconds / 3600)} \u5c0f\u65f6\u524d`;
			return `${Math.floor(seconds / 86400)} \u5929\u524d`;
		}

		function durationSince(value) {
			const parsed = Date.parse(value ?? "");
			if (!Number.isFinite(parsed)) return "";
			const minutes = Math.max(0, Math.floor((Date.now() - parsed) / 60000));
			if (minutes < 60) return `${minutes} \u5206\u949f`;
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return `${hours} \u5c0f\u65f6`;
			return `${Math.floor(hours / 24)} \u5929`;
		}

		function detailRows(value) {
			if (value === null || typeof value !== "object") return [];
			if (Array.isArray(value)) return [["\u957f\u5ea6", String(value.length)]];
			const rows = [];
			for (const [key, entry] of Object.entries(value)) {
				if (entry === null || entry === undefined) continue;
				const text = typeof entry === "string" ? entry : JSON.stringify(entry);
				if (text.length <= 240) rows.push([key, text]);
			}
			return rows.slice(0, 8);
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

		function nodeTypeLabel(type) {
			return NODE_TYPE[type] ?? type;
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
			const nodeW = 118;
			const nodeH = 46;
			const gap = 14;
			const rowH = 70;
			const padY = 10;
			const rowWidth = Math.max(0, ...[...groups.values()].map(list => list.length * nodeW + (list.length - 1) * gap));
			const width = Math.max(360, rowWidth + 70);
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
					renderedEdges.push({
						d: `M${sx} ${sy} C${sx} ${my} ${tx} ${my} ${tx} ${ty - 1}`,
						lx: (sx + tx) / 2,
						ly: my,
						label: edge.on ?? "complete",
					});
				} else {
					const sx = from.x + from.w;
					const sy = from.y + from.h / 2;
					const tx = to.x + to.w;
					const ty = to.y + to.h / 2;
					const bx = Math.max(sx, tx) + 24;
					renderedEdges.push({
						d: `M${sx} ${sy} C${bx} ${sy} ${bx} ${ty} ${tx + 1} ${ty}`,
						lx: Math.min(bx, width - 14),
						ly: (sy + ty) / 2,
						label: edge.on ?? "complete",
					});
				}
			}
			return {
				width,
				height,
				edges: renderedEdges,
				nodes: nodes.map(node => ({
					id: node.id,
					title: node.title ?? node.id,
					type: node.type,
					role: node.role ?? "",
					entry: node.id === entry,
					...position.get(node.id),
				})),
			};
		}

		function WorkflowGraph({ definition, tokens, selected, onSelect }) {
			const graph = buildGraph(definition);
			const latest = latestByNode(tokens);
			const counts = new Map();
			for (const token of tokens ?? []) counts.set(token.nodeId, (counts.get(token.nodeId) ?? 0) + 1);
			const clip = text => {
				let out = "";
				let width = 0;
				for (const char of String(text)) {
					const charWidth = /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 10.5 : 5.8;
					if (width + charWidth > 70) return `${out}\u2026`;
					out += char;
					width += charWidth;
				}
				return out;
			};
			return h("section", { className: "atw-graph-card" },
				h("div", { className: "atw-graph-head" },
					h("span", { className: "atw-graph-kicker" }, "\u8282\u70b9\u56fe"),
					h("span", { className: "atw-graph-kicker", style: { marginLeft: "auto", color: "var(--dsw-alias-label-tertiary,#8a929e)", fontWeight: 400, fontSize: "10px" } }, `${definition.nodes.length} \u8282\u70b9 / ${definition.edges.length} \u8fb9`),
				),
				h("svg", {
					className: "atw-graph-svg",
					viewBox: `0 0 ${graph.width} ${graph.height}`,
					width: graph.width,
					height: graph.height,
					style: { width: graph.width, maxWidth: "100%", height: "auto" },
					preserveAspectRatio: "xMidYMin meet",
					role: "img",
					"aria-label": "workflow graph",
				},
					h("defs", {},
						h("marker", { id: "atw-arrow", viewBox: "0 0 6 6", refX: 5, refY: 3, markerWidth: 6, markerHeight: 6, orient: "auto" },
							h("path", { d: "M0 0 L6 3 L0 6 z", fill: "var(--dsw-alias-border-l3,#b8bec8)" })),
					),
					...graph.edges.map((edge, index) => h("g", { key: `e-${index}` },
						h("path", { d: edge.d, fill: "none", stroke: "var(--dsw-alias-border-l3,#b8bec8)", strokeWidth: 0.9, strokeLinecap: "round", markerEnd: "url(#atw-arrow)", opacity: 0.9 }),
						edge.label === "complete" ? null : h("g", {},
							h("rect", {
								x: edge.lx - Math.max(18, edge.label.length * 4.8 + 8) / 2,
								y: edge.ly - 6,
								width: Math.max(18, edge.label.length * 4.8 + 8),
								height: 12,
								rx: 6,
								className: "atw-edge-pill",
							}),
							h("text", { x: edge.lx, y: edge.ly + 3, textAnchor: "middle", className: "atw-edge-label" }, edge.label),
						),
					)),
					...graph.nodes.map(node => {
						const token = latest.get(node.id);
						return h("g", {
							key: node.id,
							className: "atw-graph-node",
							role: "button",
							tabIndex: 0,
							"aria-label": `${node.title}\uff0c${nodeTypeLabel(node.type)}`,
							onClick: () => onSelect(node.id),
							onKeyDown: event => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onSelect(node.id);
								}
							},
						},
							h("rect", {
								x: node.x,
								y: node.y,
								width: node.w,
								height: node.h,
								rx: 8,
								className: `atw-graph-box ${tokenTone(token?.status)}${selected === node.id ? " selected" : ""}`,
							}),
							h("text", { x: node.x + 10, y: node.y + 18, className: "atw-graph-title" }, clip(node.title)),
							h("text", { x: node.x + 10, y: node.y + 32, className: "atw-graph-role" }, `${nodeTypeLabel(node.type)}${node.role ? ` \u00b7 ${clip(node.role)}` : ""}`),
							h("circle", { cx: node.x + node.w - 14, cy: node.y + node.h / 2, r: 9, className: "atw-graph-count" }),
							h("text", { x: node.x + node.w - 14, y: node.y + node.h / 2 + 3, textAnchor: "middle", className: "atw-graph-count-text" }, String(counts.get(node.id) ?? 0)),
							node.entry ? h("circle", { cx: node.x + node.w - 7, cy: node.y + 7, r: 2.5, fill: "var(--dsw-alias-brand-primary,#4f7cff)" }) : null,
						);
					}),
				),
			);
		}

		function WorkflowPanel({ sessionId }) {
			const [view, setView] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);
			const [selected, setSelected] = useState(null);
			const [inputText, setInputText] = useState("{}");
			const [showStart, setShowStart] = useState(false);
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
					setToast({ tone: "error", text: `\u8f93\u5165\u4e0d\u662f JSON: ${cause.message}` });
					return;
				}
				if (input === null || typeof input !== "object" || Array.isArray(input)) {
					setToast({ tone: "error", text: "\u8f93\u5165\u5fc5\u987b\u662f JSON \u5bf9\u8c61" });
					return;
				}
				try {
					const started = await call("/start", { input });
					setShowStart(false);
					setToast({ tone: "ok", text: "\u5df2\u542f\u52a8\u65b0\u8fd0\u884c" });
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
					setToast({ tone: "ok", text: `\u5df2\u8bb0\u5f55 ${outcome}` });
					await call("/run", { runId: view.run.runId });
				} catch (cause) {
					setToast({ tone: "error", text: cause.message });
				}
			};

			if (!sessionId) {
				return h("div", { className: "atw-panel" }, h("div", { className: "atw-empty" },
					h("span", { className: "atw-empty-mark" }, "\u25c7"), h("strong", {}, TITLE), h("span", {}, "\u5f53\u524d\u9762\u677f\u6ca1\u6709\u7ed1\u5b9a\u4f1a\u8bdd\u3002")));
			}
			if (error && !view) {
				return h("div", { className: "atw-panel" }, h("div", { className: "atw-empty" },
					h("span", { className: "atw-empty-mark" }, "\u26a0"), h("strong", {}, "\u8f7d\u5165\u5931\u8d25"), h("span", {}, error),
					h("button", { className: "atw-btn", type: "button", onClick: load }, "\u91cd\u8bd5")));
			}
			if (!view) {
				return h("div", { className: "atw-panel" }, h("div", { className: "atw-empty" }, h("span", { className: "atw-spinner" }), h("span", {}, "\u6b63\u5728\u8bfb\u53d6\u5de5\u4f5c\u6d41\u2026")));
			}
			if (!view.defined) {
				return h("div", { className: "atw-panel" }, h("div", { className: "atw-empty" },
					h("span", { className: "atw-empty-mark" }, "\u25c7"), h("strong", {}, "\u8fd9\u4e2a\u4f1a\u8bdd\u8fd8\u6ca1\u6709\u5de5\u4f5c\u6d41"),
					h("span", {}, "\u5bf9\u52a9\u624b\u8bf4\u201c\u521b\u5efa\u4e00\u4e2a\u81ea\u52a8\u5f00\u53d1\u7684\u5de5\u4f5c\u6d41\u201d\u5373\u53ef\u3002")));
			}

			const definition = view.definition;
			const run = view.run;
			const waiting = run?.waiting ?? [];
			const tokens = run?.tokens ?? [];
			const latest = latestByNode(tokens);
			const selectedNode = definition.nodes.find(node => node.id === selected) ?? null;
			const selectedToken = selected ? latest.get(selected) ?? null : null;
			const runTone = run ? (run.status === "waiting" ? "waiting" : run.status === "failed" ? "failed" : run.status === "done" ? "" : "") : "";
			const totalTokens = tokens.length;
			const completed = tokens.filter(token => token.status === "completed").length;
			const failed = tokens.filter(token => token.status === "failed").length;
			const pending = tokens.filter(token => token.status === "waiting").length;
			const permissions = view.permissions ?? {};
			const permissionLabel = section => {
				const value = permissions[section] ?? { mode: "deny" };
				if (value.mode === "full") return "\u5b8c\u6574";
				if (value.mode === "allowlist") return `\u5141\u8bb8\u5217\u8868 ${Array.isArray(value.allow) && value.allow.length > 0 ? value.allow.join(", ") : ""}`.trim();
				return "\u62d2\u7edd";
			};

			const hero = h("header", { className: "atw-hero" },
				h("div", { className: "atw-hero-top" },
					h("span", { className: "atw-mark" }, initialOf(definition.name)),
					h("div", { className: "atw-hero-copy" },
						h("div", { className: "atw-title-row" }, h("strong", { className: "atw-name", title: definition.name }, definition.name)),
						h("span", { className: "atw-subtitle" }, `${definition.nodes.length} \u8282\u70b9 \u00b7 ${definition.edges.length} \u8fb9${run ? ` \u00b7 ${run.runId}` : ""}`),
					),
					h("button", { className: "atw-icon-btn", type: "button", title: "\u5237\u65b0", "aria-label": "\u5237\u65b0", onClick: load }, "\u21bb"),
				),
				h("div", { className: "atw-live-line" },
					h("span", { className: `atw-live ${runTone}` }, h("i", {}), run ? (RUN_STATUS[run.status] ?? run.status) : "\u5c1a\u672a\u8fd0\u884c"),
					run ? h("span", { className: "atw-live-meta" }, `\u542f\u52a8\u4e8e ${timeAgo(run.createdAt)}`) : null,
					run ? h("span", { className: "atw-live-meta" }, `\u66f4\u65b0 ${timeAgo(run.updatedAt)}`) : null,
				),
				h("div", { className: "atw-stats" },
					h("span", { className: "atw-stat" }, h("b", {}, totalTokens), " \u8282\u70b9\u6267\u884c"),
					h("span", { className: "atw-stat done" }, h("b", {}, completed), " \u5b8c\u6210"),
					h("span", { className: "atw-stat warn" }, h("b", {}, pending), " \u7b49\u5f85"),
					h("span", { className: "atw-stat error" }, h("b", {}, failed), " \u5931\u8d25"),
					run ? h("span", { className: "atw-stat" }, h("b", {}, durationSince(run.createdAt)), " \u8fd0\u884c") : null,
				),
				h("div", { className: "atw-permissions" },
					h("span", { className: `atw-permission ${permissions.command?.mode === "deny" || !permissions.command ? "" : "granted"}` }, `\u547d\u4ee4\uff1a${permissionLabel("command")}`),
					h("span", { className: `atw-permission ${permissions.http?.mode === "deny" || !permissions.http ? "" : "granted"}` }, `HTTP\uff1a${permissionLabel("http")}`),
				),
			);

			const banner = waiting.length === 0 ? null : h("section", { className: "atw-banner" },
				h("div", { className: "atw-banner-title" }, h("i", {}), `${waiting.length} \u4e2a\u8282\u70b9\u7b49\u5f85\u51b3\u7b56`),
				...waiting.map(token => h("div", { className: "atw-decision", key: token.tokenId },
					h("span", { title: `${token.nodeId} \u00b7 ${token.title}` }, `${token.title} \u00b7 ${token.nodeId}`),
					...token.outcomes.map(outcome => h("button", {
						key: outcome,
						className: `atw-btn ${outcome === "reject" ? "atw-danger" : "atw-primary"}`,
						type: "button",
						disabled: busy,
						onClick: () => decide(token, outcome),
					}, outcome)),
				)),
			);

			const graph = h(WorkflowGraph, {
				definition,
				tokens,
				selected,
				onSelect: setSelected,
			});

			const detail = selectedNode === null ? null : h("section", { className: "atw-section" },
				h("div", { className: "atw-section-head" },
					h("strong", {}, selectedNode.title ?? selectedNode.id),
					h("span", { className: "atw-executor" }, nodeTypeLabel(selectedNode.type)),
					selectedNode.role ? h("span", { className: "atw-chip" }, selectedNode.role) : null,
					h("button", { className: "atw-link-btn", type: "button", onClick: () => setSelected(null) }, "\u5173\u95ed"),
				),
				selectedToken === null ? h("span", { className: "atw-idle", style: { color: "var(--dsw-alias-label-tertiary,#8a929e)", fontSize: "11px" } }, "\u8fd9\u4e2a\u8282\u70b9\u8fd8\u6ca1\u6709\u6267\u884c\u8bb0\u5f55") : h("dl", { className: "atw-kv" },
					h("dt", {}, "\u72b6\u6001"), h("dd", {}, TOKEN_STATUS[selectedToken.status] ?? selectedToken.status),
					selectedToken.outcome ? h("dt", {}, "\u7ed3\u679c") : null,
					selectedToken.outcome ? h("dd", {}, selectedToken.outcome) : null,
					h("dt", {}, "\u5c1d\u8bd5"), h("dd", {}, String(selectedToken.attempt)),
					selectedToken.error ? h("dt", {}, "\u9519\u8bef") : null,
					selectedToken.error ? h("dd", {}, `${selectedToken.error.code}: ${selectedToken.error.message}`) : null,
				),
				selectedToken?.output === null || selectedToken?.output === undefined ? null : h("details", { className: "atw-detail", open: true },
					h("summary", {}, "\u8f93\u51fa"),
					h("pre", { className: "atw-pre" }, JSON.stringify(selectedToken.output, null, 2)),
				),
				h("details", { className: "atw-detail" },
					h("summary", {}, "\u8282\u70b9\u914d\u7f6e"),
					h("pre", { className: "atw-pre" }, JSON.stringify({ type: selectedNode.type, role: selectedNode.role, config: selectedNode.config, inputs: selectedNode.inputs }, null, 2)),
				),
			);

			const tokenList = run === null || tokens.length === 0 ? null : h("section", { className: "atw-section" },
				h("div", { className: "atw-section-head" },
					h("strong", {}, "\u6267\u884c\u8bb0\u5f55"),
					h("span", { className: "atw-chip" }, String(tokens.length)),
				),
				h("div", { className: "atw-list" },
					...tokens.slice().reverse().map(token => h("div", { className: "atw-token", key: token.id },
						h("strong", {}, token.nodeId),
						h("span", { className: "atw-token-id", title: token.id }, token.id),
						h("span", { className: `atw-chip ${token.status === "completed" ? "done" : token.status === "failed" ? "error" : token.status === "waiting" ? "wait" : "active"}` }, TOKEN_STATUS[token.status] ?? token.status),
					)),
				),
			);

			const controls = h("section", { className: "atw-section" },
				h("div", { className: "atw-section-head" },
					h("strong", {}, "运行"),
					run ? h("span", { className: `atw-chip ${run.status === "waiting" ? "wait" : run.status === "failed" ? "error" : run.status === "done" ? "done" : "active"}` }, RUN_STATUS[run.status] ?? run.status) : h("span", { className: "atw-chip" }, "\u65e0"),
				),
				h("div", { className: "atw-actions", style: { marginTop: "7px" } },
					run ? h("button", { className: "atw-btn atw-primary", type: "button", disabled: busy || run.status === "done" || run.status === "failed", onClick: runMore }, busy ? "\u5904\u7406\u4e2d\u2026" : "\u7ee7\u7eed\u8fd0\u884c") : null,
					h("button", { className: "atw-btn", type: "button", disabled: busy, onClick: () => setShowStart(true) }, "\u65b0\u8fd0\u884c"),
				),
				showStart || run === null ? h("div", { className: "atw-compose", style: { marginTop: "7px" } },
					h("textarea", {
						className: "atw-textarea",
						value: inputText,
						"aria-label": "\u521d\u59cb\u8f93\u5165 JSON",
						onChange: event => setInputText(event.currentTarget.value),
					}),
					h("button", { className: "atw-btn atw-primary", type: "button", disabled: busy, onClick: startRun }, busy ? "\u542f\u52a8\u4e2d\u2026" : "\u542f\u52a8\u8fd0\u884c"),
				) : null,
			);

			const context = run === null ? null : h("details", { className: "atw-detail" },
				h("summary", {}, "\u8fd0\u884c\u4e0a\u4e0b\u6587"),
				h("pre", { className: "atw-pre" }, JSON.stringify(run.context, null, 2)),
			);

			return h("div", { className: "atw-panel" },
				hero,
				graph,
				banner,
				detail,
				controls,
				tokenList,
				context,
				toast === null ? null : h("div", { className: `atw-toast ${toast.tone}`, role: "status", "aria-live": "polite" }, toast.text),
			);
		}

		function OpenButton({ open }) {
			return h("button", { className: "atw-header-btn", type: "button", title: "\u6253\u5f00\u5de5\u4f5c\u6d41\u770b\u677f", onClick: open }, TITLE);
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
