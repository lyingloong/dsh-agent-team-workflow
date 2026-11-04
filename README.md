# dsh-agent-team-workflow

> A node-graph workflow runtime for DeepSeek Harness: agent, command, HTTP, human, fan-out/join and sub-workflow nodes, with artifacts, permissions and a live run panel.

`dsh-agent-team-workflow` is a DSH plugin. A workflow is a graph of typed nodes;
edges choose the next node from an outcome. The runtime owns scheduling and
permissions; nodes do the work.

**Status:** 1.0.0. The v2 node runtime replaces the old stage/kanban engine
entirely. There is no v1 compatibility layer, state migration or dual tool set.

## Concepts

| Term | Meaning |
| --- | --- |
| Definition | `apiVersion: 2` JSON: providers, nodes, edges, entry. |
| Node | One typed unit: `agent`, `command`, `http`, `human`, `fanout`, `join`, `subworkflow`. |
| Edge | `{from, to, on}`; `on` is an outcome, default `complete`. |
| Token | One execution of a node. A run has many tokens. |
| Run | One workflow execution with input, context and tokens. |
| Artifact / context | Node outputs stored under `context.nodes.<id>`; mapped into later nodes. |
| Permission grant | User-approved command/HTTP capability, stored with the workflow. |
| Lane | A provider route: `adapter`, `model`, `reasoningEffort`, `maxTokens`. |

State is per DSH session under `<dataDir>/sessions/<sessionId>`:

- `workflow.json` — definition + permission grant;
- `runs/<runId>.json` — token state, context, status.

Writes are atomic JSON. A host restart resumes the same run document.

## Install

```bash
# from GitHub
dsh plugin --profile desktop add github:lyingloong/dsh-agent-team-workflow

# or from a local checkout
dsh plugin --profile desktop add /absolute/path/to/dsh-agent-team-workflow

# restart the Harness process, then refresh the Web GUI
```

Package: `dsh-agent-team-workflow`. Requires Node.js >= 22.5.

## Use from a session

Describe the workflow in natural language. The model composes a definition and
calls the tools:

> 创建一个自动开发的工作流：一个实现者、一个测试命令、一个审查者；审查不通过回到实现，通过后我批准才合并。

The model will ask before granting command/HTTP access. Typical sequence:

1. `team_workflow_define` — validate and store the definition and the permission grant.
2. `team_workflow_start` — create a run with an input object.
3. `team_workflow_run` — execute ready nodes until the run waits or finishes.
4. `team_workflow_decide` — resolve a waiting human node.
5. `team_workflow_status` — inspect the definition and latest run.

### Tools

| Tool | Purpose |
| --- | --- |
| `team_workflow_define` | Validate and store a definition plus permission grant. |
| `team_workflow_start` | Create a run from an input object. |
| `team_workflow_run` | Execute ready nodes; human waits and joins pause it. |
| `team_workflow_decide` | Resolve a waiting human token. |
| `team_workflow_status` | Show definition summary and latest run. |

## Permissions

Permissions are never part of the definition. The session must ask the user
before creating a workflow that uses `command` or `http` nodes.

```json
{
  "command": { "mode": "allowlist", "allow": ["pnpm", "node"] },
  "http": { "mode": "allowlist", "allow": ["api.github.com"] }
}
```

Modes: `deny` (default), `allowlist`, `full`. The runtime checks each command
string or HTTP host before the executor runs. A denied node fails with
`permission_denied`; it is not retried. If the user does not grant access, design
a restricted workflow (agent/human/fanout/join only) or use an allowlist.

## Definition

```json
{
  "apiVersion": 2,
  "name": "dev-team",
  "entry": "seed",
  "providers": [
    { "id": "default", "adapter": "deepseek", "model": "host-default" }
  ],
  "nodes": [
    { "id": "seed", "type": "human", "config": { "outcomes": ["approve", "reject"] } },
    {
      "id": "implement",
      "type": "agent",
      "role": "engineer",
      "inputs": { "request": "$input.request" },
      "config": { "lane": "default", "prompt": "Implement the request." }
    },
    {
      "id": "test",
      "type": "command",
      "config": { "command": "pnpm test", "timeoutMs": 300000 }
    },
    {
      "id": "review",
      "type": "agent",
      "role": "reviewer",
      "inputs": { "implementation": "$nodes.implement.output", "tests": "$nodes.test.output" },
      "config": { "outcomes": ["pass", "needs_revision"], "prompt": "Review the change." }
    },
    { "id": "merge", "type": "human", "config": { "outcomes": ["approve", "reject"] } }
  ],
  "edges": [
    { "from": "seed", "to": "implement", "on": "approve" },
    { "from": "implement", "to": "test", "on": "complete" },
    { "from": "test", "to": "review", "on": "complete" },
    { "from": "review", "to": "merge", "on": "pass" },
    { "from": "review", "to": "implement", "on": "needs_revision" }
  ]
}
```

### Node types

| Type | Config | Behavior |
| --- | --- | --- |
| `agent` | `role?`, `prompt?`, `lane?`, `provider?`, `model?`, `models?`, `cwd?`, `outcomes?`, `outcome?` | Spawns a DSH subagent. The child returns JSON `{outcome, output}`; plain text becomes `{text}`. |
| `command` | `command`, `cwd?`, `timeoutMs?` | Runs a shell command in the session cwd. Exit 0 → `complete`; non-zero → `fail`. |
| `http` | `url`, `method?`, `headers?`, `body?`, `timeoutMs?` | `fetch`; 2xx → `complete`, otherwise `fail`. |
| `human` | `title?`, `outcomes?` | Waits for `team_workflow_decide` or the panel. Default outcomes: `approve`, `reject`. |
| `fanout` | `items`, `target`, `join` | Resolves `items` to an array and creates one branch token at `target`; each branch receives `$item` and `$index`. |
| `join` | `mode: all\|any\|quorum`, `count?` | Aggregates branch outputs; `all` waits for every branch. |
| `subworkflow` | `definition` | Runs an inline nested definition and exposes its context as the node output. |

Agent nodes use the lane's `adapter/model/reasoningEffort/maxTokens` as subagent
`agentOptions`. `model: "host-default"` inherits the host model. An explicit
`provider`/`model` on the node overrides the lane and is what the panel writes
when you pick a model. `cwd` is forwarded to the subagent as its starting
directory; relative paths resolve against the session working directory.

An agent node can instead carry an ordered `models` fallback list:

```json
"models": [
  { "provider": "provider-a", "model": "model-1" },
  { "provider": "provider-b", "model": "model-2" }
]
```

The executor tries them in order on a subagent/provider error; a task `fail`
outcome is not a provider error and is returned as the node outcome. The panel
edits this list with add/remove/reorder controls.

A command exits 0 for `complete` and non-zero for `fail`. A `fail` outcome must
have an outgoing `on: "fail"` edge; otherwise the run itself fails with
`unhandled_failure` instead of silently reporting `done`.

### Inputs and outputs

Values in `inputs` are resolved from:

- `$input` — the run input object;
- `$nodes.<id>.output` — a previous node's output;
- `$item`, `$index` — fan-out branch values;
- `$context` — the whole run context.

A completed node's output is stored at `context.nodes.<id>` and is available to
later nodes. The join node's output is an array of branch records:
`[{branch, outcome, output}, ...]`.

### Edges

An edge is taken when the node outcome equals `on`. No matching edge makes the
token terminal. Several edges with the same outcome create parallel branches.
Agent nodes can return one of their configured `outcomes`, which makes review
pass/fail loops ordinary graph edges.

## Fan-out / join

```json
{
  "id": "split",
  "type": "fanout",
  "config": { "items": "$input.items", "target": "work", "join": "join" }
}
```

Start with `{"items": [1, 2, 3]}`. The fanout node creates three tokens at
`work`; each sees `$item` and `$index`. `join` waits according to its mode, then
its output is the aggregated branch array.

A join waits internally for its branches; that wait is not a human decision. The
`waiting` list from `team_workflow_run`, `team_workflow_status`, the panel and the
Web API contains only `human` node tokens, and `team_workflow_decide` rejects a
join token with `not_decidable`.

## Sub-workflow

```json
{
  "id": "child",
  "type": "subworkflow",
  "inputs": { "value": "$input.value" },
  "config": { "definition": { "apiVersion": 2, "name": "child", "entry": "work", "nodes": [], "edges": [] } }
}
```

The nested run shares the parent's permission grant and executors. A nested
human wait is currently not supported: the child must reach `done` before the
subworkflow node completes.

## Auto-dev reference

[examples/auto-dev.json](examples/auto-dev.json) is a complete requirement→PR→
user-decision flow:

`discover` → `branch` → `implement` → `npm test` → `review`
(→ implement on `needs_revision`) → open PR → human decision → merge.

It requires a command grant for `npm` and `gh`, a configured `gh` login, and a
session whose cwd is the target repository. The flow is serial: a `team_workflow_run`
call executes it until the human node; the panel or another run call continues
after the decision. `gh pr create` is intentionally one-shot in this example;
re-running on a branch that already has a PR fails the `pr` node.

This is a single-seed flow. A persistent public seed pool and a pending-PR pool
are not runtime primitives yet: each run starts from its input, and human
decisions are per run. Use one run per seed until those queue primitives land.

## Web panel

The right-sidebar **工作流** tab is graph-first:

- a compact header with workflow name, run status, node/edge count and
  permission state;
- the node graph, which scales to the available pane size; each node type has
  its own glyph, tint, border and type label; orthogonal edges route around
  nodes, labels sit beside lines, and long titles wrap to two lines;
- waiting human decisions with outcome buttons;
- clicking a node opens a sheet with its latest token, output, errors and raw
  config; agent nodes include an ordered model fallback list with add/remove/
  reorder controls;
- **运行详情** opens the token log and run context; **新运行** opens the input
  composer; **继续运行** advances a waiting/running run.

The panel deliberately stays an observer/light controller, not a workflow
builder: the session model authors definitions through the tools. It can only
run a session whose Agent has been observed by a tool call; after a host restart,
run once from the assistant or call a tool first.

## Standalone board URL

The same board is available as an optional browser page:

```
<Harness origin>/plugins/dsh-agent-team-workflow/board?session=<session-id>
```

`team_workflow_status` returns this as `boardUrl`. It is same-origin and uses the
DSH Connection authentication fence; it is not a second server or port. The page
can view the graph, node details, waiting decisions, start a run and continue a
run (the latter uses the last Agent observed for that session, same as the side
panel).

## Development

```bash
npm test                         # v2 tests in one process
node --test "tests/*.test.mjs"   # standard runner
```

Coverage: definition/runtime/store, DSH tools, panel web API and client bundle.
No v1 tests or code remain; see [AGENTS.md](AGENTS.md).

## Security

- `command` and `http` are privileged. Default deny; grant only what the user
  approved.
- `command` runs in the session working directory with a timeout and a bounded
  output buffer. It is not a sandbox; a `full` grant is real host execution.
- The panel API is same-origin and requires the DSH Connection authentication
  fence. It only reads/writes the session data directory.
- `subworkflow` inherits the parent's grant; it cannot widen permissions.

## License

MIT
