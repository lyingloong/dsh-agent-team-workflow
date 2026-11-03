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

		const ITEM_STATUS = {
			active: "\u8fdb\u884c\u4e2d",
			blocked: "\u5f85\u51b3\u7b56",
			done: "\u5df2\u5b8c\u6210",
			cancelled: "\u5df2\u53d6\u6d88",
		};
		const TASK_STATUS = {
			pending: "\u5f85\u5b9a",
			ready: "\u53ef\u9886\u53d6",
			running: "\u6267\u884c\u4e2d",
			completed: "\u5df2\u5b8c\u6210",
			failed: "\u5931\u8d25",
			cancelled: "\u5df2\u53d6\u6d88",
		};
		const HEALTH = { ok: "\u6b63\u5e38", degraded: "\u964d\u7ea7", blocked: "\u5df2\u5c01\u9501" };
		const OUTCOME = {
			complete: "\u5b8c\u6210",
			pass: "\u901a\u8fc7",
			needs_revision: "\u9700\u4fee\u6539",
			reject: "\u62d2\u7edd",
			approve: "\u6279\u51c6",
		};

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
  padding: 11px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-lg, 10px);
  background:
    linear-gradient(160deg, color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 7%, transparent), transparent 68%),
    var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
}
.atw-hero-top { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
.atw-mark {
  width: 34px; height: 34px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 10px;
  color: var(--dsw-alias-brand-primary, #4f7cff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 13%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 26%, transparent);
  font-size: 15px; font-weight: 650;
}
.atw-hero-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.atw-title-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.atw-name {
  flex: 1; min-width: 0;
  font-size: 14px; font-weight: 620; letter-spacing: .1px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.atw-subtitle {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary, #8a929e);
  font-size: 11.5px;
}
.atw-icon-btn {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 27px; height: 27px;
  font: inherit; font-size: 14px; line-height: 1;
  color: var(--dsw-alias-label-tertiary, #8a929e);
  background: transparent;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm, 6px);
  cursor: pointer;
}
.atw-icon-btn:hover {
  color: var(--dsw-alias-label-primary, #1c2128);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08));
  border-color: var(--dsw-alias-border-l1, rgba(127,127,127,.22));
}
.atw-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: 1px; }
.atw-live-line {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin-top: 9px;
  color: var(--dsw-alias-label-tertiary, #8a929e);
  font-size: 10.5px;
}
.atw-live {
  display: inline-flex; align-items: center; gap: 5px;
  color: var(--dsw-alias-state-success-primary, #2f8a55);
  font-weight: 550;
}
.atw-live i {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #2f8a55);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f8a55) 16%, transparent);
  animation: atw-pulse 2.2s ease-in-out infinite;
}
@keyframes atw-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .5; transform: scale(.82); }
}
.atw-live-meta { color: var(--dsw-alias-label-tertiary, #8a929e); }
.atw-stats { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.atw-stat {
  display: inline-flex; align-items: baseline; gap: 4px;
  padding: 2px 7px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: 999px;
  background: var(--dsw-alias-bg-base, rgba(255,255,255,.35));
  color: var(--dsw-alias-label-tertiary, #8a929e);
  font-size: 10.5px;
  white-space: nowrap;
}
.atw-stat b {
  color: var(--dsw-alias-label-primary, #1c2128);
  font-size: 11.5px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.atw-stat.warn b { color: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-stat.done b { color: var(--dsw-alias-state-success-primary, #2f8a55); }
.atw-graph-card {
  flex: none;
  padding: 8px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
}
.atw-graph-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.atw-graph-kicker { font-size: 12px; font-weight: 600; }
.atw-link-btn {
  margin-left: auto; flex: none;
  font: inherit; font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary, #8a929e);
  background: transparent; border: 0; border-radius: 4px;
  padding: 1px 4px; cursor: pointer;
}
.atw-link-btn:hover { color: var(--dsw-alias-brand-primary, #4f7cff); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.atw-link-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: 1px; }
.atw-graph-svg { display: block; width: auto; max-width: 100%; height: auto; overflow: visible; margin: 2px auto 0; }
.atw-graph-box {
  fill: var(--dsw-alias-bg-base, #fff);
  stroke: var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  stroke-width: 0.8;
  transition: stroke .15s ease, fill .15s ease;
}
.atw-graph-box.active { stroke: var(--dsw-alias-brand-primary, #4f7cff); }
.atw-graph-box.wait { stroke: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-graph-box.done { stroke: var(--dsw-alias-state-success-primary, #2f8a55); }
.atw-graph-box.selected { stroke-width: 1.7; }
.atw-graph-node { cursor: pointer; }
.atw-graph-node:hover .atw-graph-box { fill: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.atw-graph-node:focus-visible .atw-graph-box { stroke-width: 1.7; stroke: var(--dsw-alias-brand-primary, #4f7cff); }
.atw-graph-title { font-size: 10.5px; font-weight: 600; fill: var(--dsw-alias-label-primary, #1c2128); }
.atw-graph-role { font-size: 8.5px; fill: var(--dsw-alias-label-tertiary, #8a929e); }
.atw-graph-count { fill: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); }
.atw-graph-count-text { font-size: 8.5px; fill: var(--dsw-alias-label-secondary, #5f6874); font-variant-numeric: tabular-nums; }
.atw-graph-gate { fill: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-graph-dot { stroke: none; }
.atw-graph-dot.active { fill: var(--dsw-alias-brand-primary, #4f7cff); }
.atw-graph-dot.wait { fill: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-graph-dot.done { fill: var(--dsw-alias-state-success-primary, #2f8a55); }
.atw-graph-dot.idle { fill: var(--dsw-alias-border-l3, #b8bec8); }
.atw-edge-pill { fill: var(--dsw-alias-bg-base, #fff); stroke: var(--dsw-alias-border-l1, rgba(127,127,127,.22)); stroke-width: .5; }
.atw-edge-label { font-size: 8.5px; fill: var(--dsw-alias-label-tertiary, #8a929e); }
.atw-stage-mini { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.atw-stage-mini button {
  display: inline-flex; align-items: center; gap: 4px;
  font: inherit; font-size: 10.5px;
  color: var(--dsw-alias-label-secondary, #5f6874);
  background: var(--dsw-alias-bg-base, #fff);
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: 999px;
  padding: 1px 7px;
  cursor: pointer;
}
.atw-stage-mini button:hover { border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.3)); color: var(--dsw-alias-label-primary, #1c2128); }
.atw-stage-mini button.selected { color: var(--dsw-alias-brand-primary, #4f7cff); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 45%, transparent); }
.atw-stage-mini .n { color: var(--dsw-alias-label-tertiary, #8a929e); font-variant-numeric: tabular-nums; }
.atw-banner {
  flex: none;
  padding: 8px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 38%, transparent);
  border-radius: var(--dsw-radius-md, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 6%, transparent);
}
.atw-banner-title {
  display: flex; align-items: center; gap: 5px;
  margin-bottom: 5px;
  color: var(--dsw-alias-state-warn-label, #b06b12);
  font-size: 11.5px; font-weight: 560;
}
.atw-banner-title i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.atw-decision { display: flex; align-items: center; gap: 5px; padding: 2px 0; min-width: 0; }
.atw-decision span {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px;
}
.atw-toolbar { flex: none; display: flex; align-items: center; gap: 6px; min-width: 0; }
.atw-filters { flex: 1; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: thin; min-width: 0; }
.atw-filter {
  flex: none;
  display: inline-flex; align-items: center; gap: 4px;
  font: inherit; font-size: 11px;
  color: var(--dsw-alias-label-secondary, #5f6874);
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
  border: 0.5px solid transparent;
  border-radius: 999px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.atw-filter:hover { border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.atw-filter.active {
  color: var(--dsw-alias-brand-primary, #4f7cff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 10%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 35%, transparent);
}
.atw-filter .n { color: var(--dsw-alias-label-tertiary, #8a929e); font-variant-numeric: tabular-nums; }
.atw-filter.active .n { color: var(--dsw-alias-brand-primary, #4f7cff); }
.atw-stage-chip {
  flex: none;
  font: inherit; font-size: 10.5px;
  color: var(--dsw-alias-brand-primary, #4f7cff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 9%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 32%, transparent);
  border-radius: 999px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.atw-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 1px 2px 4px 0; scrollbar-width: thin; }
.atw-stage {
  flex: none;
  padding: 8px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04));
}
.atw-stage.is-selected { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 35%, transparent); }
.atw-stage-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.atw-stage-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-border-l3, #b8bec8); }
.atw-stage-dot.active { background: var(--dsw-alias-brand-primary, #4f7cff); }
.atw-stage-dot.wait { background: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-stage-dot.done { background: var(--dsw-alias-state-success-primary, #2f8a55); }
.atw-stage-head strong { font-size: 12px; font-weight: 600; }
.atw-role {
  flex: none;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
}
.atw-role-c0 { color: var(--dsw-alias-brand-primary, #4f7cff); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 11%, transparent); }
.atw-role-c1 { color: var(--dsw-alias-state-success-primary, #2f8a55); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f8a55) 11%, transparent); }
.atw-role-c2 { color: var(--dsw-alias-state-warn-label, #b06b12); background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 11%, transparent); }
.atw-role-c3 { color: var(--dsw-alias-label-primary-bluish, #4c6a92); background: color-mix(in srgb, var(--dsw-alias-label-primary-bluish, #4c6a92) 11%, transparent); }
.atw-role-c4 { color: var(--dsw-alias-onboarding-accent, #8a5cf6); background: color-mix(in srgb, var(--dsw-alias-onboarding-accent, #8a5cf6) 11%, transparent); }
.atw-executor { flex: none; padding: 0 5px; border-radius: 999px; color: var(--dsw-alias-label-tertiary, #8a929e); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); font-size: 9.5px; line-height: 16px; }
.atw-fill-c0 { fill: var(--dsw-alias-brand-primary, #4f7cff); }
.atw-fill-c1 { fill: var(--dsw-alias-state-success-primary, #2f8a55); }
.atw-fill-c2 { fill: var(--dsw-alias-state-warn-label, #b06b12); }
.atw-fill-c3 { fill: var(--dsw-alias-label-primary-bluish, #4c6a92); }
.atw-fill-c4 { fill: var(--dsw-alias-onboarding-accent, #8a5cf6); }
.atw-stage-count { margin-left: auto; color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.atw-stage-items { display: flex; flex-direction: column; gap: 6px; margin-top: 7px; }
.atw-idle { color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 11px; padding: 1px 0; }
.atw-card {
  padding: 8px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-base, #fff);
  display: flex; flex-direction: column; gap: 5px;
  box-shadow: var(--dsw-elevation-soft, 0 1px 2px rgba(0,0,0,.03));
  transition: border-color .15s ease, box-shadow .15s ease;
}
.atw-card:hover {
  border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  box-shadow: var(--dsw-elevation-panel, 0 2px 6px rgba(0,0,0,.05));
}
.atw-card.is-blocked { border-left: 2px solid var(--dsw-alias-state-warn-label, #b06b12); }
.atw-card.is-done { opacity: .74; }
.atw-card-top { display: flex; align-items: flex-start; gap: 6px; }
.atw-card-title {
  flex: 1; min-width: 0;
  font-size: 12.5px; font-weight: 550; line-height: 1.42;
  overflow-wrap: anywhere;
}
.atw-chip {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3));
  color: var(--dsw-alias-label-tertiary, #8a929e);
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
}
.atw-chip.active { color: var(--dsw-alias-brand-primary, #4f7cff); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 42%, transparent); }
.atw-chip.blocked { color: var(--dsw-alias-state-warn-label, #b06b12); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 42%, transparent); }
.atw-chip.done { color: var(--dsw-alias-state-success-primary, #2f8a55); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f8a55) 42%, transparent); }
.atw-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
  color: var(--dsw-alias-label-tertiary, #8a929e);
  font-size: 10.5px;
}
.atw-avatar {
  width: 15px; height: 15px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%;
  color: var(--dsw-alias-label-secondary, #5f6874);
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08));
  font-size: 8px; font-weight: 600;
}
.atw-meta-sep { color: var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.atw-priority { color: var(--dsw-alias-state-warn-label, #b06b12); font-weight: 550; }
.atw-gate {
  display: flex; align-items: center; gap: 5px;
  margin-top: 1px;
  padding: 5px 6px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 38%, transparent);
  border-radius: var(--dsw-radius-sm, 6px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #b06b12) 6%, transparent);
}
.atw-gate-text {
  flex: 1; min-width: 0;
  color: var(--dsw-alias-state-warn-label, #b06b12);
  font-size: 10.5px; font-weight: 550;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.atw-btn {
  flex: none;
  font: inherit; font-size: 11px; line-height: 1.3;
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
.atw-btn[disabled] { opacity: .5; cursor: default; }
.atw-btn.atw-primary {
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4f7cff));
  border-color: transparent;
}
.atw-btn.atw-danger {
  color: var(--dsw-alias-state-error-primary, #c53b3b);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c53b3b) 42%, transparent);
}
.atw-detail { margin: 0; }
.atw-detail summary {
  cursor: pointer;
  color: var(--dsw-alias-label-tertiary, #8a929e);
  font-size: 10.5px;
  user-select: none;
}
.atw-detail summary:hover { color: var(--dsw-alias-label-secondary, #5f6874); }
.atw-kv {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 3px 8px;
  margin: 5px 0 0;
  font-size: 10.5px;
}
.atw-kv dt { color: var(--dsw-alias-label-tertiary, #8a929e); white-space: nowrap; }
.atw-kv dd { margin: 0; color: var(--dsw-alias-label-secondary, #5f6874); overflow-wrap: anywhere; }
.atw-pre {
  margin: 5px 0 0;
  padding: 6px;
  max-height: 150px;
  overflow: auto;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06));
  font-size: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.atw-foot { flex: none; display: flex; flex-direction: column; gap: 6px; }
.atw-lanes { display: flex; flex-wrap: wrap; gap: 7px; }
.atw-lane {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px;
  color: var(--dsw-alias-label-tertiary, #8a929e);
}
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
  padding: 5px 8px;
}
.atw-compose input:focus { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: -1px; }
.atw-compose input:disabled { opacity: .6; }
.atw-toast {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 9px;
  border-radius: var(--dsw-radius-sm, 6px);
  font-size: 11px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
}
.atw-toast.ok { color: var(--dsw-alias-state-success-primary, #2f8a55); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2f8a55) 32%, transparent); }
.atw-toast.error { color: var(--dsw-alias-state-error-primary, #c53b3b); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #c53b3b) 32%, transparent); }
.atw-inline-error {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #c53b3b) 32%, transparent);
  border-radius: var(--dsw-radius-sm, 6px);
  color: var(--dsw-alias-state-error-primary, #c53b3b);
  font-size: 11px;
}
.atw-inline-error span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.atw-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 7px; flex: 1; min-height: 130px; padding: 20px; text-align: center;
  color: var(--dsw-alias-label-tertiary, #8a929e); font-size: 12px;
}
.atw-empty-mark {
  width: 42px; height: 42px; border-radius: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-brand-primary, #4f7cff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 12%, transparent);
  font-size: 18px;
}
.atw-empty strong { color: var(--dsw-alias-label-secondary, #5f6874); font-size: 12.5px; font-weight: 550; }
.atw-error { margin: 0; color: var(--dsw-alias-state-error-primary, #c53b3b); font-size: 12px; }
.atw-spinner {
  width: 18px; height: 18px;
  border-radius: 50%;
  border: 2px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,.16));
  border-top-color: var(--dsw-alias-brand-primary, #4f7cff);
  animation: atw-spin .8s linear infinite;
}
@keyframes atw-spin { to { transform: rotate(360deg); } }
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

		function roleIndex(workflow, roleId) {
			const roles = workflow.roles ?? [];
			const index = roles.findIndex(role => role.id === roleId);
			return index < 0 ? 0 : index % 5;
		}

		function roleClass(workflow, roleId) {
			return `atw-role-c${roleIndex(workflow, roleId)}`;
		}

		function roleFill(workflow, roleId) {
			return `atw-fill-c${roleIndex(workflow, roleId)}`;
		}

		function nodeTone(column) {
			if (column.items.some(item => item.status === "blocked")) return "wait";
			if (column.items.some(item => item.status === "active")) return "active";
			if (column.items.length > 0 && column.items.every(item => item.status === "done")) return "done";
			return "";
		}

		function outcomeLabel(outcome) {
			return OUTCOME[outcome] ?? outcome;
		}

		function listText(value) {
			if (Array.isArray(value)) return value.map(entry => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\uff1b");
			if (typeof value === "string") return value;
			return "";
		}

		function detailRows(item) {
			const rows = [];
			if (item.task) {
				rows.push(["\u72b6\u6001", TASK_STATUS[item.task.status] ?? item.task.status]);
				rows.push(["\u6267\u884c\u4eba", item.task.assignee ?? "\u672a\u5206\u914d"]);
				if (item.task.provider) rows.push(["\u7ebf\u8def", item.task.provider]);
				if (item.task.attemptCount > 0) rows.push(["\u5c1d\u8bd5", `${item.task.attemptCount} \u6b21`]);
			}
			if (item.updatedAt) rows.push(["\u66f4\u65b0", timeAgo(item.updatedAt)]);
			const contract = item.contract;
			if (contract !== null && typeof contract === "object") {
				if (typeof contract.objective === "string" && contract.objective.trim() !== "") rows.push(["\u76ee\u6807", contract.objective]);
				const acceptance = listText(contract.acceptance);
				if (acceptance !== "") rows.push(["\u9a8c\u6536", acceptance]);
				const verify = listText(contract.verify);
				if (verify !== "") rows.push(["\u9a8c\u8bc1", verify]);
				const scope = listText(contract.inScope);
				if (scope !== "") rows.push(["\u8303\u56f4", scope]);
			}
			const result = item.result;
			const summary = result !== null && typeof result === "object"
				? result.summary ?? result.message ?? ""
				: typeof result === "string" ? result : "";
			if (typeof summary === "string" && summary.trim() !== "") rows.push(["\u7ed3\u679c", summary.trim()]);
			return rows;
		}

		/**
		 * Lay out the workflow DAG: rank by the longest path from the entry, pack
		 * each rank into a row, and route edges between rows. A transition that
		 * goes to an equal or earlier rank (a needs_revision loop) is drawn as a
		 * side curve so it does not read as forward progress.
		 */
		function buildGraph(workflow) {
			const stages = workflow.stages ?? [];
			const byId = new Map(stages.map(stage => [stage.id, stage]));
			const entry = workflow.entry ?? stages[0]?.id;
			const rank = new Map();
			const visit = (id, depth, path) => {
				if (path.has(id) || (rank.get(id) ?? -1) >= depth) return;
				rank.set(id, depth);
				const nextPath = new Set(path);
				nextPath.add(id);
				const stage = byId.get(id);
				for (const target of Object.values(stage?.on ?? {})) {
					if (byId.has(target)) visit(target, depth + 1, nextPath);
				}
			};
			if (entry && byId.has(entry)) visit(entry, 0, new Set());
			let maxRank = 0;
			for (const stage of stages) {
				if (!rank.has(stage.id)) rank.set(stage.id, maxRank + 1);
				maxRank = Math.max(maxRank, rank.get(stage.id));
			}
			const groups = new Map();
			for (const stage of stages) {
				const value = rank.get(stage.id);
				if (!groups.has(value)) groups.set(value, []);
				groups.get(value).push(stage);
			}
			const nodeW = 112;
			const nodeH = 42;
			const gap = 14;
			const rowH = 64;
			const padY = 10;
			const rowWidth = Math.max(0, ...[...groups.values()].map(list => list.length * nodeW + (list.length - 1) * gap));
			const width = Math.max(360, rowWidth + 70);
			const height = padY * 2 + (maxRank + 1) * rowH;
			const position = new Map();
			for (const [value, list] of groups) {
				const total = list.length * nodeW + (list.length - 1) * gap;
				let x = (width - total) / 2;
				for (const stage of list) {
					position.set(stage.id, { x, y: padY + value * rowH, w: nodeW, h: nodeH });
					x += nodeW + gap;
				}
			}
			const gateEdges = new Set((workflow.gates ?? [])
				.filter(gate => gate.after && gate.outcome)
				.map(gate => `${gate.after}:${gate.outcome}`));
			const gateStages = new Set((workflow.gates ?? [])
				.filter(gate => gate.after && !gate.outcome)
				.map(gate => gate.after));
			const edges = [];
			for (const stage of stages) {
				const from = position.get(stage.id);
				for (const [outcome, target] of Object.entries(stage.on ?? {})) {
					const to = position.get(target);
					if (!from || !to) continue;
					const back = (rank.get(target) ?? 0) <= (rank.get(stage.id) ?? 0);
					const gate = gateEdges.has(`${stage.id}:${outcome}`) || gateStages.has(stage.id);
					const label = outcome !== "complete" || gate ? `${outcome}${gate ? " \u00b7 gate" : ""}` : "";
					if (!back) {
						const sx = from.x + from.w / 2;
						const sy = from.y + from.h;
						const tx = to.x + to.w / 2;
						const ty = to.y;
						const my = (sy + ty) / 2;
						edges.push({
							d: `M${sx} ${sy} C${sx} ${my} ${tx} ${my} ${tx} ${ty - 1}`,
							lx: (sx + tx) / 2,
							ly: my,
							label,
							gate,
						});
					} else {
						const sx = from.x + from.w;
						const sy = from.y + from.h / 2;
						const tx = to.x + to.w;
						const ty = to.y + to.h / 2;
						const bx = Math.max(sx, tx) + 24;
						edges.push({
							d: `M${sx} ${sy} C${bx} ${sy} ${bx} ${ty} ${tx + 1} ${ty}`,
							lx: Math.min(bx, width - 14),
							ly: (sy + ty) / 2,
							label,
							gate,
						});
					}
				}
			}
			const nodes = stages.map(stage => ({
				id: stage.id,
				title: stage.title ?? stage.id,
				role: stage.role,
				entry: stage.id === entry,
				...position.get(stage.id),
			}));
			return { width, height, nodes, edges };
		}

		function WorkflowGraph({ workflow, columns, selected, onSelect, collapsed, onToggle }) {
			const graph = buildGraph(workflow);
			const counts = new Map(columns.map(column => [column.id, column.items.length]));
			const tones = new Map(columns.map(column => [column.id, nodeTone(column)]));
			const gates = new Set((workflow.gates ?? []).map(gate => gate.after));
			const clip = text => {
				let out = "";
				let width = 0;
				for (const char of String(text)) {
					const charWidth = /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 10.5 : 5.8;
					if (width + charWidth > 68) return `${out}\u2026`;
					out += char;
					width += charWidth;
				}
				return out;
			};

			const head = h("div", { className: "atw-graph-head" },
				h("span", { className: "atw-graph-kicker" }, "\u6d41\u7a0b"),
				h("button", {
					className: "atw-link-btn",
					type: "button",
					"aria-expanded": !collapsed,
					onClick: onToggle,
				}, collapsed ? "\u5c55\u5f00" : "\u6536\u8d77"),
			);

			if (collapsed) {
				return h("section", { className: "atw-graph-card" }, head,
					h("div", { className: "atw-stage-mini" },
						...workflow.stages.map(stage => h("button", {
							key: stage.id,
							type: "button",
							className: selected === stage.id ? "selected" : undefined,
							onClick: () => onSelect(stage.id),
						}, stage.title ?? stage.id, h("span", { className: "n" }, String(counts.get(stage.id) ?? 0)))),
					),
				);
			}

			return h("section", { className: "atw-graph-card" }, head,
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
						h("marker", {
							id: "atw-arrow",
							viewBox: "0 0 6 6",
							refX: 5,
							refY: 3,
							markerWidth: 6,
							markerHeight: 6,
							orient: "auto",
						}, h("path", { d: "M0 0 L6 3 L0 6 z", fill: "var(--dsw-alias-border-l3, #b8bec8)" })),
					),
					...graph.edges.map((edge, index) => h("g", { key: `edge-${index}` },
						h("path", {
							d: edge.d,
							fill: "none",
							stroke: edge.gate ? "var(--dsw-alias-state-warn-label, #b06b12)" : "var(--dsw-alias-border-l3, #b8bec8)",
							strokeWidth: edge.gate ? 1.2 : 0.9,
							strokeLinecap: "round",
							markerEnd: "url(#atw-arrow)",
							opacity: 0.9,
						}),
						edge.label === "" ? null : h("g", {},
							h("rect", {
								x: edge.lx - Math.max(18, edge.label.length * 4.8 + 8) / 2,
								y: edge.ly - 6,
								width: Math.max(18, edge.label.length * 4.8 + 8),
								height: 12,
								rx: 6,
								className: "atw-edge-pill",
							}),
							h("text", {
								x: edge.lx,
								y: edge.ly + 3,
								textAnchor: "middle",
								className: "atw-edge-label",
							}, edge.label),
						),
					)),
					...graph.nodes.map(node => h("g", {
						key: node.id,
						className: "atw-graph-node",
						role: "button",
						tabIndex: 0,
						"aria-label": `${node.title}\uff0c${counts.get(node.id) ?? 0} \u9879`,
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
							className: `atw-graph-box ${tones.get(node.id) ?? ""}${selected === node.id ? " selected" : ""}`,
						}),
						h("rect", {
							x: node.x + 1,
							y: node.y + 8,
							width: 2.5,
							height: node.h - 16,
							rx: 1.2,
							className: roleFill(workflow, node.role),
						}),
						h("circle", {
							cx: node.x + 11,
							cy: node.y + 10,
							r: node.entry ? 3 : 2.4,
							className: `atw-graph-dot ${tones.get(node.id) || "idle"}`,
						}),
						node.entry ? h("circle", {
							cx: node.x + 11,
							cy: node.y + 10,
							r: 5,
							fill: "none",
							stroke: "var(--dsw-alias-brand-primary, #4f7cff)",
							strokeWidth: 0.8,
						}) : null,
						h("text", { x: node.x + 19, y: node.y + 19, className: "atw-graph-title" }, clip(node.title)),
						h("text", { x: node.x + 19, y: node.y + 32, className: "atw-graph-role" }, clip(node.role)),
						h("circle", {
							cx: node.x + node.w - 14,
							cy: node.y + node.h / 2,
							r: 9,
							className: "atw-graph-count",
						}),
						h("text", {
							x: node.x + node.w - 14,
							y: node.y + node.h / 2 + 3,
							textAnchor: "middle",
							className: "atw-graph-count-text",
						}, String(counts.get(node.id) ?? 0)),
						gates.has(node.id) ? h("path", {
							d: `M${node.x + node.w - 7} ${node.y + 3} l3.5 3.5 -3.5 3.5 -3.5 -3.5 z`,
							className: "atw-graph-gate",
						}) : null,
					)),
				),
			);
		}

		function WorkflowPanel({ sessionId }) {
			const [payload, setPayload] = useState(null);
			const [error, setError] = useState("");
			const [busy, setBusy] = useState(false);
			const [draft, setDraft] = useState("");
			const [selectedStage, setSelectedStage] = useState(null);
			const [statusFilter, setStatusFilter] = useState("all");
			const [graphCollapsed, setGraphCollapsed] = useState(false);
			const [toast, setToast] = useState(null);
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
				setPayload(null);
				setSelectedStage(null);
				setStatusFilter("all");
				load();
				const timer = setInterval(() => {
					if (!document.hidden) load();
				}, 3000);
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

			const act = async (path, body, success) => {
				if (!sessionId) return;
				setBusy(true);
				try {
					await postJson(API + path, { session: sessionId, ...body });
					await load();
					setToast({ tone: "ok", text: success });
					return true;
				} catch (cause) {
					setToast({ tone: "error", text: cause.message });
					return false;
				} finally {
					setBusy(false);
				}
			};

			const selectStage = id => {
				setSelectedStage(current => current === id ? null : id);
			};

			if (!sessionId) {
				return h("div", { className: "atw-panel" },
					h("div", { className: "atw-empty" },
						h("span", { className: "atw-empty-mark" }, "\u25c7"),
						h("strong", {}, TITLE),
						h("span", {}, "\u5f53\u524d\u9762\u677f\u6ca1\u6709\u7ed1\u5b9a\u4f1a\u8bdd\u3002"),
					),
				);
			}

			if (error && !payload) {
				return h("div", { className: "atw-panel" },
					h("div", { className: "atw-empty" },
						h("span", { className: "atw-empty-mark" }, "\u26a0"),
						h("strong", {}, "\u8f7d\u5165\u5931\u8d25"),
						h("span", {}, error),
						h("button", { className: "atw-btn", type: "button", onClick: load }, "\u91cd\u8bd5"),
					),
				);
			}

			if (!payload) {
				return h("div", { className: "atw-panel" },
					h("div", { className: "atw-empty" },
						h("span", { className: "atw-spinner" }),
						h("span", {}, "\u6b63\u5728\u8bfb\u53d6\u5de5\u4f5c\u6d41\u2026"),
					),
				);
			}

			if (!payload.defined) {
				return h("div", { className: "atw-panel" },
					h("div", { className: "atw-empty" },
						h("span", { className: "atw-empty-mark" }, "\u25c7"),
						h("strong", {}, "\u8fd9\u4e2a\u4f1a\u8bdd\u8fd8\u6ca1\u6709\u5de5\u4f5c\u6d41"),
						h("span", {}, "\u5bf9\u52a9\u624b\u8bf4\u201c\u521b\u5efa\u4e00\u4e2a\u81ea\u52a8\u5f00\u53d1\u7684\u5de5\u4f5c\u6d41\u201d\u5373\u53ef\u3002"),
					),
				);
			}

			const board = payload.board;
			const workflow = board.workflow;
			const counts = board.counts;
			const pending = board.pendingGates ?? [];
			const entryTitle = workflow.stages.find(stage => stage.id === workflow.entry)?.title ?? workflow.stages[0]?.title ?? "\u5165\u53e3";
			const inFlight = counts.active + counts.blocked;
			const runtime = durationSince(workflow.createdAt);
			let latestActivity = null;
			for (const column of board.columns) {
				for (const item of column.items) {
					if (item.updatedAt && (latestActivity === null || Date.parse(item.updatedAt) > Date.parse(latestActivity))) {
						latestActivity = item.updatedAt;
					}
				}
			}

			const hero = h("header", { className: "atw-hero" },
				h("div", { className: "atw-hero-top" },
					h("span", { className: "atw-mark" }, initialOf(workflow.name)),
					h("div", { className: "atw-hero-copy" },
						h("div", { className: "atw-title-row" },
							h("strong", { className: "atw-name", title: workflow.name }, workflow.name),
						),
						h("span", { className: "atw-subtitle", title: workflow.description ?? "" },
							workflow.description && workflow.description.trim() !== ""
								? workflow.description
								: `${workflow.stages.length} \u4e2a\u8282\u70b9 \u00b7 ${workflow.roles.length} \u4e2a\u89d2\u8272`),
					),
					h("button", {
						className: "atw-icon-btn",
						type: "button",
						title: "\u5237\u65b0",
						"aria-label": "\u5237\u65b0",
						onClick: load,
					}, "\u21bb"),
				),
				h("div", { className: "atw-live-line" },
					h("span", { className: "atw-live" }, h("i", {}), "\u6301\u7eed\u8fd0\u884c"),
					runtime === "" ? null : h("span", { className: "atw-live-meta" }, `\u5df2\u8fd0\u884c ${runtime}`),
					latestActivity === null ? null : h("span", { className: "atw-live-meta" }, `\u6700\u8fd1\u6d3b\u52a8 ${timeAgo(latestActivity)}`),
				),
				h("div", { className: "atw-stats" },
					h("span", { className: "atw-stat" }, h("b", {}, counts.items), " \u5de5\u4f5c\u9879"),
					h("span", { className: "atw-stat" }, h("b", {}, inFlight), " \u5728\u9014"),
					h("span", { className: "atw-stat warn" }, h("b", {}, pending.length), " \u5f85\u51b3\u7b56"),
					h("span", { className: "atw-stat done" }, h("b", {}, counts.done), " \u7d2f\u8ba1\u5b8c\u6210"),
					h("span", { className: "atw-stat" }, h("b", {}, `${counts.tasksRunning}/${counts.capacity}`), " \u5e76\u53d1"),
				),
			);

			const filterDefs = [
				["all", "\u5168\u90e8", counts.items],
				["active", "\u8fdb\u884c\u4e2d", counts.active],
				["blocked", "\u5f85\u51b3\u7b56", counts.blocked],
				["done", "\u5df2\u5b8c\u6210", counts.done],
			];
			const columns = board.columns
				.filter(column => selectedStage === null || column.id === selectedStage)
				.map(column => ({
					...column,
					items: column.items.filter(item => statusFilter === "all" || item.status === statusFilter),
				}))
				.filter(column => column.items.length > 0 || (selectedStage !== null && column.id === selectedStage));

			const toolbar = h("div", { className: "atw-toolbar" },
				selectedStage === null ? null : h("button", {
					className: "atw-stage-chip",
					type: "button",
					title: "\u663e\u793a\u5168\u90e8\u9636\u6bb5",
					onClick: () => setSelectedStage(null),
				}, `${board.columns.find(column => column.id === selectedStage)?.title ?? selectedStage} \u00d7`),
				h("div", { className: "atw-filters", role: "group", "aria-label": "\u4efb\u52a1\u7b5b\u9009" },
					...filterDefs.map(([key, label, count]) => h("button", {
						key,
						type: "button",
						className: `atw-filter${statusFilter === key ? " active" : ""}`,
						"aria-pressed": statusFilter === key,
						onClick: () => setStatusFilter(key),
					}, label, h("span", { className: "n" }, String(count)))),
				),
			);

			const list = h("div", { className: "atw-list" },
				...columns.map(column => h("section", {
					key: column.id,
					className: `atw-stage${selectedStage === column.id ? " is-selected" : ""}`,
					id: `atw-stage-${column.id}`,
				},
					h("div", { className: "atw-stage-head" },
						h("span", { className: `atw-stage-dot ${nodeTone(column)}` }),
						h("strong", {}, column.title),
						h("span", { className: `atw-role ${roleClass(workflow, column.role)}` }, column.role),
						column.executor === "external" ? h("span", { className: "atw-executor", title: "外部执行节点" }, "外部") : null,
						h("span", { className: "atw-stage-count" }, `${column.items.length} \u9879`),
					),
					h("div", { className: "atw-stage-items" },
						column.items.length === 0
							? h("span", { className: "atw-idle" }, "\u8fd9\u4e2a\u9636\u6bb5\u6682\u65e0\u4efb\u52a1")
							: column.items.map(item => h(TaskCard, {
								key: item.id,
								item,
								workflow,
								busy,
								onGate: (gate, decision) => act("/gate", { itemId: item.id, gate, decision },
									decision === "approve" ? `\u5df2\u901a\u8fc7 ${gate}` : `\u5df2\u62d2\u7edd ${gate}`),
							})),
					),
				)),
				columns.length === 0
					? h("div", { className: "atw-empty" },
						h("span", { className: "atw-empty-mark" }, "\u2713"),
						h("strong", {}, "\u6ca1\u6709\u5339\u914d\u7684\u4efb\u52a1"),
						h("span", {}, "\u8bd5\u8bd5\u5207\u6362\u7b5b\u9009\u6216\u663e\u793a\u5168\u90e8\u9636\u6bb5\u3002"),
						h("button", {
							className: "atw-btn",
							type: "button",
							onClick: () => {
								setStatusFilter("all");
								setSelectedStage(null);
							},
						}, "\u91cd\u7f6e\u7b5b\u9009"),
					)
					: null,
			);

			const lanes = board.providers.length === 0 ? null : h("div", { className: "atw-lanes" },
				...board.providers.map(provider => h("span", {
					key: provider.id,
					className: "atw-lane",
					title: HEALTH[provider.health] ?? provider.health,
				},
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
					act("/enqueue", { title, input: {} }, `\u5df2\u6dfb\u52a0\u5230\u300c${entryTitle}\u300d`).then(ok => { if (ok) setDraft(""); });
				},
			},
				h("input", {
					value: draft,
					placeholder: `\u6dfb\u52a0\u4efb\u52a1\u5230\u300c${entryTitle}\u300d\u2026`,
					"aria-label": "\u65b0\u4efb\u52a1\u6807\u9898",
					disabled: busy,
					onChange: event => setDraft(event.currentTarget.value),
				}),
				h("button", {
					className: "atw-btn atw-primary",
					type: "submit",
					disabled: busy || draft.trim() === "",
				}, busy ? "\u5904\u7406\u4e2d\u2026" : "\u6dfb\u52a0"),
			);

			return h("div", { className: "atw-panel" },
				hero,
				h(WorkflowGraph, {
					workflow,
					columns: board.columns,
					selected: selectedStage,
					onSelect: selectStage,
					collapsed: graphCollapsed,
					onToggle: () => setGraphCollapsed(current => !current),
				}),
				pending.length === 0 ? null : h("section", { className: "atw-banner" },
					h("div", { className: "atw-banner-title" }, h("i", {}), `${pending.length} \u9879\u7b49\u5f85\u4f60\u51b3\u7b56`),
					...pending.map(gate => h("div", { className: "atw-decision", key: `${gate.itemId}:${gate.gate}` },
						h("span", { title: `${gate.itemTitle} \u00b7 ${gate.gate}` },
							`${gate.itemTitle} \u00b7 ${gate.gate}${gate.signal?.outcome ? ` \u00b7 ${outcomeLabel(gate.signal.outcome)}` : ""}${gate.updatedAt ? ` \u00b7 \u7b49\u5f85 ${timeAgo(gate.updatedAt)}` : ""}`),
						h("button", {
							className: "atw-btn atw-primary",
							type: "button",
							disabled: busy,
							onClick: () => act("/gate", { itemId: gate.itemId, gate: gate.gate, decision: "approve" }, `\u5df2\u901a\u8fc7 ${gate.gate}`),
						}, "\u901a\u8fc7"),
						h("button", {
							className: "atw-btn atw-danger",
							type: "button",
							disabled: busy,
							onClick: () => act("/gate", { itemId: gate.itemId, gate: gate.gate, decision: "reject" }, `\u5df2\u62d2\u7edd ${gate.gate}`),
						}, "\u62d2\u7edd"),
					)),
				),
				toolbar,
				error === "" ? null : h("div", { className: "atw-inline-error" },
					h("span", { title: error }, error),
					h("button", { className: "atw-btn", type: "button", onClick: load }, "\u91cd\u8bd5"),
				),
				list,
				h("footer", { className: "atw-foot" },
					toast === null ? null : h("div", { className: `atw-toast ${toast.tone}`, role: "status", "aria-live": "polite" }, toast.text),
					lanes,
					composer,
				),
			);
		}

		function TaskCard({ item, workflow, busy, onGate }) {
			const pendingGates = item.gates.filter(gate => gate.status === "pending");
			const task = item.task;
			const assignee = task?.assignee ?? "\u672a\u5206\u914d";
			const rows = detailRows(item);
			return h("article", {
				className: `atw-card${item.status === "blocked" ? " is-blocked" : ""}${item.status === "done" ? " is-done" : ""}`,
			},
				h("div", { className: "atw-card-top" },
					h("span", { className: "atw-card-title", title: item.title }, item.title),
					h("span", { className: `atw-chip ${item.status}` }, ITEM_STATUS[item.status] ?? item.status),
				),
				h("div", { className: "atw-meta" },
					h("span", { className: "atw-avatar", title: assignee }, initialOf(assignee)),
					h("span", { title: assignee }, assignee),
					task === null ? null : h("span", { className: "atw-meta-sep" }, "\u00b7"),
					task === null ? null : h("span", {}, TASK_STATUS[task.status] ?? task.status),
					task?.provider ? h("span", { className: "atw-meta-sep" }, "\u00b7") : null,
					task?.provider ? h("span", {}, `\u7ebf\u8def ${task.provider}`) : null,
					item.priority > 0 ? h("span", { className: "atw-priority" }, "\u4f18\u5148") : null,
					item.updatedAt ? h("span", { className: "atw-meta-sep" }, "\u00b7") : null,
					item.updatedAt ? h("span", {}, timeAgo(item.updatedAt)) : null,
				),
				...pendingGates.map(gate => h("div", { className: "atw-gate", key: gate.id },
					h("span", { className: "atw-gate-text" }, `\u7b49\u5f85 ${gate.id} \u51b3\u7b56${item.updatedAt ? ` \u00b7 ${timeAgo(item.updatedAt)}` : ""}`),
					h("button", {
						className: "atw-btn atw-primary",
						type: "button",
						disabled: busy,
						onClick: () => onGate(gate.id, "approve"),
					}, "\u901a\u8fc7"),
					h("button", {
						className: "atw-btn atw-danger",
						type: "button",
						disabled: busy,
						onClick: () => onGate(gate.id, "reject"),
					}, "\u62d2\u7edd"),
				)),
				h("details", { className: "atw-detail" },
					h("summary", {}, "\u4efb\u52a1\u8be6\u60c5"),
					rows.length > 0
						? h("dl", { className: "atw-kv" },
							...rows.flatMap(([label, value]) => [
								h("dt", { key: `${label}-k` }, label),
								h("dd", { key: `${label}-v` }, value),
							]))
						: h("pre", { className: "atw-pre" }, JSON.stringify({ task, contract: item.contract, result: item.result }, null, 2)),
				),
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
