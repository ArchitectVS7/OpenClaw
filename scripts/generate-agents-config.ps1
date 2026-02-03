# generate-agents-config.ps1
# Generates OpenClaw agents config from ClawLegion's legion-config.json

param(
    [string]$ClawLegionPath = "C:\dev\Utils\ClawLegion",
    [string]$OutputPath = "$env:USERPROFILE\.openclaw\openclaw.json",
    [switch]$UseLocalPaths  # Use ~/.openclaw/agents/ paths instead of /clawlegion/
)

$ErrorActionPreference = "Stop"

# Read legion-config.json
$configPath = Join-Path $ClawLegionPath "legion-config.json"
if (-not (Test-Path $configPath)) {
    Write-Error "legion-config.json not found at $configPath"
    exit 1
}

$legionConfig = Get-Content $configPath -Raw | ConvertFrom-Json

# Build agents list
$agentsList = @()

foreach ($agent in $legionConfig.agents.list) {
    $agentEntry = @{
        id = $agent.id
    }

    # Set agentDir based on mode
    if ($UseLocalPaths) {
        $agentEntry.agentDir = "~/.openclaw/agents/$($agent.id)/agent"
    } else {
        # Docker mount path (ClawLegion mounted at /clawlegion)
        $agentEntry.agentDir = "/clawlegion/$($agent.agentDir)"
    }

    if ($agent.model) {
        $agentEntry.model = $agent.model
    }

    if ($agent.name) {
        $agentEntry.name = $agent.name
    }

    if ($agent.identity) {
        $agentEntry.identity = @{
            name = $agent.identity.name
            theme = $agent.identity.theme
        }
    }

    if ($agent.subagents) {
        $agentEntry.subagents = @{
            allowAgents = $agent.subagents.allowAgents
        }
    }

    if ($agent.tools) {
        $agentEntry.tools = @{}
        if ($agent.tools.deny) {
            $agentEntry.tools.deny = $agent.tools.deny
        }
        if ($agent.tools.allow) {
            $agentEntry.tools.allow = $agent.tools.allow
        }
    }

    $agentsList += $agentEntry
}

# Build full config
$openclawConfig = @{
    agents = @{
        list = $agentsList
        defaults = @{
            model = "anthropic/claude-sonnet-4-5"
        }
    }
}

# Ensure directory exists
$outputDir = Split-Path $OutputPath -Parent
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

# Write JSON (using ConvertTo-Json with sufficient depth)
$json = $openclawConfig | ConvertTo-Json -Depth 10

# Write to file
Set-Content -Path $OutputPath -Value $json -Encoding UTF8

Write-Host "Generated OpenClaw config with $($agentsList.Count) agents" -ForegroundColor Cyan
Write-Host "Output: $OutputPath" -ForegroundColor Yellow
Write-Host ""

if ($UseLocalPaths) {
    Write-Host "Using local paths (~/.openclaw/agents/)" -ForegroundColor Green
    Write-Host "Make sure to run migrate-clawlegion.ps1 first!" -ForegroundColor Yellow
} else {
    Write-Host "Using Docker mount paths (/clawlegion/)" -ForegroundColor Green
    Write-Host "Set OPENCLAW_EXTRA_MOUNTS to mount ClawLegion:" -ForegroundColor Yellow
    Write-Host "  OPENCLAW_EXTRA_MOUNTS=/mnt/c/dev/Utils/ClawLegion:/clawlegion:ro" -ForegroundColor Gray
}
