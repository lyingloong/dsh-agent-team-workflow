# agent-team-workflow

> A resumable, provider-aware workflow engine and kanban board for agent teams.

`agent-team-workflow` turns "a bunch of coding agents" into a workflow you can
trust over days: roles with capacity, a durable event log, model lanes with
automatic failover, gates that record decisions instead of taking them, and a
local board that shows the real projected state.

**Status:** engine, pull-mode coordination, the local board, and the DSH plugin
adapter (P1–P4). Optional forge observation lands next. The engine imports no
host, model vendor or forge — the DSH adapter talks to the host only through
`ctx` services.

## Why another agent orchestrator

The 2026 tooling wave (Vibe Kanban, Conductor, Claude Squad, MulmoTerminal,
agent-orchestrator, …) mostly solves *running* agents: parallel sessions,
worktrees, diffs, a board. Those are the floor, not the differentiator.

`agent-team-workflow` keeps the part that is hard to get right once a team runs
unattended:

- **Every write is an event.** Projections rebuild from the log, so a crash
  cannot leave the scheduler believing a task is assigned when it is not.
- **Roles, slots and lanes are first-class.** "3 accounts × 3 roles, 9 active
  tasks, switch lanes when one quota runs out" is configuration, not a fork.
- **One live coordinator per data directory.** A second process fails loudly
  instead of double-dispatching.
- **No fake work.** When nothing is ready, the planner returns nothing. Idle
  roles are a signal, never a reason to invent a task.
- **Gates never act.** A gate records "waiting for an external signal" or
  "approved by a human". Merging, closing a PR and pushing stay outside.

## Concepts

| Term | Meaning |
| --- | --- |
| Definition | JSON data: roles, providers, stages, gates, sources, policies. |
| Role | A kind of worker with `instances`, `capacity` and a provider pool. |
| Stage | A unit of work a role performs, with allowed outcomes and transitions. |
| Item | A unit of work flowing through stages (a seed, requirement, point, …). |
| Task | The executable unit for one stage of one item. |
| Attempt | One execution of a task, bound to a member, a lane and a lease. |
| Gate | A decision point that pauses an item; it never merges or closes. |
| Provider | A model lane with concurrency, watermark and failover backoff. |
| Slot | One capacity unit of a role; a slot runs at most one task. |

## Quick start

Requires Node.js >= 22.5 (`node:sqlite`). The engine prints Node's experimental
SQLite warning; it is expected on current releases.

```bash
node src/cli.mjs init                 # write workflow.json (bundled dev-team example)
node src/cli.mjs define workflow.json
node src/cli.mjs board                # http://127.0.0.1:7171/
```

From an installed package the same commands are `agent-team-workflow` or the
short alias `atw`.

Validate and inspect without starting anything:

```bash
node src/cli.mjs validate workflow.json
node src/cli.mjs status
node src/cli.mjs roster
```

Run the tests:

```bash
npm test                 # one process, no child spawn
node --test tests/       # standard runner with per-file isolation
```

## Use as a DSH plugin

Install into a DSH profile (the path that gives sessions the `team_workflow_*`
tools and the usage section):

```bash
dsh plugin --profile desktop add /absolute/path/to/plugins/agent-team-workflow
# restart that profile's Harness process, then refresh the Web GUI
```

[cordis.patch.yml](cordis.patch.yml) mounts the plugin. In any session, describe
the workflow in natural language:

> 创建一个自动开发的工作流：三个需求师、三个工程师、三个审查师，三条模型线路；审查通过后需要我批准才能合并。

The model translates that into a definition and calls `team_workflow_define`;
the result includes a validation summary and the board URL. Reply "开始" to let
it enqueue work and delegate tasks.

| Tool | Purpose |
| --- | --- |
| `team_workflow_define` | Create or replace the workspace workflow from JSON the model composes. |
| `team_workflow_status` | Projected counts, stage columns, lane health, pending gates, board URL. |
| `team_workflow_board` | Start (or return) the local board. |
| `team_workflow_enqueue` | Create an item at the entry stage. |
| `team_workflow_plan` | Read-only ready tasks and pending gates. |
| `team_workflow_claim` | Claim one task for a role (external worker path). |
| `team_workflow_complete` | Report a stage outcome; advance, pause on a gate, or finish. |
| `team_workflow_fail` | Report failure; lane parking and retry backoff. |
| `team_workflow_gate` | Approve or reject a pending gate. |
| `team_workflow_delegate` | Claim a single-outcome task, spawn a subagent to do it, record the result. |

`team_workflow_delegate` is fire-and-forget: it returns once the child starts and
the plugin records completion when that child settles. Poll
`team_workflow_status` for progress. Stages with several outcomes (for example a
review with `pass` / `needs_revision`) are decided explicitly with
`team_workflow_complete` or `team_workflow_gate`.

Configuration (profile patch):

| Key | Default | Meaning |
| --- | --- | --- |
| `stateDir` | `.agent-team-workflow` | Per-workspace state directory (relative to the session cwd). |
| `boardPort` | `7171` | Board port; falls back to an ephemeral port when busy. |
| `autoBoard` | `true` | Start/restart the board after `team_workflow_define`. |
| `subagentProvider` | `spawn` | Subagent provider used by `team_workflow_delegate`. |

The board and CLI read the same workspace directory:

```bash
atw board --data .agent-team-workflow
atw status --data .agent-team-workflow
```

## Board

`board` serves a local page plus a small JSON API. It binds to `127.0.0.1` by
default and has no authentication because it is loopback-only.

```bash
node src/cli.mjs board --port 7171
```

- Columns are the workflow stages in traversal order; cards are items.
- A card shows its current task, member, lane and attempt count; details expand
  to the task contract and result.
- Pending gates appear both on the card and in **待决策**, with approve/reject
  actions that append events. There is no merge, close or push action.
- **模型线路** shows lane health, active/concurrency and the blocked-until time.
- The page polls every 3 seconds (paused when the tab is hidden); only the JSON
  projection is read.

API: `GET /api/board`, `POST /api/gate`, `POST /api/enqueue`,
`POST /api/expire`, `GET /api/health`.

## How work runs

The engine does not start agents. A worker pulls work, does it, and reports back:

```bash
node src/cli.mjs enqueue "Add retry to the uploader" --input '{"prompt":"..."}' --json
node src/cli.mjs claim --role engineer --member engineer-1 --json
node src/cli.mjs complete --attempt attempt-… --outcome complete --result '{"summary":"…"}'
# or, when the attempt failed:
node src/cli.mjs fail --attempt attempt-… --error "tests failed"
```

- `claim` runs admission, task selection and the attempt write in one SQLite
  transaction; two workers cannot both claim past a free slot.
- An attempt is a capability: only its holder can complete or fail that task,
  and repeating the same call is a no-op.
- A crashed worker leaves a lease behind. `expire` (or the board's reaper) fails
  those attempts and releases the task with the policy's backoff.
- A blocking gate pauses the item after the stage completes; approving advances
  it, rejecting blocks it for a human.

## Providers and failover

Each role may list several providers, and a stage may narrow that pool:

```json
{
  "roles": [
    { "id": "engineer", "instances": 3, "providers": ["lane-a", "lane-b", "lane-c"] }
  ],
  "stages": [
    { "id": "implement", "role": "engineer", "providers": ["lane-a", "lane-b"] }
  ]
}
```

- `claim` without `--provider` picks the **least-loaded healthy lane** in the
  allowed pool, so a lane is chosen per task rather than pinned to a worker.
- `claim --provider lane-a` is an explicit request. A blocked or over-capacity
  lane is refused with an actionable error; it is never silently replaced.
- `fail` classifies quota/rate-limit/timeout errors (429, 402, 5xx, `quota`,
  `rate limit`, `timed out`, …) and parks that lane until
  `now + backoffMinutes[0]`. The task is released immediately, so the next
  claim moves it to another lane. Use `--provider-error` to force this for a
  message the heuristic does not recognize.
- A parked lane becomes usable again when `blockedUntil` passes; the board and
  `status` report it as healthy at that point. Keys are never rotated.

## Definition

```json
{
  "apiVersion": 1,
  "name": "dev-team",
  "roles": [
    { "id": "analyst",  "instances": 3, "providers": ["lane-a", "lane-b", "lane-c"] },
    { "id": "engineer", "instances": 3, "providers": ["lane-a", "lane-b", "lane-c"] },
    { "id": "reviewer", "instances": 3, "providers": ["lane-a", "lane-b", "lane-c"] }
  ],
  "providers": [
    { "id": "lane-a", "model": "deepseek-flash", "concurrency": 3, "backoffMinutes": [10, 30, 60] },
    { "id": "lane-b", "model": "deepseek-flash", "concurrency": 3, "backoffMinutes": [10, 30, 60] },
    { "id": "lane-c", "model": "deepseek-flash", "concurrency": 3, "backoffMinutes": [10, 30, 60] }
  ],
  "stages": [
    { "id": "specify",   "role": "analyst",  "on": { "complete": "implement" } },
    { "id": "implement", "role": "engineer", "on": { "complete": "review" } },
    { "id": "review",    "role": "reviewer", "options": ["pass", "needs_revision"],
      "on": { "pass": "approved", "needs_revision": "implement" } },
    { "id": "approved",  "role": "reviewer" }
  ],
  "gates": [
    { "id": "merge", "after": "review", "outcome": "pass", "kind": "manual" }
  ],
  "policies": {
    "concurrency": { "global": 9 },
    "fallback": { "sameRole": true },
    "retry": { "maxAttempts": 3, "backoffSeconds": [30, 120, 300] }
  }
}
```

- `entry` defaults to the first stage. A stage without `on` transitions is
  terminal, and a definition must declare at least one.
- `on` maps an outcome to the next stage. If `options` is omitted, its keys are
  the allowed outcomes; if present, every `on` key must be declared.
- A gate may target one outcome (`outcome: "pass"`), so a review loop does not
  trigger the merge decision on `needs_revision`.
- Definitions are stored as authored and validated again on load, so a model
  can revise one and a human can review the diff.

## Guarantees

- The event log is the only write path; projections are derived and rebuildable.
- `claim` is atomic across processes; a member cannot exceed its per-member
  capacity, and a role cannot exceed its total slots.
- Provider `degraded` stops *new* dispatch; `blocked` expires at `blockedUntil`.
  Existing tasks are left alone.
- Gates only record decisions. No merge, close, push or branch rewrite exists in
  the engine or the board.
- The single-instance lock is stale-aware: a dead process on the same host or an
  old heartbeat can be taken over.
- No credentials are read or stored. Providers are ids; hosts own secrets.

## CLI reference

| Command | Purpose |
| --- | --- |
| `init [file]` | Write the bundled dev-team workflow (refuses to overwrite). |
| `validate <file>` | Validate and summarize a definition. |
| `define <file>` | Record the definition in the event log (takes the lock). |
| `status` / `roster` | Projected counts, slots, lanes and attention items. |
| `board` | Serve the kanban board and JSON API. |
| `enqueue` | Create an item at the entry stage. |
| `claim` | Claim the next ready task for a role (optionally a lane). |
| `complete` / `fail` | Report an attempt, advance or retry. |
| `gate` | Approve or reject a pending gate. |
| `expire` | Reap attempts whose lease expired. |
| `events` / `rebuild` | Inspect or replay the event log. |
| `simulate` | Run the scheduler over synthetic tasks. |

## State location

Default: `%LOCALAPPDATA%\agent-team-workflow` (Windows),
`~/Library/Application Support/agent-team-workflow` (macOS),
`$XDG_DATA_HOME/agent-team-workflow` or `~/.local/share/agent-team-workflow`
(Linux). Override with `--data DIR` or `AGENT_TEAM_WORKFLOW_DATA`. A
repository-local `.agent-team-workflow/` is reserved for exports; it is never
the source of truth.

## Roadmap

| Phase | Scope |
| --- | --- |
| P1 | Definition schema, event store, lock, roster/status, scheduler simulation — **done** |
| P2 | Pull-mode lifecycle, attempt leases, retry backoff, gates, recovery — **done** |
| P3 | Provider failover, local kanban board, workflow scaffolding — **done** |
| P4 | DSH plugin: `team_workflow_*` tools, usage section, subagent delegation — **done** |
| P5 | Optional forge observation (PR/CI facts; still no merge) |
| P6 | Docs, CI, publish to npm / standalone repository |

## License

MIT. See [LICENSE](LICENSE).
