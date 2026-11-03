# Changelog

## 0.1.0

Initial release.

- DSH plugin with `team_workflow_*` tools and one usage section: a session can
  turn a natural-language team description into a validated workflow definition.
- Durable, append-only workflow state with rebuildable projections.
- Pull-mode lifecycle: claim, complete, fail, attempt leases and retry backoff.
- Model lanes: per-role pools, stage narrowing, least-loaded selection, and
  automatic failover when a lane reports quota/rate-limit errors.
- Manual gates and a loopback kanban board; no merge, close or push actions.
- `team_workflow_delegate` runs single-outcome tasks through host subagents.

## 0.1.1

- Project `team_workflow_gate`, `team_workflow_complete` and
  `team_workflow_fail` results onto exactly the fields their output schema
  declares. The host rejects undeclared output properties, so a successful gate
  decision could previously be reported to the model as a tool error.
- Add a host-like output-schema check to the plugin test harness so extra
  result fields fail in CI instead of at runtime.

## 0.1.2

- Rename the package and repository to `dsh-agent-team-workflow` to follow the
  DSH plugin naming convention. Tool names (`team_workflow_*`), the CLI binaries
  (`agent-team-workflow` / `atw`) and the per-workspace state directory
  (`.agent-team-workflow`) are unchanged.

## 0.1.3

- Embed the board in the DSH Web GUI: a `dsh.client` bundle registers a native
  right-sidebar tab and a conversation-header entry. The panel lists
  workspaces, renders the workflow board, approves/rejects gates and enqueues
  tasks through same-origin host routes (no iframe, no CORS).
- Host registers `/plugins/dsh-agent-team-workflow/api/workspaces|board|gate|enqueue`
  from the registered workspace list; arbitrary paths are rejected.
- The standalone loopback board remains available for headless/CLI use.

## 0.2.0

- Workflow state is now **session-scoped** under
  `<dataDir>/sessions/<sessionId>`, resolved from the DSH session id. Several
  sessions opened in the same directory get independent workflows; no state is
  written into the repository.
- Config `stateDir` is replaced by `dataDir` (default: the platform user-data
  directory). Existing workspace-local `.agent-team-workflow` state is not
  migrated.
- The embedded Web GUI panel is redesigned as a vertical node flow with a
  progress header, pending-decision banner, node cards and lane health, closer
  to the AgentTeams activity panel. The tab is session-scoped and receives its
  session id from the sidebar slot; gate decisions and enqueue use the
  session-scoped same-origin API.
- Host routes are `/plugins/dsh-agent-team-workflow/api/board|gate|enqueue` with
  a validated `session` parameter.
- Added `examples/product-team.json` (five nodes, five roles, publish gate).

## 0.2.1

- Require the DSH Connection's authentication fence on the embedded API routes.
  Requests without a Connection (or rejected by it) now get 503/401/403 instead
  of exposing or mutating workflow state. No client or UI change.

## 0.2.2

- Add a real workflow DAG to the embedded panel: stages are layered by their
  longest dependency path, transitions carry their outcome labels, `needs_revision`
  loops route around the side, and manual gates are marked on the node and edge.
  Clicking a graph node scrolls to that stage's detail list.
- Expose each stage's transitions (`on`) in the board projection so clients can
  draw the graph without parsing the definition.

## 0.2.3

- Redesign the embedded panel around an overview-first layout:
  - hero with workflow description, segmented progress bar and status legend;
  - collapsible workflow DAG with role stripes, status dots, outcome pills and
    gate markers; graph clicks filter the task list (and collapsed mode keeps
    stage shortcuts);
  - status filter chips (all/active/pending decision/done);
  - structured task cards: assignee avatar, task state, lane, priority and
    relative update time; pending gates get an inline decision box;
  - task details render known contract/result fields instead of raw JSON;
  - toast feedback for gate decisions and enqueue, loading/empty/error states,
    accessible labels and keyboard-operable graph nodes.

## 0.2.4

- Stop presenting a workflow as a batch with completion progress. The overview
  now shows a continuous runtime: a live indicator, uptime since the workflow
  definition, last activity, and workload stats (work items, in flight, pending
  decisions, cumulative completed, concurrency). No percentage or progress bar.
- Fix the DAG growing with the panel: the SVG keeps its intrinsic width, scales
  down only when the pane is narrower (`max-width: 100%`) and stays centered.
- Expose workflow `createdAt`/`updatedAt` in the board projection for uptime.
