$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root ".rob-dc"
$ConfigDir = Join-Path $StateDir "config"
$SecretsDir = Join-Path $StateDir "secrets"
$LogsDir = Join-Path $StateDir "logs"
$ProfileDir = Join-Path $StateDir "tunnel-profiles"
$TunnelClient = Join-Path $StateDir "bin\tunnel-client.exe"
$TunnelIdFile = Join-Path $ConfigDir "tunnel-id.txt"
$KeyFile = Join-Path $SecretsDir "control-plane-api-key.dpapi"
$DebugFlag = Join-Path $ConfigDir "debug-logging.enabled"
$HealthUrlFile = Join-Path $StateDir "tunnel-health-url.txt"
$ServiceLog = Join-Path $LogsDir ("tunnel-service-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
$TunnelLog = Join-Path $LogsDir ("tunnel-client-" + (Get-Date -Format "yyyy-MM-dd") + ".jsonl")

New-Item -ItemType Directory -Force -Path $ConfigDir,$SecretsDir,$LogsDir,$ProfileDir | Out-Null

function Write-ServiceLog([string]$Message) {
    $line = ("{0:o} {1}" -f (Get-Date), $Message)
    Add-Content -Path $ServiceLog -Value $line -Encoding UTF8
}

$mutex = New-Object System.Threading.Mutex($false, "Local\RobDesktopCommanderTunnel")
$acquired = $false

try {
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) {
        Write-ServiceLog "Another tunnel instance is already running; exiting."
        exit 0
    }

    if (-not (Test-Path $TunnelClient)) { throw "tunnel-client.exe not found: $TunnelClient" }
    if (-not (Test-Path $TunnelIdFile)) { throw "Tunnel ID is not configured." }
    if (-not (Test-Path $KeyFile)) { throw "Runtime API key is not configured." }

    $TunnelId = (Get-Content -Raw $TunnelIdFile).Trim()
    if ($TunnelId -notmatch '^tunnel_[0-9a-f]{32}$') { throw "Stored tunnel ID has an invalid format." }

    $Encrypted = (Get-Content -Raw $KeyFile).Trim()
    $Secure = ConvertTo-SecureString $Encrypted
    $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
    }
    if ([string]::IsNullOrWhiteSpace($ApiKey)) { throw "Stored runtime API key decrypted to an empty value." }

    $env:CONTROL_PLANE_API_KEY = $ApiKey
    $env:CONTROL_PLANE_TUNNEL_ID = $TunnelId
    $env:ROB_TUNNEL_ID = $TunnelId
    $env:ROB_DC_ALLOWED_DIRS = $env:USERPROFILE
    $env:UV_THREADPOOL_SIZE = "8"

    if (Test-Path $DebugFlag) {
        $env:ROB_DC_LOG_ENABLED = "1"
        $env:ROB_DC_LOG_LEVEL = "debug"
        $env:ROB_DC_LOG_INCLUDE_PAYLOADS = "0"
        $TunnelLogLevel = "debug"
    } else {
        $env:ROB_DC_LOG_ENABLED = "0"
        $TunnelLogLevel = "info"
    }

    $Server = Join-Path $Root "dist\index.js"
    $needsBuild = -not (Test-Path $Server)
    if (-not $needsBuild) {
        $distTime = (Get-Item $Server).LastWriteTimeUtc
        $newerSource = Get-ChildItem (Join-Path $Root "src") -Filter "*.ts" -Recurse |
            Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
            Select-Object -First 1
        $needsBuild = $null -ne $newerSource
    }

    if ($needsBuild) {
        Write-ServiceLog "Building Rob Desktop Commander before tunnel startup."
        Push-Location $Root
        try {
            & npm.cmd run build | ForEach-Object { Write-ServiceLog $_ }
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
    }

    # If a previous task host was terminated, tunnel-client may survive as an orphan.
    # Remove only stale instances for this exact Rob Desktop Commander profile.
    $stale = Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -like "*--profile rob-desktop*" -and
            $_.CommandLine -like "*$ProfileDir*"
        }
    foreach ($proc in $stale) {
        Write-ServiceLog ("Terminating stale tunnel-client PID " + $proc.ProcessId + ".")
        & taskkill.exe /PID $proc.ProcessId /T /F | Out-Null
    }
    if ($stale) { Start-Sleep -Milliseconds 750 }

    Remove-Item $HealthUrlFile -Force -ErrorAction SilentlyContinue
    Write-ServiceLog "Starting tunnel-client profile rob-desktop for $TunnelId."

    $RunArgs = @(
        "run",
        "--profile", "rob-desktop",
        "--profile-dir", $ProfileDir,
        "--health.listen-addr", "127.0.0.1:0",
        "--health.url-file", $HealthUrlFile,
        "--log.level", $TunnelLogLevel,
        "--log.format", "json",
        "--log.file", $TunnelLog
    )
    & $TunnelClient @RunArgs

    $exitCode = $LASTEXITCODE
    Write-ServiceLog "tunnel-client exited with code $exitCode."
    exit $exitCode
} catch {
    Write-ServiceLog ("FATAL: " + $_.Exception.Message)
    throw
} finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    if ($acquired) { $mutex.ReleaseMutex() | Out-Null }
    $mutex.Dispose()
}
