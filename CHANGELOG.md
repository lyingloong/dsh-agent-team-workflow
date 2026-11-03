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
