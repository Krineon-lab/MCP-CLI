$ErrorActionPreference = "SilentlyContinue"

$Root = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $Root ".rob-dc"
$LogsDir = Join-Path $StateDir "logs"
$HealthUrlFile = Join-Path $StateDir "tunnel-health-url.txt"

$mutex = New-Object System.Threading.Mutex($false, "Local\RobDesktopCommanderActivityConsole")
$acquired = $false

try {
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) { exit 0 }

    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
    try { chcp 65001 | Out-Null } catch {}
    try { $Host.UI.RawUI.WindowTitle = "Rob Desktop Commander - Live Activity" } catch {}

    $I = @{
        Rocket = [char]::ConvertFromUtf32(0x1F680)
        Green = [char]::ConvertFromUtf32(0x1F7E2)
        Red = [char]::ConvertFromUtf32(0x1F534)
        Yellow = [char]::ConvertFromUtf32(0x1F7E1)
        Book = [char]::ConvertFromUtf32(0x1F4D6)
        Write = [char]::ConvertFromUtf32(0x270D)
        Folder = [char]::ConvertFromUtf32(0x1F4C2)
        Search = [char]::ConvertFromUtf32(0x1F50E)
        Compass = [char]::ConvertFromUtf32(0x1F9ED)
        Bolt = [char]::ConvertFromUtf32(0x26A1)
        Desktop = [char]::ConvertFromUtf32(0x1F5A5)
        Chart = [char]::ConvertFromUtf32(0x1F4CA)
        Log = [char]::ConvertFromUtf32(0x1FAB5)
        Stop = [char]::ConvertFromUtf32(0x1F6D1)
        Clock = [char]::ConvertFromUtf32(0x23F1)
        Check = [char]::ConvertFromUtf32(0x2705)
        Cross = [char]::ConvertFromUtf32(0x274C)
        Gear = [char]::ConvertFromUtf32(0x2699)
        Retry = [char]::ConvertFromUtf32(0x1F501)
        Batch = [char]::ConvertFromUtf32(0x1F4E6)
        Link = [char]::ConvertFromUtf32(0x1F517)
    }

    function Write-Activity([string]$Icon, [ConsoleColor]$Color, [string]$Message) {
        Write-Host ("{0} {1}" -f $Icon, $Message) -ForegroundColor $Color
    }

    function Short([object]$Value, [int]$Max = 120) {
        if ($null -eq $Value) { return "" }
        $s = [string]$Value
        $s = $s -replace "[\r\n\t]+", " "
        if ($s.Length -gt $Max) { return $s.Substring(0, $Max - 1) + "..." }
        return $s
    }

    function Preview([object]$Object, [string]$Name) {
        if ($null -eq $Object) { return "" }
        $property = $Object.PSObject.Properties[$Name]
        if ($null -eq $property) { return "" }
        $value = $property.Value
        if ($null -eq $value) { return "" }
        $previewProperty = $value.PSObject.Properties["preview"]
        if ($null -ne $previewProperty) { return (Short $previewProperty.Value) }
        return (Short $value)
    }

    function Tool-Icon([string]$Tool) {
        switch -Regex ($Tool) {
            "^fs_read" { return $I.Book }
            "^fs_write|^fs_patch" { return $I.Write }
            "^fs_list|^fs_manage" { return $I.Folder }
            "^search$" { return $I.Search }
            "^workspace_inspect$" { return $I.Compass }
            "^exec" { return $I.Bolt }
            "^process$" { return $I.Desktop }
            "^rob_status$" { return $I.Chart }
            "^rob_logging$" { return $I.Log }
            default { return $I.Gear }
        }
    }

    function Local-Time([string]$Timestamp) {
        try { return ([DateTimeOffset]::Parse($Timestamp).ToLocalTime().ToString("HH:mm:ss")) }
        catch { return (Get-Date -Format "HH:mm:ss") }
    }

    function Render-Event([object]$Event) {
        if ($null -eq $Event -or [string]::IsNullOrWhiteSpace([string]$Event.event)) { return }
        $t = Local-Time $Event.ts

        switch ([string]$Event.event) {
            "server.starting" {
                $version = Preview $Event.data "version"
                Write-Activity $I.Rocket Cyan ("{0} Rob Desktop Commander v{1} avviato" -f $t, $version)
            }
            "tool.start" {
                $tool = Preview $Event.data "tool"
                $args = $Event.data.args
                $detail = ""
                if ($tool -eq "search") {
                    $q = Preview $args "query"
                    $p = Preview $args "path"
                    $detail = (' query="{0}"  in {1}' -f (Short $q 70), (Short $p 90))
                } elseif ($tool -in @("fs_read_many","fs_write_many")) {
                    $items = if ($tool -eq "fs_read_many") { $args.paths } else { $args.files }
                    $count = if ($null -ne $items) { @($items).Count } else { 0 }
                    $detail = " batch=" + $count
                } elseif ($tool -eq "fs_patch" -and $null -ne $args.files) {
                    $detail = " batch=" + @($args.files).Count
                } elseif ($tool -like "fs_*") {
                    $p = Preview $args "path"
                    if ($p) { $detail = " " + (Short $p 120) }
                } elseif ($tool -eq "exec_batch") {
                    $count = if ($null -ne $args.commands) { @($args.commands).Count } else { 0 }
                    $detail = " batch=" + $count
                } elseif ($tool -like "exec*") {
                    $c = Preview $args "command"
                    if ($c) { $detail = " " + (Short $c 125) }
                } elseif ($tool -eq "process") {
                    $action = Preview $args "action"
                    $c = Preview $args "command"
                    $detail = " " + $action
                    if ($c) { $detail += " " + (Short $c 110) }
                } elseif ($tool -eq "workspace_inspect") {
                    $p = Preview $args "path"
                    if ($p) { $detail = " " + (Short $p 120) }
                }
                Write-Activity (Tool-Icon $tool) White ("{0} START {1}{2}" -f $t, $tool, $detail)
            }
            "tool.end" {
                $tool = Preview $Event.data "tool"
                $ms = [math]::Round([double]$Event.data.durationMs, 1)
                $queue = [math]::Round([double]$Event.data.queueWaitMs, 1)
                $suffix = if ($queue -gt 0) { ("  queue {0}ms" -f $queue) } else { "" }
                Write-Activity $I.Check Green ("{0} DONE  {1}  {2}ms{3}" -f $t, $tool, $ms, $suffix)
            }
            "tool.error" {
                $tool = Preview $Event.data "tool"
                $msg = Preview $Event.data "message"
                Write-Activity $I.Cross Red ("{0} ERROR {1}  {2}" -f $t, $tool, (Short $msg 150))
            }
            "process.started" {
                $pidValue = $Event.data.pid
                $cmd = Preview $Event.data "command"
                Write-Activity $I.Desktop DarkCyan ("{0} PID {1} avviato  {2}" -f $t, $pidValue, (Short $cmd 125))
            }
            "process.closed" {
                $code = $Event.data.exitCode
                $pidValue = $Event.data.pid
                $ms = [math]::Round([double]$Event.data.durationMs, 0)
                if ($code -eq 0) {
                    Write-Activity $I.Check DarkGreen ("{0} PID {1} chiuso  exit=0  {2}ms" -f $t, $pidValue, $ms)
                } else {
                    Write-Activity $I.Yellow Yellow ("{0} PID {1} chiuso  exit={2}  {3}ms" -f $t, $pidValue, $code, $ms)
                }
            }
            "process.timeout" {
                Write-Activity $I.Clock Yellow ("{0} TIMEOUT PID {1}" -f $t, $Event.data.pid)
            }
            "process.kill" {
                Write-Activity $I.Stop Yellow ("{0} KILL PID {1}" -f $t, $Event.data.pid)
            }
            "process.kill_failed" {
                $msg = Preview $Event.data "message"
                Write-Activity $I.Cross Red ("{0} KILL FAILED PID {1}  {2}" -f $t, $Event.data.pid, (Short $msg 120))
            }
            "process.exit_drain_timeout" {
                Write-Activity $I.Yellow Yellow ("{0} pipe ereditata chiusa dopo uscita PID {1}" -f $t, $Event.data.pid)
            }
            "search.ripgrep_retry" {
                $attempt = $Event.data.attempt
                $delay = $Event.data.delayMs
                Write-Activity $I.Retry Yellow ("{0} ripgrep temporaneamente non disponibile | retry {1} tra {2}ms" -f $t, $attempt, $delay)
            }
        }
    }

    $lastHealth = ""
    function Update-Health {
        if (-not (Test-Path $HealthUrlFile)) { return }
        try {
            $url = (Get-Content -Raw $HealthUrlFile).Trim()
            if (-not $url) { return }
            $health = Invoke-RestMethod -Uri ($url + "/health?details=true") -TimeoutSec 2
            $control = $health.components.'control-plane'.state
            $mcp = $health.components.mcp.details.child_state
            $state = "{0}|{1}|{2}" -f $health.ready, $control, $mcp
            if ($state -ne $script:lastHealth) {
                $script:lastHealth = $state
                if ($health.ready -and $mcp -eq "running") {
                    Write-Activity $I.Green Green ("Tunnel READY | control-plane {0} | MCP {1}" -f $control, $mcp)
                } else {
                    Write-Activity $I.Yellow Yellow ("Tunnel ready={0} | control-plane {1} | MCP {2}" -f $health.ready, $control, $mcp)
                }
            }
        } catch {
            $state = "unreachable"
            if ($state -ne $script:lastHealth) {
                $script:lastHealth = $state
                Write-Activity $I.Red Red "Tunnel health non raggiungibile; nuovo tentativo automatico."
            }
        }
    }

    Clear-Host
    Write-Host "============================================================" -ForegroundColor DarkGray
    Write-Activity $I.Rocket Cyan "ROB DESKTOP COMMANDER - LIVE ACTIVITY"
    Write-Host "  Chiudere questa finestra NON arresta il tunnel." -ForegroundColor DarkGray
    Write-Host "  I payload completi non vengono mostrati." -ForegroundColor DarkGray
    Write-Host "============================================================" -ForegroundColor DarkGray
    Update-Health

    $stream = $null
    $reader = $null
    $currentPath = ""
    $firstOpen = $true
    $nextLogScan = [DateTime]::MinValue
    $nextHealth = [DateTime]::MinValue

    while ($true) {
        $now = Get-Date

        # Directory scans are intentionally throttled: the active file only changes on
        # logger rotation/restart, so checking once per second is ample.
        if ($now -ge $nextLogScan) {
            $nextLogScan = $now.AddSeconds(1)
            $latest = Get-ChildItem $LogsDir -Filter "rob-dc-*.jsonl" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime |
                Select-Object -Last 1

            if ($null -ne $latest -and $latest.FullName -ne $currentPath) {
                if ($null -ne $reader) { $reader.Dispose() }
                if ($null -ne $stream) { $stream.Dispose() }

                $currentPath = $latest.FullName
                $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
                $stream = New-Object IO.FileStream($currentPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
                if ($firstOpen) {
                    [void]$stream.Seek(0, [IO.SeekOrigin]::End)
                    $firstOpen = $false
                }
                $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true, 4096, $true)
                Write-Host ("--- log: {0} ---" -f $latest.Name) -ForegroundColor DarkGray
            }
        }

        $line = if ($null -ne $reader) { $reader.ReadLine() } else { $null }
        if ($null -ne $line) {
            try { Render-Event ($line | ConvertFrom-Json) } catch {}
            continue
        }

        if ($now -ge $nextHealth) {
            $nextHealth = $now.AddSeconds(5)
            Update-Health
        }

        Start-Sleep -Milliseconds 150
    }
} finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
    if ($acquired) { $mutex.ReleaseMutex() | Out-Null }
    $mutex.Dispose()
}
