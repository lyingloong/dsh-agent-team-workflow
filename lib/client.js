window.__ModuleLoader__.load({
	id: "dsh-auto-workflow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;
		const STYLE_ID = "dsh-auto-workflow-styles";
		const TITLE = "工作流";
		const API = "/plugins/dsh-auto-workflow/api";

		const CSS = `
.aw-header-btn { font:inherit; font-size:12px; color:var(--dsw-alias-label-secondary,#5f6874); background:transparent; border:0; border-radius:var(--dsw-radius-sm,6px); padding:2px 6px; cursor:pointer; white-space:nowrap; text-decoration:none; }
.aw-header-btn:hover { background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08)); color:var(--dsw-alias-label-primary,#1c2128); }
.aw-header-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f7cff); outline-offset:1px; }
.aw-header-btn[disabled] { opacity:.5; cursor:default; }
`;

		let pluginCtx = null;

		async function openWorkflow(sessionId) {
			if (!sessionId) return;
			let url = "";
			try {
				const response = await fetch(`${API}/board-url?session=${encodeURIComponent(sessionId)}`, {
					cache: "no-store",
					headers: { accept: "application/json" },
				});
				const body = await response.json().catch(() => ({}));
				if (response.ok) url = typeof body?.url === "string" ? body.url : "";
			} catch {
				console.warn("dsh-auto-workflow: board URL unavailable");
			}
			let board;
			try { board = new URL(url); } catch { /* The private endpoint must return an absolute loopback URL. */ }
			if (!board || board.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(board.hostname) || board.pathname !== "/plugins/dsh-auto-workflow/board") {
				console.warn("dsh-auto-workflow: board server is not ready");
				return;
			}
			const tabs = pluginCtx?.sidebarRightTabs;
			const sidebar = pluginCtx?.get?.("sidebarRight");
			if (tabs && typeof tabs.get === "function" && tabs.get("browser") && sidebar && typeof sidebar.openTab === "function") {
				sidebar.openTab("browser", { params: { url } });
				return;
			}
			window.location.assign(url);
		}

		function OpenButton({ sessionId }) {
			if (!sessionId) return null;
			return h("button", {
				className: "aw-header-btn",
				type: "button",
				title: "打开工作流看板",
				onClick: async (event) => {
					const button = event.currentTarget;
					button.disabled = true;
					try { await openWorkflow(sessionId); }
					finally { button.disabled = false; }
				},
			}, TITLE);
		}

		function apply(ctx) {
			pluginCtx = ctx;
			ctx.effect(() => {
				if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return () => {};
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, "dsh-auto-workflow: styles");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "auto-workflow-open",
				order: 60,
			}, OpenButton));
		}

		exports.apply = apply;
		exports.inject = ["slots", "sidebarRightTabs"];
		return module.exports;
	}
});
