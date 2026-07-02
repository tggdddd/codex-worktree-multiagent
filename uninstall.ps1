param(
    [string]$CodexHome = $env:CODEX_HOME
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = Join-Path $HOME ".codex"
}

$Targets = @(
    (Join-Path $CodexHome "worktree-multiagent.config.toml"),
    (Join-Path $CodexHome "instructions\worktree-multiagent-base.md"),
    (Join-Path $CodexHome "agents\worktree-explorer.toml"),
    (Join-Path $CodexHome "agents\worktree-worker.toml"),
    (Join-Path $CodexHome "agents\worktree-integrator.toml")
)

foreach ($Target in $Targets) {
    if (Test-Path -LiteralPath $Target) {
        Remove-Item -LiteralPath $Target -Force
        Write-Host "Removed: $Target"
    }
}

Write-Host "Done."
