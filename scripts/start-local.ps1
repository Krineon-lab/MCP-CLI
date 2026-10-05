$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
if (-not $env:ROB_DC_ALLOWED_DIRS) { $env:ROB_DC_ALLOWED_DIRS = $env:USERPROFILE }
if (-not $env:UV_THREADPOOL_SIZE) { $env:UV_THREADPOOL_SIZE = "8" }
if (-not (Test-Path (Join-Path $Root "dist\index.js"))) { npm run build }
node (Join-Path $Root "dist\index.js")
