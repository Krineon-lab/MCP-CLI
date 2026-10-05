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
$ResultFile = Join-Path $ConfigDir "setup-result.json"
$TaskName = "Rob Desktop Commander"
$RunScript = Join-Path $PSScriptRoot "run-tunnel-service.ps1"

New-Item -ItemType Directory -Force -Path $ConfigDir,$SecretsDir,$LogsDir,$ProfileDir | Out-Null
Remove-Item $ResultFile -Force -ErrorAction SilentlyContinue

function Save-Result([string]$Status, [string]$Message) {
    [pscustomobject]@{
        status = $Status
        message = $Message
        at = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content -Path $ResultFile -Encoding UTF8
}

try {
    Write-Host ""
    Write-Host "=== Rob Desktop Commander - configurazione tunnel ===" -ForegroundColor Cyan
    Write-Host "La API key non verra' mostrata e sara' salvata cifrata con Windows DPAPI." -ForegroundColor Yellow
    Write-Host ""

    if (-not (Test-Path $TunnelClient)) { throw "tunnel-client.exe non trovato: $TunnelClient" }

    do {
        $TunnelId = (Read-Host "Incolla il Tunnel ID (tunnel_...)").Trim()
        if ($TunnelId -notmatch '^tunnel_[0-9a-f]{32}$') {
            Write-Host "Formato Tunnel ID non valido. Riprova." -ForegroundColor Red
        }
    } until ($TunnelId -match '^tunnel_[0-9a-f]{32}$')

    do {
        $SecureKey = Read-Host "Incolla la Runtime API key (input nascosto)" -AsSecureString
        $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
        try {
            $plainLength = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr).Length
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
        }
        if ($plainLength -eq 0) {
            Write-Host "La key e' vuota. Riprova." -ForegroundColor Red
        }
    } until ($plainLength -gt 0)

    Set-Content -Path $TunnelIdFile -Value $TunnelId -NoNewline -Encoding ASCII
    $SecureKey | ConvertFrom-SecureString | Set-Content -Path $KeyFile -NoNewline -Encoding ASCII
    New-Item -ItemType File -Force -Path $DebugFlag | Out-Null

    $Encrypted = (Get-Content -Raw $KeyFile).Trim()
    $Secure = ConvertTo-SecureString $Encrypted
    $Bstr2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr2)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr2)
    }

    $env:CONTROL_PLANE_API_KEY = $ApiKey
    $env:CONTROL_PLANE_TUNNEL_ID = $TunnelId
    $env:ROB_TUNNEL_ID = $TunnelId
    $env:ROB_DC_ALLOWED_DIRS = $env:USERPROFILE
    $env:UV_THREADPOOL_SIZE = "8"

    Write-Host ""
    Write-Host "Build del server..." -ForegroundColor Cyan
    Push-Location $Root
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build fallito con codice $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $Server = Join-Path $Root "dist\index.js"
    # tunnel-client parses backslashes in mcp.command as escapes; use forward slashes on Windows.
    $ServerForTunnel = $Server -replace '\\','/'
    $McpCommand = 'node "' + $ServerForTunnel + '"'

    Write-Host ""
    Write-Host "Creazione/aggiornamento profilo tunnel..." -ForegroundColor Cyan
    $InitArgs = @(
        "init",
        "--sample", "sample_mcp_stdio_local",
        "--profile", "rob-desktop",
        "--profile-dir", $ProfileDir,
        "--tunnel-id", $TunnelId,
        "--mcp-command", $McpCommand,
        "--health-listen-addr", "127.0.0.1:0",
        "--force"
    )
    & $TunnelClient @InitArgs
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client init fallito con codice $LASTEXITCODE" }

    Write-Host ""
    Write-Host "Verifica tunnel (doctor)..." -ForegroundColor Cyan
    & $TunnelClient doctor --profile rob-desktop --profile-dir $ProfileDir --explain
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor fallito con codice $LASTEXITCODE" }

    Write-Host ""
    Write-Host "Installazione avvio automatico Windows..." -ForegroundColor Cyan

    $UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $ActionArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $RunScript + '"'

    $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $ActionArgs
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
    $Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

    $SettingsParams = @{
        StartWhenAvailable = $true
        AllowStartIfOnBatteries = $true
        DontStopIfGoingOnBatteries = $true
        MultipleInstances = "IgnoreNew"
        RestartCount = 999
        RestartInterval = (New-TimeSpan -Minutes 1)
        ExecutionTimeLimit = ([TimeSpan]::Zero)
    }
    $Settings = New-ScheduledTaskSettingsSet @SettingsParams

    $TaskParams = @{
        TaskName = $TaskName
        Action = $Action
        Trigger = $Trigger
        Principal = $Principal
        Settings = $Settings
        Description = "Avvia OpenAI tunnel-client + Rob Desktop Commander con debug logging."
        Force = $true
    }
    Register-ScheduledTask @TaskParams | Out-Null

    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName

    Start-Sleep -Seconds 3
    $task = Get-ScheduledTask -TaskName $TaskName
    $info = Get-ScheduledTaskInfo -TaskName $TaskName

    Save-Result "ok" ("Task state: " + $task.State + "; last result: " + $info.LastTaskResult)

    Write-Host ""
    Write-Host "CONFIGURAZIONE COMPLETATA." -ForegroundColor Green
    Write-Host ("Task Windows: " + $TaskName + " [" + $task.State + "]")
    Write-Host "Debug logging: ATTIVO"
    Write-Host ("Log directory: " + $LogsDir)
    Write-Host ""
    Write-Host "Puoi chiudere questa finestra." -ForegroundColor Green
} catch {
    Save-Result "error" $_.Exception.Message
    Write-Host ""
    Write-Host ("ERRORE: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "La finestra resta aperta per permetterti di leggere l'errore."
} finally {
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    Write-Host ""
    Read-Host "Premi INVIO per chiudere"
}
