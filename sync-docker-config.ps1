# Docker Configuration Sync Script for OpenClaw
# Syncs host configuration to Docker container with path corrections
# Ensures Anthropic subscription token auth is available in Docker

param(
    [string]$ContainerName = "sergeant-openclaw-gateway-1"
)

Write-Host "🔄 Syncing OpenClaw config to Docker container..."

# Check if container is running
$container = docker ps --filter "name=$ContainerName" --format "{{.Names}}"
if (-not $container) {
    Write-Host "❌ Container not running: $ContainerName"
    exit 1
}

# Copy identity files
Write-Host "📋 Syncing identity files..."
docker cp "C:\Users\J\.openclaw\identity\device-auth.json" "${ContainerName}:/home/node/.openclaw/identity/" 2>$null
docker cp "C:\Users\J\.openclaw\identity\device.json" "${ContainerName}:/home/node/.openclaw/identity/" 2>$null
docker exec --user root $ContainerName bash -c "chown -R node:node /home/node/.openclaw/identity; chmod 600 /home/node/.openclaw/identity/*.json" 2>$null

# Copy Anthropic subscription token auth (required for chat)
Write-Host "🔐 Syncing Anthropic subscription token auth..."
docker exec $ContainerName mkdir -p /home/node/.openclaw/agents/main/agent 2>$null
docker cp "C:\Users\J\.openclaw\agents\main\agent\auth-profiles.json" "${ContainerName}:/home/node/.openclaw/agents/main/agent/" 2>$null
docker exec --user root $ContainerName bash -c "chown -R node:node /home/node/.openclaw/agents; chmod 755 /home/node/.openclaw/agents; chmod 644 /home/node/.openclaw/agents/main/agent/auth-profiles.json" 2>$null

# Create patched openclaw.json with Docker-specific workspace path
Write-Host "⚙️  Patching openclaw.json for Docker..."
$hostConfig = Get-Content -Raw "C:\Users\J\.openclaw\openclaw.json" | ConvertFrom-Json
$hostConfig.agents.defaults.workspace = "/home/node/.openclaw/workspace"
$patchedJson = $hostConfig | ConvertTo-Json -Depth 10
$patchedJson | Out-File -Encoding UTF8 "C:\Users\J\.openclaw\openclaw-docker.json"

# Copy patched config to container
docker cp "C:\Users\J\.openclaw\openclaw-docker.json" "${ContainerName}:/home/node/.openclaw/openclaw.json"
docker exec --user root $ContainerName bash -c "chown node:node /home/node/.openclaw/openclaw.json; chmod 644 /home/node/.openclaw/openclaw.json"

Write-Host "✅ Sync complete!"
Write-Host "📝 To finish, restart the gateway:"
Write-Host "   cd C:\dev\Utils\sergeant"
Write-Host "   docker compose restart openclaw-gateway"
