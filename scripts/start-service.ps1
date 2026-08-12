$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $projectRoot ".manga-translate"
$pidFile = Join-Path $runtimeDir "service.pid"
$stdoutLog = Join-Path $runtimeDir "service.log"
$stderrLog = Join-Path $runtimeDir "service-error.log"

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$engineExe = Join-Path $projectRoot "engine\target\release\manga-engine.exe"
if (-not (Test-Path $engineExe) -and $env:ENGINE_MODE -ne "passthrough") {
    Write-Output "manga-engine is missing; building it from Koharu source..."
    & (Join-Path $PSScriptRoot "build-engine.ps1")
}

if (Test-Path $pidFile) {
    $existingPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
        Write-Output "Manga Translate service đang chạy (PID $existingPid)."
        exit 0
    }
}

$process = Start-Process -FilePath "node" `
    -ArgumentList "server/src/index.mjs" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

Set-Content -Path $pidFile -Value $process.Id
Write-Output "Đã khởi động Manga Translate service (PID $($process.Id))."
