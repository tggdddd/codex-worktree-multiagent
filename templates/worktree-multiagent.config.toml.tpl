model_reasoning_effort = "xhigh"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_instructions_file = "{{MODEL_INSTRUCTIONS_FILE_TOML}}"

[agents]
max_threads = 24
max_depth = 1
job_max_runtime_seconds = 14400

[notice]
hide_rate_limit_model_nudge = true
