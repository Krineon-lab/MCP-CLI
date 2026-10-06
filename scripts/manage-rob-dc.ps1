param(
    [ValidateSet("menu","status","start","restart","stop","monitor","monitor-stop","logs")]
    [string]$Action = "menu"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$TaskName = "Rob Desktop Commander"
$ProfileDir = Join-Path $Root ".rob-dc\tunnel-profiles"
$HealthFile = Join-Path $Root ".rob-dc\tunnel-health-url.txt"
$ActivityScript = Join-Path $PSScriptRoot "show-activity.ps1"
$LogsDir = Join-Path $Root ".rob-dc\logs"

function Get-TunnelProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -like "*--profile rob-desktop*" -and
            $_.CommandLine -like "*$ProfileDir*"
        })
}

function Get-McpProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "MCP-CLI[/\\]dist[/\\]index\.js" })
}

function Get-MonitorProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "-File .*show-activity\.ps1" })
}

function Show-Status {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $tunnels = @(Get-TunnelProcesses)
    $nodes = @(Get-McpProcesses)
    $monitors = @(Get-MonitorProcesses)

    $ready = $false
    $live = $false
    $control = "n/a"
    $mcp = "n/a"

    if (Test-Path $HealthFile) {
        try {
            $url = (Get-Content -Raw $HealthFile).Trim()
            if ($url) {
                $h = Invoke-RestMethod -Uri ($url + "/health?details=true") -TimeoutSec 2
                $ready = [bool]$h.ready
                $live = [bool]$h.live
                $control = [string]$h.components.'control-plane'.state
                $mcp = [string]$h.components.mcp.details.child_state
            }
        } catch {}
    }

    Write-Host ""
    Write-Host "Rob Desktop Commander" -ForegroundColor Cyan
    Write-Host "---------------------"
    Write-Host ("Task       : " + $(if ($task) { $task.State } else { "MISSING" }))
    Write-Host ("Tunnel     : " + $tunnels.Count)
    Write-Host ("MCP node   : " + $nodes.Count)
    Write-Host ("Monitor    : " + $monitors.Count)
    Write-Host ("Ready      : " + $ready)
    Write-Host ("Live       : " + $live)
    Write-Host ("Control    : " + $control)
    Write-Host ("MCP child  : " + $mcp)
    Write-Host ""
}

function Stop-Monitor {
    foreach ($proc in @(Get-MonitorProcesses)) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Start-Monitor {
    if (-not (Test-Path $ActivityScript)) {
        throw "Monitor script not found: $ActivityScript"
    }

    # Always reopen visibly so the command is useful even if a hidden/stale monitor exists.
    Stop-Monitor
    Start-Sleep -Milliseconds 250

    $wt = Get-Command "wt.exe" -ErrorAction SilentlyContinue
    if ($wt) {
        $args = 'new-tab --title "Rob Desktop Commander - Live Activity" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $ActivityScript + '"'
        Start-Process -FilePath $wt.Source -ArgumentList $args | Out-Null
    } else {
        $args = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $ActivityScript + '"'
        Start-Process -FilePath "powershell.exe" -ArgumentList $args -WindowStyle Normal | Out-Null
    }

    Write-Host "Monitor aperto." -ForegroundColor Green
}

function Stop-RobDc {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

    $tunnels = @(Get-TunnelProcesses)
    foreach ($tunnel in $tunnels) {
        # Capture only the direct MCP child before killing the tunnel.
        $children = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ParentProcessId -eq $tunnel.ProcessId -and
                $_.Name -eq "node.exe" -and
                $_.CommandLine -match "MCP-CLI[/\\]dist[/\\]index\.js"
            })

        Stop-Process -Id $tunnel.ProcessId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 200

        foreach ($child in $children) {
            Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    # Clean any remaining direct Rob Desktop Commander node, but never its descendants.
    foreach ($node in @(Get-McpProcesses)) {
        Stop-Process -Id $node.ProcessId -Force -ErrorAction SilentlyContinue
    }

    Stop-Monitor
    Remove-Item $HealthFile -Force -ErrorAction SilentlyContinue
    Write-Host "Rob Desktop Commander fermato." -ForegroundColor Yellow
}

function Start-RobDc {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        throw "Task '$TaskName' non trovato. Esegui prima configure-tunnel-autostart.ps1."
    }

    if (@(Get-TunnelProcesses).Count -gt 0) {
        Write-Host "Rob Desktop Commander e' gia' avviato." -ForegroundColor Yellow
        if (@(Get-MonitorProcesses).Count -eq 0) { Start-Monitor }
        return
    }

    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Avvio Rob Desktop Commander..." -ForegroundColor Cyan

    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 500
        if (Test-Path $HealthFile) {
            try {
                $url = (Get-Content -Raw $HealthFile).Trim()
                $h = Invoke-RestMethod -Uri ($url + "/health?details=true") -TimeoutSec 1
                if ($h.ready) {
                    Write-Host "Rob Desktop Commander READY." -ForegroundColor Green
                    return
                }
            } catch {}
        }
    } while ((Get-Date) -lt $deadline)

    Write-Host "Avviato, ma health non ancora READY. Usa 'RobDC status' tra qualche secondo." -ForegroundColor Yellow
}

function Restart-RobDc {
    Write-Host "Riavvio Rob Desktop Commander..." -ForegroundColor Cyan
    Stop-RobDc
    Start-Sleep -Milliseconds 500
    Start-RobDc
}

function Open-Logs {
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
    Start-Process explorer.exe -ArgumentList ('"' + $LogsDir + '"') | Out-Null
}

function Show-Menu {
    while ($true) {
        Clear-Host
        Write-Host "Rob Desktop Commander" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  1  Stato"
        Write-Host "  2  Avvia MCP"
        Write-Host "  3  Riavvia MCP"
        Write-Host "  4  Ferma MCP"
        Write-Host "  5  Apri monitor live"
        Write-Host "  6  Chiudi monitor"
        Write-Host "  7  Apri cartella log"
        Write-Host "  0  Esci"
        Write-Host ""

        $choice = Read-Host "Scelta"
        try {
            switch ($choice) {
                "1" { Show-Status; Read-Host "Invio per continuare" | Out-Null }
                "2" { Start-RobDc; Start-Sleep -Seconds 1 }
                "3" { Restart-RobDc; Start-Sleep -Seconds 1 }
                "4" { Stop-RobDc; Start-Sleep -Seconds 1 }
                "5" { Start-Monitor; Start-Sleep -Seconds 1 }
                "6" { Stop-Monitor; Start-Sleep -Seconds 1 }
                "7" { Open-Logs }
                "0" { return }
            }
        } catch {
            Write-Host ("ERRORE: " + $_.Exception.Message) -ForegroundColor Red
            Read-Host "Invio per continuare" | Out-Null
        }
    }
}

switch ($Action) {
    "menu"         { Show-Menu }
    "status"       { Show-Status }
    "start"        { Start-RobDc; Show-Status }
    "restart"      { Restart-RobDc; Show-Status }
    "stop"         { Stop-RobDc; Show-Status }
    "monitor"      { Start-Monitor }
    "monitor-stop" { Stop-Monitor }
    "logs"         { Open-Logs }
}
