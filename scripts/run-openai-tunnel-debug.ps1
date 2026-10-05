$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$env:ROB_DC_LOG_ENABLED = "1"
$env:ROB_DC_LOG_LEVEL = "debug"
if (-not $env:ROB_DC_LOG_INCLUDE_PAYLOADS) { $env:ROB_DC_LOG_INCLUDE_PAYLOADS = "0" }
Write-Host "Rob Desktop Commander detailed JSONL logging enabled for tunnel runtime."
Write-Host "Log directory defaults to: $Root\.rob-dc\logs"
& (Join-Path $PSScriptRoot "run-openai-tunnel.ps1")
