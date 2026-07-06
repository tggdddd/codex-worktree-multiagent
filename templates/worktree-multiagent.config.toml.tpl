model_reasoning_effort = "xhigh"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_instructions_file = "{{MODEL_INSTRUCTIONS_FILE_TOML}}"

[[hooks.SubagentStart]]

[[hooks.SubagentStart.hooks]]
type = "command"
command = "node \"{{STATE_RECOVERY_SCRIPT_TOML}}\""
commandWindows = "if (Get-Command node -ErrorAction SilentlyContinue) { node \"{{STATE_RECOVERY_SCRIPT_TOML}}\" }"
timeout = 10
statusMessage = "Registering worktree REQ owner..."

[[hooks.SubagentStop]]

[[hooks.SubagentStop.hooks]]
type = "command"
command = "node \"{{STATE_RECOVERY_SCRIPT_TOML}}\""
commandWindows = "if (Get-Command node -ErrorAction SilentlyContinue) { node \"{{STATE_RECOVERY_SCRIPT_TOML}}\" }"
timeout = 10
statusMessage = "Persisting worktree REQ handoff..."

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "node \"{{STATE_RECOVERY_SCRIPT_TOML}}\""
commandWindows = "if (Get-Command node -ErrorAction SilentlyContinue) { node \"{{STATE_RECOVERY_SCRIPT_TOML}}\" }"
timeout = 10
statusMessage = "Checking worktree REQ ledger..."

[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = "node \"{{STATE_RECOVERY_SCRIPT_TOML}}\""
commandWindows = "if (Get-Command node -ErrorAction SilentlyContinue) { node \"{{STATE_RECOVERY_SCRIPT_TOML}}\" }"
timeout = 10
statusMessage = "Recovering worktree REQ state..."

[agents]
max_threads = 24
max_depth = 1
job_max_runtime_seconds = 14400

[notice]
hide_rate_limit_model_nudge = true
