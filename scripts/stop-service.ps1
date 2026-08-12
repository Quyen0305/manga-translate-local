$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidFile = Join-Path $projectRoot ".manga-translate\service.pid"

if (!(Test-Path $pidFile)) {
    Write-Output "Không tìm thấy service đang chạy."
    exit 0
}

$servicePid = Get-Content $pidFile -ErrorAction SilentlyContinue
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid" -ErrorAction SilentlyContinue
$expectedScript = (Join-Path $projectRoot "server\src\index.mjs")
if ($process -and $process.CommandLine -like "*server/src/index.mjs*") {
    $engineChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId = $servicePid" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "manga-engine.exe" -or
            ($_.Name -eq "koharu.exe" -and $_.CommandLine -like "*--port 40722*")
        }
    foreach ($child in $engineChildren) {
        Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $servicePid
    Write-Output "Đã dừng Manga Translate service (PID $servicePid)."
} else {
    Write-Output "PID không thuộc Manga Translate service; không dừng tiến trình."
}
Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
