$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "Manga Translate Local.lnk"
$scriptPath = Join-Path $projectRoot "scripts\start-service.ps1"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = "Khởi động Manga Translate local service"
$shortcut.Save()

Write-Output "Đã thêm Manga Translate vào Startup: $shortcutPath"
