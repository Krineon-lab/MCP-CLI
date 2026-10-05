$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "dist\index.js"
if (-not $env:ROB_TUNNEL_ID) { throw "Set ROB_TUNNEL_ID to the tunnel_xxx identifier created in OpenAI Platform." }
if (-not $env:CONTROL_PLANE_API_KEY) { throw "Set CONTROL_PLANE_API_KEY to the runtime API key for tunnel-client." }
if (-not (Get-Command tunnel-client -ErrorAction SilentlyContinue)) { throw "tunnel-client is not on PATH. Install the current OpenAI tunnel-client first." }
Set-Location $Root
npm run build
if (-not $env:ROB_DC_ALLOWED_DIRS) { $env:ROB_DC_ALLOWED_DIRS = $env:USERPROFILE }
$McpCommand = 'node "' + $Server + '"'
tunnel-client init --sample sample_mcp_stdio_local --profile rob-desktop --tunnel-id $env:ROB_TUNNEL_ID --mcp-command $McpCommand
tunnel-client doctor --profile rob-desktop --explain
Write-Host ""
Write-Host "Tunnel profile 'rob-desktop' is ready."
Write-Host "Start it with: tunnel-client run --profile rob-desktop"
