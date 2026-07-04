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

profile 带一个 `SessionStart` hook：启动或 resume 时会把异常中断遗留的 `in_progress` 恢复为 `ready`，把陈旧的 `merging` 恢复为 `merge_pending`，避免队列永久卡住。首次运行时按 Codex 的 hook trust 提示授权即可。

## 设计边界

这个 profile 故意不让主 Agent 实现、验证或合并。主 Agent 只负责调用子 Agent。实现、验证、提交、合并、冲突修复由 worker/integrator 自行处理。
