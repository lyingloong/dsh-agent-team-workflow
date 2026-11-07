# GitHub 项目本地持续开发

这是 `dsh-auto-workflow`（短名 Auto Workflow）的**唯一主示例**：克隆 GitHub 项目，在本地持续处理真实需求，经模型审查与 Human merge 门禁后集成。示例是应用代码，插件只提供通用调度；没有远端 Issue/PR 服务、聊天监听器或外部审批端点。

**阅读文档不会启动任何操作。** 下面是供操作者检查、替换路径并明确授权后执行的说明，不是对当前仓库或远端的自动操作。首次使用先看 [项目首页](<../../../README.md>)；业务不变量集中在 [流程与保证](<../../workflow-summary.md>)。

## 组件与准备条件

| 组件 | 职责 |
| --- | --- |
| [workflow.json](<workflow.json>) | 一个 run 中的周期 producer、detached 分支、3+3 工作池与 Human 门禁。 |
| [store.mjs](<store.mjs>) | 稳定 ID、优先级/FIFO、claim、revision/epoch、审批与反馈。 |
| [worktrees.mjs](<worktrees.mjs>) | detached worktree、不可变快照/review、本地集成、恢复与受限清理。 |
| [driver.mjs](<driver.mjs>) | command 节点使用的 JSON-only CLI。 |

开始前逐项确认：

- Node.js 22.5+、Git、已安装的插件以及可用模型路由。agent 能在指定 worktree 读写、运行项目实际验证命令并本地提交；reviewer 只读审查，不改代码或提交。
- 目标是已有提交的非 bare 仓库，有本地 Git author identity；自行处理项目 hooks、签名和依赖。示例不会替你禁用 hooks 或配置仓库身份。
- 选择一个**项目及其 worktree 外部**的绝对、canonical `dataRoot`，不使用 symlink/junction 别名。每个目标仓库只用一个 store，integration lock 不是全机器/跨 store 锁。
- 集成 checkout 始终处于配置的 `baseBranch`，干净且无进行中的 merge。运行期间不要由其他工具同时改动它。
- 检查图里的 agent prompts，补充目标项目的实际验证命令和限制。示例未固定 provider/model，使用 Host 配置；如需有序候选，按 [插件参考](<../../plugin-summary.md>) 设置 `config.models`。模型任务默认没有截止时间。
- command/HTTP 默认 deny，先获得用户明确批准；agent 的工具权限另行配置，命令 allowlist 不会替 agent 建立文件系统沙箱。

## 1. 克隆项目并 materialize 示例

以下 PowerShell 示例使用虚构路径和 `OWNER/PROJECT` 占位符，请先替换。克隆属于明确授权的准备工作；图本身不访问 GitHub。

```powershell
git clone https://github.com/OWNER/PROJECT.git C:/work/project
Set-Location C:/work/project
git switch -c integration/workflow-batch
```

`integration/workflow-batch` 是**一个共享的本地集成批次分支**。后续 store 的 `baseBranch` 指向它，不是每需求建立一个分支；也不假设可以直接 push 受保护的 `main`。已有仓库可在检查干净状态后选用已有的本地集成分支，无需重新 clone。

从固定 v1.0.0 的源码 checkout 或解压后的发行包取得上表四个文件。安装插件不等于把它们放进业务项目；需要明确复制到图使用的相同路径。若目标已有同名文件，先比较，**不要直接覆盖**。

```powershell
$ExampleSource = 'C:/work/auto-workflow-release/docs/examples/development'
New-Item -ItemType Directory -Force docs/examples/development | Out-Null
Copy-Item "$ExampleSource/driver.mjs", "$ExampleSource/store.mjs", "$ExampleSource/worktrees.mjs", "$ExampleSource/workflow.json" -Destination docs/examples/development
# 检查脚本和提示词，补充项目验证要求后，仅本地提交这些文件
git add -- docs/examples/development
git commit -m "Add local development workflow"
git status --porcelain
```

最后一条应无输出；确认脚本已进入基线提交、工作区干净，再开始业务执行。示例模块只依赖 Node.js 内置模块；项目自身的依赖、构建和验证仍需准备。

command 节点执行的是固定命令，例如 `node docs/examples/development/driver.mjs prepare`，其 cwd 为**绑定的项目根目录**。不存在 `${input...}` shell 插值。agent 的 cwd 由小 envelope 指向各需求 worktree。run 创建后不可更换绑定项目。

## 2. 初始化数据并提交真实输入

继续在目标项目根目录运行；以下 `dataRoot` 与项目并列，位于项目外：

```powershell
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data","repoRoot":"C:/work/project","baseBranch":"integration/workflow-batch","cleanupPolicy":"retain"}'
node docs/examples/development/driver.mjs init
```

配置一经初始化不可静默更换。`retain` 是安全默认值，**合并后也保留 worktree**。业务 store 采用 `version: 2`，不等于包版本；旧 store 被拒绝，不迁移或重置。为新格式使用新 canonical root，并保留旧数据检查。

### 用户 intake

只有获得授权的用户/调用者应提交用户需求；示例不扫描全部聊天：

```powershell
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data","requirement":{"id":"req-example","source":"user","title":"Concrete requested change","description":"Expected behavior and acceptance checks.","risk":"high","tags":["user"]}}'
node docs/examples/development/driver.mjs requirement
```

- ID 形如 `req-<slug>` / `seed-<slug>`；slug 为小写 ASCII 字母/数字开头，仅含字母、数字、`_`、`-`，最长 64 字符。拒绝路径穿越、扩展名/流字符和大小写碰撞风险。
- 用户 priority 强制为 `0`，即使风险 high 也跳过**需求审批**；实现 review 和 Human merge 门禁不跳过。
- 队列按用户优先、priority、原始 FIFO、稳定 ID 准入。小的 priority 更早；已领取工作不被抢占。
- 修改 queued 项时，在 `requirement` 对象中携带当前 `expectedRevision`，沿用同 ID、递增 revision 且保留 FIFO。已领取/执行项不能 intake 覆盖，应走反馈返修。

### 已有证据 seed

```powershell
$env:DSH_WORKFLOW_INPUT = '{"dataRoot":"C:/work/project-workflow-data","seed":{"id":"seed-edge-case","title":"Evidence of an edge case","evidence":"A reproducible observation and relevant source/test locations.","tags":["reliability"]}}'
node docs/examples/development/driver.mjs seed
```

miner 只消费这些实际 seed，读取项目后提出一个具体需求，priority 为 `1..9`。`seed-edge-case` 对应稳定需求 `req-edge-case`；与无关已有需求冲突时失败而非覆盖。没有可行动建议时返回 `proposal:null`，该 seed 记为 idle，不反复调用模型或制造假需求。

**没有 GitHub Issue 自动抓取、外部发现 feed 或全聊天监听。** 后续 seed/用户需求仍由授权调用者显式提供。

## 3. 定义、运行并只启动一个 producer

在 DSH 会话中使用实际安装的 `auto_workflow_*` 工具。向 `auto_workflow_define` 传入完整 [示例图](<workflow.json>)；先向用户说明 driver 可执行本地 Git 副作用并取得批准，然后传入受限 permissions：

```json
{
  "command": {
    "mode": "allowlist",
    "allow": ["node docs/examples/development/driver.mjs"]
  },
  "http": { "mode": "deny", "allow": [] }
}
```

该授权信任整个 driver，不是只读授权，也不是文件系统沙箱。图不能给自己扩权；agent 工具策略须单独确认。

调用 `auto_workflow_start`：

```json
{
  "cwd": "C:/work/project",
  "input": { "dataRoot": "C:/work/project-workflow-data" }
}
```

再调用 `auto_workflow_run`。默认 `dispatch` 只领取最多三项已有需求，detached fan-out 到 `route`，属于有限入口。要持续运行，向同一 run **仅 enqueue 一个** producer：

```json
{
  "nodeId": "mine-gate",
  "input": { "dataRoot": "C:/work/project-workflow-data" }
}
```

上面的 JSON 是 `auto_workflow_enqueue` 参数。producer 第一次与后续每轮都经过 60 秒延迟：

```text
mine-gate → seed-batch → seed-fanout(detached → miner)
                     → producer-dispatch → producer-work(detached → route)
                     → mine-gate
```

无 seed 时跳过模型，但仍检查需求队列。miner 晚于本轮 dispatch 完成，其新需求可在下一轮领取。Human 等待与慢 worker 不牵住 detached producer。**每次按 Run 不要重复 enqueue producer。**

新增用户需求后，如需立即准入，可 enqueue `nodeId:"dispatch"`、`input:{"dataRoot":"C:/work/project-workflow-data"}`；否则现有 producer 在后续周期领取。有限 dispatch 不会产生新的持续 producer。

## 4. 开发、review 与 Human merge 门禁

根 `concurrency:6` 被所有节点共享。一个 engineer 节点有三个槽，一个 reviewer 节点有三个槽；**每需求仅一位 reviewer**。命令/miner 也占根容量，不是六个模型槽之外另有无限开销。

1. `route` 让用户需求、挖掘 low 进入准备；挖掘 mid/high 进入 `requirement-human`。Human `reject` 必须有反馈，后续命令落盘后由 analyst 修订**同一个 ID**，递增需求 revision 再评估风险。
2. `prepare` 创建并保存 detached `worktreePath` 和 `baseRevision`。没有每需求分支。所有初次开发与返修先经 `begin-engineering`：校验当前 revision/旧 epoch，消耗 admission 并增加 `engineeringEpoch`。
3. engineer 在该 worktree 内实现、运行项目实际验证、提交干净的本地 commit；不得 merge、push、删除 worktree 或编辑业务 JSON。
4. `snapshot` 使用冻结的 `begin-engineering` 输出校验 revision/epoch，预留 `snapshot-pending` 意图，再冻结 commit/tree/验证说明为不可变 artifact。不能在旧模型回复到达时临时读取新 revision 来绕过校验。
5. 一位 reviewer 检查精确 artifact/commit 并验证，不改 worktree。`record-review` 复验干净 HEAD 并写入不可变 review。`revise` 先落盘，再回同 ID/worktree 的下一工程轮；有效返修不触发模型回退或通用失败预算，示例未设置自动业务返修上限。
6. `pass` 后进入 `merge-human`。Human 等待不占 engineer/reviewer 槽，其他 packet 和 producer 仍可继续。

通过看板或 `auto_workflow_decide` 选择当前 token 声明的 outcome。反馈 output 示例：

```json
{ "note": "Narrow the change and add regression coverage.", "actor": "human" }
```

| `merge-human` outcome | 后果 |
| --- | --- |
| `approve` | 批准精确需求 revision、artifact 和 commit，然后本地集成。 |
| `revise` | 必须反馈；同 ID/worktree 返修，新快照、新 review 后再审批。 |
| `reject` | 必须反馈；标记拒绝，保留 worktree/产物，不合并、不隐式重试。 |

Human 引擎决定由后续 command 转成业务记录；旧需求 revision 的回应不能批准新规格。不要用新 packet 代替待处理决定，也不要把有效拒绝当成换模型的理由。完整身份与修订约束见 [流程与保证](<../../workflow-summary.md>)。

## 5. 本地集成、冲突与远端边界

`integrate` 节点并发为 1，另有 store 级 integration lock。执行前必须有当前 artifact 的通过 review 和 Human 批准、原本干净的需求 HEAD，以及位于配置 baseBranch 的干净集成 checkout。

合并前枚举 ignored 数据，检查它与批准 tree 的路径碰撞，包括文件/目录前缀以及适用时的大小写折叠；有碰撞则保留目标和数据，不执行 merge。先自行保存/移动这些数据，再显式重试。

正常路径只执行本地 `git merge --no-ff --no-edit <approved commit>`。成功后复验干净 checkout 和已批准 commit 的祖先关系，记录 `merged` / `integration.state:verified`。Git hooks 仍是可信项目代码；不要同时外部修改目标。

若发生冲突或不确定失败，保留需求 worktree 和目标 merge 现场，进入 `conflict-human`。不会自动 abort、reset、强制 checkout、删除或重试。其他开发/review 可以继续，但共享目标必须先恢复，后续集成才能安全进行：

- **resolved**：授权操作者手工解决冲突、运行验证并完成 merge commit，再提交 `resolved` 与说明。恢复命令验证无 pending merge、干净目标、批准 artifact 和祖先关系。
- **aborted**：检查现场后显式手工 abort，再提交 `aborted` 与反馈。恢复命令确认干净、无 merge 且批准 commit 未集成，清除旧 merge approval，保留同 ID/worktree 回到开发；仍须新 snapshot、review 和批准。

其他项若因共享目标不干净而失败，不自动重放。先查其运行与业务状态，再明确选择续接阶段。

**本图不 push、不开 PR、不远端 merge、不部署。** 如要把成果交到 GitHub，先复核整个 `integration/workflow-batch`，取得针对具体 remote/branch/操作的明确授权，再由操作者手动 push 并为这个**共享批次分支**开 PR。仓库的保护分支、远端 CI 和最终 merge 规则继续适用，不默认直接 push protected `main`，也不为每需求创建远端分支。

## 6. 保留与清理

默认 `retain`：即使已验证 merge，worktree 仍保留。若要逐项明确清理，使用原 claimed item 的引用与 `claimId`：

```powershell
$env:DSH_WORKFLOW_INPUT = '{"dataRef":"C:/work/project-workflow-data/requirements/req-example.json","claimId":"<original claimId>","cleanup":true}'
node docs/examples/development/driver.mjs cleanup
```

初始化时也可显式选择 `after-verified-merge`。两种清理方式都必须重新核对目标干净、批准 commit 已在祖先链、需求 worktree 干净且 HEAD 未变；仅使用无 `--force` 的 `git worktree remove`。不存在需求分支可删。

未合并、拒绝、等待、脏、停止或冲突的 worktree 不清理。**任何 ignored 数据都会强制 retained**，记录 `cleanupRetention.reason:ignored-files` 及计数，连 `cleanup:true` 也不能绕过。只有授权操作者确认并处理这些数据后，才可再次显式请求清理。需求 JSON、不可变产物/review、`cleanedWorktreePath` 记录保留。

## 恢复与排障

### 查看与控制

- `auto_workflow_status` / 看板显示引擎状态；`driver status` 的输入是 `{dataRoot}`，`driver inspect` 的输入是 item envelope，分别返回业务计数与引用。
- `auto_workflow_control` 使用 `nodeId` + `enabled` 控制单个队列。禁用 `mine-gate` 停后续周期；如需阻止未启动的挖掘，还应禁用 `miner`。禁用 engineer/reviewer 不影响其他节点，已运行工作继续排空。
- `continuous:false` 全局停新准入并排空在途工作；`stop:true` 是显式中断。任何控制都不自动 cleanup。
- Host 停止/重载、中断或失败不会自动重放；先检查仓库和业务存储，再决定显式续接或新 run。状态引用落盘不承诺跨文件/Git 的掉电事务，详见 [生命周期](<../../run-lifecycle.md>)。

### Typed busy 只重试尚未开始的操作

目录锁不会被自动夺取。只有 10 秒未拿到锁且受保护动作尚未开始，才抛 `BusinessBusy`；driver 返回 `busy` 与原解析输入，图经一秒 `busy-<node>` gate 回到该命令，不重跑前一模型、不重新 claim、不重放不确定副作用。其他错误仍为 `fail`，无自动重试边。

死去的所有者可能留下锁，导致 busy 循环。恢复前核查 owner metadata、所有活跃 job 与 Git 状态，不要夺取活锁。关闭命令节点也会暂停其 busy 重试。

### 显式 snapshot reconciliation

snapshot 发布中断可留下 `status:snapshot-pending` 与精确 `pendingSnapshot`。普通 snapshot 重放会被拒绝。授权操作者应检查意图、artifact 和当前 worktree，再对原 claimed item 调用 `reconcile-snapshot`，额外提供：

```json
{
  "decision": "finalize",
  "expectedRevision": 1,
  "engineeringEpoch": 1,
  "note": "Checked the reserved artifact and matching clean HEAD/tree."
}
```

示意数字必须替换为**保留意图对应的真实值**，不能把旧回复改成新轮参数。该命令重新校验干净 detached HEAD/tree、revision、epoch；已存在 artifact 必须逐项匹配且不覆盖，没有发布的只能完成那份保留 artifact。成功写入对账记录并进入 reviewing，**不会**授予 review/merge 批准。

检查失败 packet 后，用命令返回的 artifact envelope 显式 enqueue 到 `review-input`，不要重跑 engineer/snapshot。这个 reconciliation 是单独 CLI 操作，不是自动图边。

其他边界（`preparing`/`integrating` 的 Git 副作用、review 文件先于需求更新、worktree 已移除但清理结果未写回）仍须保留证据并人工对账。没有通用 reset/replay、自动夺锁或迁移命令。

## CLI 协议与阶段速查

每阶段读取 `DSH_WORKFLOW_INPUT` JSON，stdout 只输出一个对象，不混入日志/Git 输出：

```json
{ "outcome": "complete", "output": { "dataRef": "<absolute business JSON path>", "cwd": "<absolute execution directory>", "label": "Short label" } }
```

item envelope 至少携带业务 `dataRef` / `claimId`，按阶段携带冻结的 `revision` / `engineeringEpoch` / artifact 引用；这些不是引擎 artifact ID。driver 失败输出 `outcome:fail` 和有界错误并非零退出；command 节点设置 `json:true`，不能把任意 stdout 文本当批准。

| Stage | 额外输入 / 主要行为 |
| --- | --- |
| `init` | `dataRoot`、`repoRoot`，可选 `baseBranch`、`cleanupPolicy`；初始化固定配置。 |
| `requirement` / `seed` | `dataRoot` 与 `requirement` / `seed` 对象；显式 intake。 |
| `claim` / `seed-batch` | `dataRoot`、可选 `batchSize` 1..100（图为 3）；返回 ready items 或 idle。 |
| `record-proposal` | seed envelope、`proposal` 或 `null`；稳定 ID 需求或 idle seed。 |
| `route` | claimed item；ready 或 needs_approval。 |
| `requirement-decision` | 冻结 `expectedRevision`、`decision`，reject 必须 note；revision 绑定决定。 |
| `revise-proposal` | `proposal` 含 `expectedRevision`、title、description、risk；同 ID revision+1。 |
| `prepare` / `begin-engineering` | 准备 detached worktree；校验 envelope `revision` / 旧 `engineeringEpoch` 后进入新轮。 |
| `snapshot` | 冻结 `expectedRevision`、`engineeringEpoch`；非空字符串 `summary`、`verification`；不可变 artifact/commit。 |
| `reconcile-snapshot` | `decision:finalize`、冻结 revision/epoch、operator note；仅完成已检查意图。 |
| `review-input` | 当前 `artifactRef` / `commit`；生成冻结 review 输入，也是对账后的续接入口。 |
| `record-review` | 精确 artifact/commit、`decision:pass\|revise`，非空字符串 summary/verification/reviewer。 |
| `merge-decision` | 当前 artifact、decision，返修/拒绝需反馈；精确产物批准。 |
| `integrate` | 已 Human 批准的 item；merged 或 conflict。 |
| `recover-integration` | 手工 Git 恢复已完成，`decision:resolved\|aborted`、note。 |
| `cleanup` | 可选 `cleanup:true`；retained 或经保护检查后的 cleaned。 |
| `status` / `inspect` | `{dataRoot}` / item envelope；有界业务状态与引用。 |

## 验证与限制

[公开验证说明](<../../verification.md>) 区分回归和真实模型执行。在源码 checkout 中运行包含示例与安全回归的完整测试：

```bash
npm test
```

[示例测试](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.0/tests/development-example.test.mjs) 与 [安全回归](https://github.com/lyingloong/dsh-auto-workflow/blob/v1.0.0/tests/audit-example.test.mjs) 使用可丢弃的真实本地 Git 仓库/worktree，覆盖准入、revision/epoch、3+3 并发、反复 review、Human 反馈、busy、snapshot reconciliation、冲突和保留；自动回归不调用付费模型或远端服务。实际运行仍需要有效模型工具、真实输入及项目专属验证。

这不是多 Host 数据库、身份认证服务或恶意文件系统沙箱。操作者负责可信调用者、数据备份、保留期限、项目适配以及经明确授权的远端发布；不要把“持续运行”解释为自动恢复一切或无需人工决策。
