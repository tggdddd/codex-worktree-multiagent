param(
    [string]$CodexHome = $env:CODEX_HOME,
    [switch]$NoBackup,
    [switch]$SkipValidate
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = Join-Path $HOME ".codex"
}

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$TemplateRoot = Join-Path $RepoRoot "templates"
$Timestamp = Get-Date -Format "yyyyMMddHHmmss"

function Backup-IfExists {
    param([string]$Path)
    if ((Test-Path -LiteralPath $Path) -and (-not $NoBackup)) {
        $BackupPath = "$Path.bak.$Timestamp"
        Copy-Item -LiteralPath $Path -Destination $BackupPath -Force
        Write-Host "Backup: $BackupPath"
    }
}

function Copy-TemplateFile {
    param(
        [string]$Source,
        [string]$Destination
    )
    $Parent = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
    Backup-IfExists -Path $Destination
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    Write-Host "Installed: $Destination"
}

function Convert-ToTomlStringContent {
    param([string]$Value)
    return ($Value -replace '\\', '\\' -replace '"', '\"')
}

New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $CodexHome "instructions") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $CodexHome "agents") | Out-Null

$InstructionDest = Join-Path $CodexHome "instructions\worktree-multiagent-base.md"
$ExplorerDest = Join-Path $CodexHome "agents\worktree-explorer.toml"
$WorkerDest = Join-Path $CodexHome "agents\worktree-worker.toml"
$IntegratorDest = Join-Path $CodexHome "agents\worktree-integrator.toml"
$ProfileDest = Join-Path $CodexHome "worktree-multiagent.config.toml"

Copy-TemplateFile -Source (Join-Path $TemplateRoot "instructions\worktree-multiagent-base.md") -Destination $InstructionDest
Copy-TemplateFile -Source (Join-Path $TemplateRoot "agents\worktree-explorer.toml") -Destination $ExplorerDest
Copy-TemplateFile -Source (Join-Path $TemplateRoot "agents\worktree-worker.toml") -Destination $WorkerDest
Copy-TemplateFile -Source (Join-Path $TemplateRoot "agents\worktree-integrator.toml") -Destination $IntegratorDest

$Template = Get-Content -Raw -Encoding UTF8 (Join-Path $TemplateRoot "worktree-multiagent.config.toml.tpl")
$EscapedInstructionPath = Convert-ToTomlStringContent -Value $InstructionDest
$Profile = $Template.Replace("{{MODEL_INSTRUCTIONS_FILE_TOML}}", $EscapedInstructionPath)
Backup-IfExists -Path $ProfileDest
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($ProfileDest, $Profile, $Utf8NoBom)
Write-Host "Installed: $ProfileDest"

if (-not $SkipValidate) {
    $Codex = Get-Command codex -ErrorAction SilentlyContinue
    if ($Codex) {
        & codex --profile worktree-multiagent --strict-config --version | Out-Host
    } else {
        Write-Host "Skip validation: codex executable not found on PATH"
    }
}

Write-Host ""
Write-Host "Done. Start Codex with:"
Write-Host "  codex --profile worktree-multiagent"
