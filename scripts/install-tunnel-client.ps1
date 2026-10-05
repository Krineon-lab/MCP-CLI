$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $Root ".rob-dc\bin"
$Temp = Join-Path $env:TEMP ("rob-tunnel-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $BinDir, $Temp | Out-Null

try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/openai/tunnel-client/releases/latest" -Headers @{ "User-Agent" = "Rob-Desktop-Commander" }
    $tag = [string]$release.tag_name
    $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) { "arm64" } else { "amd64" }
    $assetName = "tunnel-client-$tag-windows-$arch.zip"
    $asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
    if (-not $asset) { throw "Release asset not found: $assetName" }
    if (-not $asset.digest -or -not ([string]$asset.digest).StartsWith("sha256:")) { throw "GitHub release did not provide a SHA-256 digest for $assetName" }

    $zip = Join-Path $Temp $assetName
    Write-Host "Downloading official OpenAI tunnel-client $tag ($arch)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip

    $expected = ([string]$asset.digest).Substring(7).ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "SHA-256 mismatch for $assetName" }

    $expanded = Join-Path $Temp "expanded"
    Expand-Archive -Path $zip -DestinationPath $expanded -Force
    $exe = Get-ChildItem $expanded -Recurse -Filter "tunnel-client.exe" | Select-Object -First 1
    if (-not $exe) { throw "tunnel-client.exe not found in release archive" }

    $destination = Join-Path $BinDir "tunnel-client.exe"
    Copy-Item $exe.FullName $destination -Force
    & $destination --version
    Write-Host ""
    Write-Host "Installed and SHA-256 verified:"
    Write-Host "  $destination"
} finally {
    Remove-Item $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
