# migrate-clawlegion.ps1
# Copies ClawLegion agents to ~/.openclaw/agents/ in OpenClaw format

param(
    [string]$ClawLegionPath = "C:\dev\Utils\ClawLegion",
    [string]$OpenClawAgentsDir = "$env:USERPROFILE\.openclaw\agents"
)

$ErrorActionPreference = "Stop"

# Read legion-config.json
$configPath = Join-Path $ClawLegionPath "legion-config.json"
if (-not (Test-Path $configPath)) {
    Write-Error "legion-config.json not found at $configPath"
    exit 1
}

$config = Get-Content $configPath | ConvertFrom-Json

Write-Host "Migrating $(($config.agents.list).Count) agents from ClawLegion..." -ForegroundColor Cyan

foreach ($agent in $config.agents.list) {
    $agentId = $agent.id
    $sourceDir = Join-Path $ClawLegionPath $agent.agentDir

    # OpenClaw expects: ~/.openclaw/agents/<agentId>/agent/
    $targetDir = Join-Path $OpenClawAgentsDir "$agentId\agent"

    if (-not (Test-Path $sourceDir)) {
        Write-Warning "Source not found: $sourceDir (skipping $agentId)"
        continue
    }

    # Create target directory
    if (-not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    # Copy SOUL.md, MEMORY.md, TOOLS.md, auth-profiles.json
    $filesToCopy = @("SOUL.md", "MEMORY.md", "TOOLS.md", "auth-profiles.json")
    $copiedFiles = @()

    foreach ($file in $filesToCopy) {
        $sourcePath = Join-Path $sourceDir $file
        if (Test-Path $sourcePath) {
            Copy-Item $sourcePath -Destination $targetDir -Force
            $copiedFiles += $file
        }
    }

    Write-Host "  $agentId -> $targetDir ($($copiedFiles -join ', '))" -ForegroundColor Green
}

Write-Host ""
Write-Host "Migration complete!" -ForegroundColor Cyan
Write-Host "Agents copied to: $OpenClawAgentsDir" -ForegroundColor Yellow
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Create/update ~/.openclaw/openclaw.json with agent list"
Write-Host "2. Run docker-setup.sh to start the gateway"
