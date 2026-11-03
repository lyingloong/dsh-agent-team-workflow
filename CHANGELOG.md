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
