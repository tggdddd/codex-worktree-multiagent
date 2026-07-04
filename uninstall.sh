#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

targets=(
  "$CODEX_HOME/worktree-multiagent.config.toml"
  "$CODEX_HOME/instructions/worktree-multiagent-base.md"
  "$CODEX_HOME/agents/worktree-explorer.toml"
  "$CODEX_HOME/agents/worktree-worker.toml"
  "$CODEX_HOME/agents/worktree-integrator.toml"
  "$CODEX_HOME/worktree-multiagent/hooks/recover-requirement-state.js"
)

for target in "${targets[@]}"; do
  if [[ -e "$target" ]]; then
    rm -f "$target"
    printf 'Removed: %s\n' "$target"
  fi
done

printf 'Done.\n'
