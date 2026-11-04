# Changelog

## 1.3.0

- Responsive graph: the node graph now measures its stage with `ResizeObserver`
  and scales to the available width/height, with a subtle grid, type accent and
  node shadow.
- Agent nodes accept an ordered `models` fallback list. On a subagent/provider
  error the executor disposes the failed attempt and tries the next model; a
  task `fail` outcome is still returned normally. The used model is recorded on
  the token.
- Panel model editor is now an ordered list with add/remove/reorder; the graph
  shows the first model plus a `+N` fallback count.
- API `POST /api/node-model` accepts `models` arrays; legacy `provider`/`model`
  still works.
- Tests at 29 passing.

## 1.2.0

- New graph-first panel: compact header, stage-sized node graph, and on-demand
  sheets for node detail, run detail/context and new-run input.
- Removed the dashboard-style hero stats, always-visible token list and context
  block; they are now behind **运行详情** or only shown for the selected node.
- Agent nodes show their current model on the graph and in the node sheet; the
  host model picker now surfaces loading/error state instead of silently
  disabling.
- Panel remains read-only for workflow structure; node config is shown as JSON.
  The session model remains the author of definitions.

## 1.1.1

- Forward an agent node's `config.cwd` to the DSH subagent request, so a workflow
  can target a repository other than the session's default directory. Relative
  paths resolve against the session cwd.
- Command/HTTP/agent nodes that return `fail` without an outgoing `on: "fail"`
  edge now fail the run with `unhandled_failure`, instead of completing the
  token and reporting `done`. Add the fail edge when the workflow handles it.
- Tests for both behaviors.

## 1.1.0

- Add a model picker to every agent node in the panel. The list comes from the
  host `llm` provider/model catalog (`GET /api/models`); selecting an entry
  saves `provider`/`model` into the node config and updates the active run
  (`POST /api/node-model`).
- Agent execution now prefers explicit `provider`/`model` over the lane's
  `adapter`/`model`; `host-default` still means "inherit the host model".
- Make `normalizeDefinition` idempotent for normalized definitions (nullable
  title/role/provider fields), which the model update route relies on.
- Keep the model picker out of non-agent nodes; command/HTTP/human nodes have no
  model selection.
- Stop surfacing internal `join` waits as human decisions. The `waiting` list
  from `team_workflow_run`, `team_workflow_status`, the panel and the Web API
  now contains only `human` node tokens; `team_workflow_decide` rejects a join
  token with `not_decidable` instead of completing the join early and skipping
  its downstream nodes.

## 1.0.0

The v2 node-graph runtime. This is an intentional breaking rewrite: the v1
stage engine, kanban board, CLI, SQLite event log and stage definitions are
removed. There is no compatibility layer or state migration.

- Workflow definitions are `apiVersion: 2` node graphs: typed nodes, outcome
  edges, provider lanes, `entry` and per-node inputs.
- Node types: `agent`, `command`, `http`, `human`, `fanout`, `join`,
  `subworkflow`.
- Data plane: `$input`, `$nodes.<id>.output`, `$item`, `$index`, `$context`;
  node outputs are stored in the run context.
- Interactions: outcome edges, parallel branches, fan-out/join
  (`all`/`any`/`quorum`), inline sub-workflows and human waits.
- Permission grants for command/HTTP with `deny`/`allowlist`/`full`; default
  deny; runtime enforcement; sub-workflows inherit the parent grant.
- Five tools: `team_workflow_define`, `start`, `run`, `decide`, `status`.
- Session JSON store (`workflow.json` + `runs/<runId>.json`) with atomic writes.
- New right-sidebar node/run panel: graph, run status, token detail, human
  decisions, permissions and context.
- New session-scoped Web API: state/start/decide/run, behind the DSH Connection
  authentication fence.
- 21 v2 tests.

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

## 0.3.0

- Add `stage.executor`: `agent` (default) or `external`. `team_workflow_delegate`
  refuses external stages; scripts and humans pull them with
  `team_workflow_claim` / `team_workflow_complete`. The board marks external
  nodes.
- Provider lanes now carry real subagent execution options: `adapter`, `model`,
  `reasoningEffort` and `maxTokens` are passed as `agentOptions` when a delegated
  stage claims that lane. `host-default` or omission inherits the host default.
  Multiple lanes, role/stage pools, least-loaded selection and provider-error
  parking/fallback remain.
- Remove instructional microcopy: the "click a node" hint, graph legend and
  session badge are gone. Graph nodes use hover/selection affordance; clicking a
  node filters the task list.
- Show how long a pending gate has been waiting in the panel.
- 118 tests.
