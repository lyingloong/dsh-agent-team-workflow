# Run lifecycle and startup troubleshooting

## Diagnose before retrying

`team_workflow_status` is read-only. Inspect `cwd`, `current`, `jobId`, `execution.active`, `updatedAt`, `counts`, and `error`. A workflow that looks stationary can actually be performing repeated repair steps; the board must show persisted node progress, not merely a spinner while one long request waits.

The startup incident fixed here was not a proven subagent-service deadlock: the saved run completed intake/register/plan, then repeatedly ran `npm test` in the original session project rather than the intended plugin repository. The original project had no root `package.json`. Seven failed verification attempts returned to implementation before cancellation. The old implementation saved only when the whole run returned, hid the intermediate failures from the board, and labeled cancellation as a model failure.

Do **not** blindly restart that failed run. Files, branches and PRs may already have changed. Inspect both the intended and accidentally selected repositories. This repair does not delete/revert those artifacts or clear historical runs.

## Bind the repository once

```json
{"cwd":"/absolute/path/to/target-repository","input":{"source":"user","requirement":{"id":"docs-1","title":"Normalize repository documentation"}}}
```

Pass that object to `team_workflow_start`. If `cwd` is omitted, the plugin uses the installed `workingDirectory` service's effective directory, not `session.header.cwd` (original session metadata). The canonical absolute result is persisted on the run and returned to the caller. Later shell `cd` commands/session directory changes do not retarget an existing run.

Agent cwd, command cwd, relative node cwd overrides and queue discovery derive from this bound directory. This is targeting, **not** a filesystem security sandbox. Before admitting any job, preflight validates directories and direct `npm test`/`npm run` manifests; missing manifests or missing `scripts.test` are configuration errors, not instructions to keep editing application code.

Historical unbound runs are not guessed/migrated to the current project. Preserve them as evidence and deliberately start a new correctly bound run after inspecting prior effects.

## Nonblocking, session-owned execution

`team_workflow_run` dispatches a DSH managed job and returns a receipt immediately. It does not hold the tool/HTTP response until every model and command finishes. The private and token-protected board run endpoints return HTTP 202 for an accepted job. A duplicate Run request returns the same active job rather than starting a second driver.

Use `team_workflow_status` for node checkpoints and the board URL. Use native `job_output` for the managed job result; `job_kill` or the board's **停止当前执行** requests cancellation. Accepted work is not tied to the HTTP request or the caller's temporary wait signal. It remains tied to the owning DSH session and plugin/service lifecycle. There is no promise that an in-memory job survives application shutdown or owner disposal.

The shared runner admits only one job per session. Start/define/model-change/decision mutations are rejected while that job owns the run. Control changes remain allowed so a live run can pause. Completion, cancellation and errors settle the job only after executor cleanup and the final checkpoint.

## Persistence and recovery

- Save `running` before launching each node, then save its result and successor tokens.
- Persist child session/model information as soon as a subagent is admitted; nested runs are attached to the parent token before execution.
- Every executor uses the run-owned cancellation signal. Every acquired subagent activation is released in `finally`, including success.
- Agent deadline defaults to 10 minutes. `agentTimeoutMs` config or a node's `config.timeoutMs` can override it. Cancellation is `execution_aborted`, not a reason to try another model.
- A node returning `fail`/`needs_revision` repeatedly has a default budget of 3 failures (`config.maxFailures` overrides). The last output/error remains inspectable when the circuit breaker stops the chain.
- A step-budget limit yields a resumable `paused` run; it is not a terminal failure.
- `failed` and `interrupted` runs do not execute a hidden extra ready token when Run is clicked again.
- A persisted running marker with no live host job is reported as interrupted/unknown. A still-live native job is not declared orphaned merely because a local map is empty. No uncertain command or agent action is automatically replayed.
- Atomic snapshots protect a single write; the runner supplies execution ownership. This is a single-host coordinator, not a distributed lock or an exactly-once transaction across Git/GitHub.

## Pause, cycles and feedback

The continuous switch is re-read at every node boundary, including implementation/review loops. Turning it off allows the current node to drain, then stops before the next one. It does not forcibly roll back an executing command. Use Stop for explicit cancellation; inspect effects before retrying.

An explicit gate `config.newCycle: true` starts a fresh per-item node-result context. On later passes, `config.consumeInput` names the one-shot top-level request fields to remove; `goal` and `poolPath` can remain. Other backedges retain same-item review context. The example passes test evidence explicitly to implementation and passes a selected mined queue record to the analyst rather than silently discarding it.

The repository requirement/seed pool is still prompt-managed data, not an atomic multi-worker queue. The auto-dev example's fixed Git branch/PR commands must be reviewed for the actual target repository before unattended multi-item use. This incident fix does not certify automatic merging or run that example against user work.

## Verification

Tests cover nonblocking 202 responses, deferred model results, live checkpoint reads, concurrent tool/API admission, guarded model/decision writes, safe pause/resume, command cwd preflight, path traversal rejection, native cancellation ownership, disposal, deadlines, fail-closed routing output, failure budgets, step-budget yielding, cycle isolation and nested snapshots. Mocked executors and temporary directories prevent these tests from editing the real project or opening PRs.
