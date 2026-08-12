$ErrorActionPreference = "Stop"
$trayScript = Join-Path $PSScriptRoot "tray-controller.ps1"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$arguments = "-NoProfile -ExecutionPolicy Bypass -STA -File `"$trayScript`""

Start-Process -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden | Out-Null
