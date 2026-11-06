# 业务流程与保证：GitHub 项目本地持续开发

这是 Auto Workflow（`dsh-auto-workflow`）的**唯一主业务示例**：把 GitHub 仓库克隆到本地，在保留的 worktree 中持续处理真实需求，经过审查与人工批准后本地集成。不是托管机器人，不自动监听聊天、抓取 GitHub Issues、push、开 PR 或远端 merge。

[完整操作指南](<examples/development/README.md>) 负责安装后的准备与操作；本页集中说明业务契约。实现由 [节点图](<examples/development/workflow.json>)、[业务存储](<examples/development/store.mjs>)、[本地 Git 模块](<examples/development/worktrees.mjs>) 和 [JSON driver](<examples/development/driver.mjs>) 组成。插件只调度通用 packet 和引用，不解释业务 `dataRef`。

## 执行链

```text
显式用户 intake ───────────────┐
已有 seed → producer / miner ──┴→ 稳定 ID 需求队列
  → 用户优先、priority、FIFO、ID 的确定性准入
  → 用户 / 挖掘 low：直接进入开发
    挖掘 mid/high：Human 需求审批；拒绝反馈 → 同 ID 修订 → 再评估
  → 每需求一个保留的 detached worktree
  → begin-engineering → engineer 池（最多 3）
  → 冻结需求 revision、engineeringEpoch、commit、tree
  → reviewer 池（最多 3；每需求只分配一位）
    revise → 同 ID / 同 worktree 的下一轮开发
  → Human merge 待办池
    revise → 同 ID 返修；reject → 保留，不合并
    approve 精确产物 → 串行本地集成（最多 1）
  → 干净目标上验证已批准 commit 的祖先关系
  → 默认 retain；清理必须另有明确策略或逐项授权
```

根并发为 **6**，所有节点共享，命令与 miner 也计入其中。3+3 是工作池容量，不是每项需求三轮审查，也不保证始终有六个模型同时工作。返修回到相同 engineer 流程、ID 和 worktree，不以新建需求或分支替代返修。

Human 等待不占工作槽，不阻挡其他 packet、producer 或新到达的需求。节点池可以 `running`、`idle`、`disabled`；结束的是单项执行/packet，不是整个服务。

## 输入来源与持续 producer

- **用户需求**只由获得授权的 intake 调用写入。优先级强制为 `0`，即使风险为 high 也跳过“需求是否开展”的审批；仍必须通过实现 review 与 Human merge 门禁。
- **挖掘需求**来自事先提供的真实证据 seed，优先级为 `1..9`。low 跳过需求审批，mid/high 必须人工决定。没有 seed 就不调用挖掘模型；无可行动建议的 seed 记为 idle，不凭空制造需求。
- 默认 `dispatch` 只准入有限批次。要持续处理，在同一 run 中显式向 `mine-gate` enqueue **一个** producer。它每轮经 60 秒 gate、seed claim、detached miner 分支、队列 dispatch、detached 需求分支后返回 gate。
- 慢模型和 Human 等待不会牵住 detached producer。后续 seed 与用户需求可以继续写入；需要即时处理时可 enqueue 有限 `dispatch`，不要重复启动 producer。
- 优先级作用于业务队列的 claim；不抢占已经领取/执行的工作，也不承诺重排引擎中已经排队的 token。

## 身份、修订与存储

| 契约 | 具体保证与边界 |
| --- | --- |
| 稳定 ID | 一项需求一个 ID 和绝对 `dataRef`；需求 ID、seed ID、packet ID、引擎 artifact ID 各自独立。 |
| 同 ID 更新 | 仅 queued 项可 intake upsert，要求当前 `expectedRevision`，保留原 FIFO 顺序；active 项走反馈路径，不可覆盖。 |
| 单一 worktree | 每项保存 `worktreePath` 和 `baseRevision`，使用 detached HEAD，**无每需求分支**；以 commit ID 集成。返修、拒绝、停止、冲突不删除它。 |
| 需求审批绑定 | Human 需求响应绑定当时冻结的 `expectedRevision`，不能批准后来已修订的规格。 |
| 工程轮次绑定 | `begin-engineering` 消耗上轮 admission 并增加 `engineeringEpoch`；snapshot 校验冻结的 revision + epoch，拒绝旧轮响应。长期 `claimId` 不是单轮能力凭证。 |
| 不可变实现与 review | 每轮实现、审查都是新记录；review/merge approval 绑定精确需求 revision、artifact 和 commit。脏 worktree 或改变的 HEAD 会阻止继续。 |
| typed busy | 只有 10 秒内未获得业务锁、受保护操作尚未开始时，才产生 `BusinessBusy`。driver 返回 `busy` 和原解析输入，图经 1 秒 gate 只重试该命令；不重跑前面的模型或不确定副作用。 |
| 本地一致性 | 唯一临时文件 + rename 更新单文件，目录锁协调本地进程；多文件不是一个事务，锁不会自动被夺取。 |
| 路径 | 限制 ID 字符、验证引用和所有权路径，拒绝 traversal/symlink 别名。每目标仓库只用一个项目外的绝对 canonical 数据 root。不是恶意文件系统的安全沙箱。 |

有效的审查返修使用业务 outcome **`revise`**，先落盘再进入下一轮，不借用通用失败预算的 `needs_revision`。示例没有自动业务返修次数上限；操作者可暂停节点。失败、取消或无效模型输出也不能冒充一次通过的 review。

示例业务存储为 `version: 2`，与包 SemVer 无关。旧 store 不迁移、不删除；使用新的 canonical root 并保留旧数据供检查。

## 人工批准、本地集成和保留

通用 Human 节点只记录小型 outcome/output；后续示例命令才写入业务决定。需求拒绝、实现返修/拒绝、冲突恢复都需要有意义的反馈。审批精确产物不代表授权远端发布。

集成同时受节点 `concurrency: 1` 与 store 级 integration lock 保护。目标必须在配置的 `baseBranch`、干净且没有正在进行的 merge；批准的 worktree 必须仍是原来的干净 HEAD。推荐把这个本地目标设为**共享集成批次分支**，而非为每需求建分支；如以后需要 GitHub PR，可由用户单独授权后手动提交整个批次。

合并前检查目标中的 ignored 文件与批准 tree 的路径碰撞（含文件/目录前缀与适用时的大小写折叠），碰撞时保留数据、不执行 merge。成功后验证干净目标及已批准 commit 的祖先关系。冲突时同时保留需求 worktree 和目标 Git merge 现场；不自动 abort、reset、force checkout 或重试。其他开发/review 可继续，但共享目标须先人工恢复。

默认 **`retain`，包括合并后**。初始化时显式选 `after-verified-merge` 或逐项明确 `cleanup:true` 才可尝试清理；仍须复验已合并祖先关系和两个干净 checkout，以无 `--force` 的 `git worktree remove` 移除。任何 ignored 本地数据都会强制 retained，并给出原因/计数，无强制绕过。业务 JSON、不可变记录和清理记录仍保留。

## 中断与显式 reconciliation

“持续”只在 Host 常驻运行期间成立；“持久化”提供状态、引用和意图证据，不是跨文件/Git 的掉电事务。失败或中断执行不自动重放，重启 Host 不会替操作者推断哪些副作用已经成功。

snapshot 会先保留精确 `snapshot-pending` 意图。若发布中断，可在检查 HEAD/tree/revision/epoch 后显式 `reconcile-snapshot`：只完成保留的那份 artifact，既有字节不得覆盖；成功后从 `review-input` 进入 review，而不是重跑工程阶段。其他 `preparing`、`integrating`、review 发布或清理的多文件不确定状态仍须人工检查与对账。步骤见 [操作指南的恢复部分](<examples/development/README.md#恢复与排障>)。

## 验证与非目标

[验证说明](<verification.md>) 区分可重复回归与隔离的真实模型/Git 执行，覆盖 3+3 并发、Human 返修、保留 worktree、review/epoch 绑定、typed busy、snapshot reconciliation、冲突和 ignored 数据保护。验证不是任意项目都能无人值守运行的保证。

使用前仍须 materialize 脚本并本地提交干净、配置模型工具与项目实际验证命令、提供真实需求、批准权限，并在运行中避免外部同时修改集成 checkout。备份、远端 PR/push、受保护分支策略、部署和外部数据发现属于操作者职责，不在示例图内。

更多运行时恢复语义见 [生命周期](<run-lifecycle.md>)。
