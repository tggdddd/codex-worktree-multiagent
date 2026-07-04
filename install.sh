#!/usr/bin/env bash
set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$SCRIPT_DIR/templates"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
NO_BACKUP="${NO_BACKUP:-0}"
SKIP_VALIDATE="${SKIP_VALIDATE:-0}"
PYTHON_BIN="${PYTHON_BIN:-}"

if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    printf 'Error: python3 or python is required for TOML path escaping.\n' >&2
    exit 1
  fi
fi

backup_if_exists() {
  local path="$1"
  if [[ -e "$path" && "$NO_BACKUP" != "1" ]]; then
    cp -p "$path" "$path.bak.$TIMESTAMP"
    printf 'Backup: %s\n' "$path.bak.$TIMESTAMP"
  fi
}

copy_template_file() {
  local source="$1"
  local destination="$2"
  mkdir -p "$(dirname "$destination")"
  backup_if_exists "$destination"
  cp "$source" "$destination"
  printf 'Installed: %s\n' "$destination"
}

toml_escape() {
  "$PYTHON_BIN" - "$1" <<'PY'
import sys
value = sys.argv[1]
print(value.replace("\\", "\\\\").replace('"', '\\"'))
PY
}

mkdir -p "$CODEX_HOME/instructions" "$CODEX_HOME/agents" "$CODEX_HOME/worktree-multiagent/hooks"

instruction_dest="$CODEX_HOME/instructions/worktree-multiagent-base.md"
recovery_hook_dest="$CODEX_HOME/worktree-multiagent/hooks/recover-requirement-state.js"
copy_template_file "$TEMPLATE_ROOT/instructions/worktree-multiagent-base.md" "$instruction_dest"
copy_template_file "$TEMPLATE_ROOT/agents/worktree-explorer.toml" "$CODEX_HOME/agents/worktree-explorer.toml"
copy_template_file "$TEMPLATE_ROOT/agents/worktree-worker.toml" "$CODEX_HOME/agents/worktree-worker.toml"
copy_template_file "$TEMPLATE_ROOT/agents/worktree-integrator.toml" "$CODEX_HOME/agents/worktree-integrator.toml"
copy_template_file "$TEMPLATE_ROOT/hooks/recover-requirement-state.js" "$recovery_hook_dest"

profile_dest="$CODEX_HOME/worktree-multiagent.config.toml"
backup_if_exists "$profile_dest"
escaped_instruction_path="$(toml_escape "$instruction_dest")"
escaped_recovery_hook_path="$(toml_escape "$recovery_hook_dest")"
"$PYTHON_BIN" - "$TEMPLATE_ROOT/worktree-multiagent.config.toml.tpl" "$profile_dest" "$escaped_instruction_path" "$escaped_recovery_hook_path" <<'PY'
import pathlib
import sys

template_path = pathlib.Path(sys.argv[1])
dest_path = pathlib.Path(sys.argv[2])
escaped_instruction_path = sys.argv[3]
escaped_recovery_hook_path = sys.argv[4]

content = template_path.read_text(encoding="utf-8")
content = content.replace("{{MODEL_INSTRUCTIONS_FILE_TOML}}", escaped_instruction_path)
content = content.replace("{{STATE_RECOVERY_SCRIPT_TOML}}", escaped_recovery_hook_path)
dest_path.write_text(content, encoding="utf-8")
PY
printf 'Installed: %s\n' "$profile_dest"

if [[ "$SKIP_VALIDATE" != "1" ]]; then
  if command -v codex >/dev/null 2>&1; then
    codex --profile worktree-multiagent --strict-config --version
  else
    printf 'Skip validation: codex executable not found on PATH\n'
  fi
fi

printf '\nDone. Start Codex with:\n  codex --profile worktree-multiagent\n'
