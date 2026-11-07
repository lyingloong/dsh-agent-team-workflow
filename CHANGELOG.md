# 更新记录

## v1.0.1 — 仓库更名与正式命名

- GitHub 仓库由 `lyingloong/dsh-agent-team-workflow` 更名为 `lyingloong/dsh-auto-workflow`，旧地址由 GitHub 重定向。
- 文档、看板和 Release 正式名称统一为 `dsh-auto-workflow`；`Auto Workflow` 仅作短名，顶栏入口仍为“工作流”。
- 包元数据、文档链接和看板标题同步更新；无运行时、图定义、运行状态或示例业务数据格式变化。
- `v1.0.0` 的 tag、Release 和安装包保持原样。

## v1.0.0 — 首个公开发布

`dsh-auto-workflow`（短名 Auto Workflow）以该包名发布；GitHub Release 与 tag 均为 `v1.0.0`。发布时仓库名为 `lyingloong/dsh-agent-team-workflow`；随后由 v1.0.1 更名为 [lyingloong/dsh-auto-workflow](https://github.com/lyingloong/dsh-auto-workflow)，旧链接由平台重定向。

### 首发内容

- 持久化、并发节点图运行时：独立 packet、根与节点并发上限、detached fan-out、join、Human 门禁、调度 gate 和串行 subworkflow。
- 七个 `auto_workflow_*` 工具覆盖定义、创建、常驻运行、新任务入队、人工决策、控制与只读状态查询。
- Host 常驻期间，idle 和 Human 等待不结束 job，也不阻塞无关 packet；运行状态以引用落盘，产物与有界历史分离。
- 用户批准的 command/HTTP 权限，默认 deny；有序模型回退与逐候选 reasoning effort。有效的业务返修或拒绝不触发模型回退；模型任务默认无截止时间。
- 会话看板显示节点池容量、队列与 Human 待办，支持模型选择与按需读取历史/产物；节点队列在独立滚动区域中展示。
- 唯一主示例：GitHub 项目本地 clone 的持续开发。用户需求 priority `0`、稳定 ID、每需求保留一个 detached worktree、3 engineer + 3 reviewer 池（每需求一位 reviewer）、精确产物绑定的 Human merge 门禁、串行本地集成及默认 `retain`。
- 示例包含 typed `busy`、需求 revision 与 `engineeringEpoch` 防陈旧响应、不可变实现/审查记录、显式 snapshot reconciliation、冲突保留和受保护的清理。
- 中文优先的安装与使用指南、发布说明和公开验证概况；不加入自动 GitHub Issue 抓取、远端 push/PR、远端 merge 或部署。

### 编号与兼容边界

本次从 **v1.0.0 重新建立公开发布序列**。旧开发标签 `v0.1.0` 至 `v2.7.0`（包括旧的同名 `v1.0.0`），以及本地 `3.0.x`，均属于废弃开发序列；它们不是本次首发的兼容基线。Git 历史仍保留，不提供旧工具别名、旧定义/运行状态/业务存储的兼容层，也不作迁移承诺。已有开发期数据应先保留检查，再使用新的存储和 run，不能靠改版本字段转换。

以下版本各自描述不同契约，**不是 package SemVer**：

| 层 | 首发采用的版本 |
| --- | --- |
| 插件包 / GitHub Release / tag | `1.0.0` / `v1.0.0` |
| 节点图定义 | `apiVersion: 2` |
| 持久化运行状态 | `version: 3` |
| 示例业务存储 | `version: 2` |

### 持久化不等于自动恢复

Host 停止、插件重载或执行所有者丢失时，失败/中断证据保留，不自动重放有副作用的工作。单文件原子替换不构成多文件、Git 或 HTTP 的掉电事务。使用者须检查现场并显式恢复。

详见 [v1.0.0 发布说明](<docs/releases/v1.0.0.md>)、[验证说明](<docs/verification.md>) 与 [运行生命周期](<docs/run-lifecycle.md>)。
