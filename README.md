# Codex Worktree Multi-Agent Profile

可复用的 Codex CLI profile。它把主 Agent 限制为“只调用 Agent”的调度器：

- 主 Agent 只调用 `worktree-explorer` / `worktree-worker` / `worktree-integrator`
- explorer 负责探索需求并写入需求 md
- worker 从需求 md 接管 REQ，自行实现、验证、提交、合并目标主分支并修复合并问题
- integrator 只在 worker 自合并阻塞时处理指定 REQ 的合并修复

## 一键安装

Windows PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install.ps1
```

macOS / Linux:

```bash
chmod +x ./install.sh
./install.sh
```

安装后使用：

```bash
codex --profile worktree-multiagent
```

## 自定义 CODEX_HOME

Windows:

```powershell
.\install.ps1 -CodexHome "D:\codex-home"
```

macOS / Linux:

```bash
CODEX_HOME=/path/to/.codex ./install.sh
```

## 安装内容

安装脚本会写入：

```text
$CODEX_HOME/worktree-multiagent.config.toml
$CODEX_HOME/instructions/worktree-multiagent-base.md
$CODEX_HOME/agents/worktree-explorer.toml
$CODEX_HOME/agents/worktree-worker.toml
$CODEX_HOME/agents/worktree-integrator.toml
$CODEX_HOME/worktree-multiagent/hooks/recover-requirement-state.js
```

如果目标文件已存在，默认会先备份为：

```text
<file>.bak.<yyyyMMddHHmmss>
```

## 卸载

Windows:

```powershell
.\uninstall.ps1
```

macOS / Linux:

```bash
chmod +x ./uninstall.sh
./uninstall.sh
```

卸载只删除本 profile 安装的同名文件，不删除备份文件。

## 需求队列

在项目内运行该 profile 后，explorer/worker 会使用需求 md 作为队列：

```text
.codex/worktree-multiagent/requirements.md
```

如果项目不允许写 `.codex/`，会退回：

```text
WORKTREE_MULTIAGENT_REQUIREMENTS.md
```

profile 带一组 hook 控制面，使用同一个 Node 脚本维护需求队列状态：

- `SubagentStart`：登记 SubAgent 接管 REQ，写入 `owner_agent`、`agent_type`、`started_at`、`heartbeat_at`，并把 `ready` 转为 `in_progress`。
- `SubagentStop`：在 SubAgent 正常结束时优先读取 `WTMA_HANDOFF { ... }` 单行 JSON，记录 `worktree_path`、`source_branch`、`source_commit`、`validation` 和最终状态；标记 `merged` 后记录 `cleanup_status` / `cleanup_message` 并清理标准 worktree；输出不完整或把最终状态写成 `merge_waiting` 时会 block，要求继续该 SubAgent flow。
- `Stop`：主 Agent 本轮结束前检查 ledger 是否有未落盘 active 状态或同目标并发合并风险。
- `SessionStart`：只做启动或 resume 后的兜底恢复，把 stale `in_progress` / `merge_waiting` / `merging` 转成可重新分发或可恢复合并的状态，并重试已合并条目的未完成清理。

主要状态为 `ready`、`in_progress`、`merge_waiting`、`merging`、`merge_pending`、`merged`、`blocked`。`merge_waiting` 只表示 SubAgent 仍在运行中等待 merge lock，不是最终停止状态。

## 标准 worktree 布局与清理

worker 和 integrator 必须使用当前仓库同级的标准目录，不能把任务 worktree 放进主仓库目录：

```text
<repo-parent>/<repo-name>.worktrees/<REQ-id>
```

每个 REQ 使用自己的目录和 `wtma/<REQ-id>` 任务分支。`worktree_path` 必须记录这个实际绝对路径（或相对于仓库根目录的路径），不能临时改用其他目录。

创建示例：

```bash
git worktree add --branch wtma/<REQ-id> <repo-parent>/<repo-name>.worktrees/<REQ-id> <merge-target>
```

成功合并并完成合并后验证后，`SubagentStop` hook 会安全执行：

1. 使用不带 `--force` 的 `git worktree remove` 移除该标准 worktree。
2. 使用 `git branch -d` 删除已经合并的任务分支。
3. 在需求条目写入 `cleanup_status` 和 `cleanup_message`。

worktree 有未提交改动、路径不是标准目录或分支仍未安全合并时，不会强制删除；条目会保留清理结果，后续 `SessionStart` 会重试。

最终 handoff 必须包含：

```text
WTMA_HANDOFF {"req_id":"REQ-...","status":"merged","worktree_path":"...","source_branch":"wtma/REQ-...","source_commit":"...","merge_target":"main","validation":"..."}
```

首次运行或 hook 内容变化时按 Codex 的 hook trust 提示授权即可。

## 设计边界

这个 profile 故意不让主 Agent 实现、验证或合并。主 Agent 只负责调用子 Agent。实现、验证、提交、合并、冲突修复由 worker/integrator 自行处理。
