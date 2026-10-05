$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Server = Join-Path $Root "dist\index.js"
$LocalTunnel = Join-Path $Root ".rob-dc\bin\tunnel-client.exe"

if (-not $env:ROB_TUNNEL_ID) { throw "Set ROB_TUNNEL_ID to the tunnel_xxx identifier created in OpenAI Platform." }
if (-not $env:CONTROL_PLANE_API_KEY) { throw "Set CONTROL_PLANE_API_KEY to the runtime API key for tunnel-client." }

if (Test-Path $LocalTunnel) {
    $TunnelClient = $LocalTunnel
} else {
    $cmd = Get-Command tunnel-client -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "tunnel-client was not found. Run .\scripts\install-tunnel-client.ps1 first." }
    $TunnelClient = $cmd.Source
}

Set-Location $Root
npm run build
if (-not $env:ROB_DC_ALLOWED_DIRS) { $env:ROB_DC_ALLOWED_DIRS = $env:USERPROFILE }

$McpCommand = 'node "' + $Server + '"'
& $TunnelClient init --sample sample_mcp_stdio_local --profile rob-desktop --tunnel-id $env:ROB_TUNNEL_ID --mcp-command $McpCommand
& $TunnelClient doctor --profile rob-desktop --explain

Write-Host ""
Write-Host "Tunnel profile 'rob-desktop' is ready."
Write-Host "Start it with: .\scripts\run-openai-tunnel.ps1"
