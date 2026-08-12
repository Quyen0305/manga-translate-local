$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $projectRoot ".manga-translate"
$startScript = Join-Path $PSScriptRoot "start-service.ps1"
$stopScript = Join-Path $PSScriptRoot "stop-service.ps1"
$installStartupScript = Join-Path $PSScriptRoot "install-startup.ps1"
$uninstallStartupScript = Join-Path $PSScriptRoot "uninstall-startup.ps1"
$startupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "Manga Translate Local.lnk"
$serviceHost = if ($env:SERVICE_HOST) { $env:SERVICE_HOST } else { "127.0.0.1" }
$servicePort = if ($env:SERVICE_PORT) { $env:SERVICE_PORT } else { "40721" }
$healthUrl = "http://${serviceHost}:${servicePort}/health"

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\MangaTranslateLocalTray", [ref]$createdNew)
if (-not $createdNew) {
    [System.Windows.Forms.MessageBox]::Show(
        "Manga Translate is already running in the notification area.",
        "Manga Translate",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    exit 0
}

[System.Windows.Forms.Application]::EnableVisualStyles()

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem("Status: checking...")
$statusItem.Enabled = $false
$toggleItem = New-Object System.Windows.Forms.ToolStripMenuItem("Start Service")
$openLogsItem = New-Object System.Windows.Forms.ToolStripMenuItem("Open Logs Folder")
$startupItem = New-Object System.Windows.Forms.ToolStripMenuItem("Start with Windows")
$startupItem.CheckOnClick = $false
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Exit Tray")
$stopAndExitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Stop Service and Exit")

[void]$contextMenu.Items.Add($statusItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($toggleItem)
[void]$contextMenu.Items.Add($openLogsItem)
[void]$contextMenu.Items.Add($startupItem)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($exitItem)
[void]$contextMenu.Items.Add($stopAndExitItem)

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.ContextMenuStrip = $contextMenu
$notifyIcon.Text = "Manga Translate"
$notifyIcon.Visible = $true

$script:serviceRunning = $false
$script:actionPending = $false
$script:actionStartedAt = [DateTime]::MinValue

function Test-MangaService {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        return $response.status -eq "ok"
    } catch {
        return $false
    }
}

function Start-ControlScript([string]$path) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$path`""
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList $arguments `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden | Out-Null
}

function Test-TrayStartup {
    if (-not (Test-Path -LiteralPath $startupShortcut)) { return $false }
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($startupShortcut)
        return $shortcut.Arguments -like "*start-tray.ps1*"
    } catch {
        return $false
    }
}

function Update-TrayState {
    $script:serviceRunning = Test-MangaService
    if ($script:serviceRunning) {
        $statusItem.Text = "Status: Service running"
        $toggleItem.Text = "Stop Service"
        $notifyIcon.Text = "Manga Translate - Service running"
    } else {
        $statusItem.Text = "Status: Service stopped"
        $toggleItem.Text = "Start Service"
        $notifyIcon.Text = "Manga Translate - Service stopped"
    }
    $startupItem.Checked = Test-TrayStartup
    $toggleItem.Enabled = $true
    $script:actionPending = $false
}

function Show-TrayStatus {
    Update-TrayState
    $notifyIcon.BalloonTipTitle = "Manga Translate"
    $notifyIcon.BalloonTipText = if ($script:serviceRunning) {
        "Local service is running. The engine starts automatically when translation begins."
    } else {
        "Local service is stopped. Right-click the icon to start it."
    }
    $notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $notifyIcon.ShowBalloonTip(3000)
}

$toggleItem.Add_Click({
    if ($script:actionPending) { return }
    $script:actionPending = $true
    $script:actionStartedAt = Get-Date
    $toggleItem.Enabled = $false
    if ($script:serviceRunning) {
        $statusItem.Text = "Status: stopping..."
        Start-ControlScript $stopScript
    } else {
        $statusItem.Text = "Status: starting..."
        Start-ControlScript $startScript
    }
})

$openLogsItem.Add_Click({
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    Start-Process -FilePath "explorer.exe" -ArgumentList "`"$runtimeDir`""
})

$startupItem.Add_Click({
    try {
        if (Test-TrayStartup) {
            & $uninstallStartupScript | Out-Null
        } else {
            & $installStartupScript | Out-Null
        }
        $startupItem.Checked = Test-TrayStartup
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "Manga Translate",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

$exitItem.Add_Click({
    [System.Windows.Forms.Application]::Exit()
})

$stopAndExitItem.Add_Click({
    if ($script:serviceRunning) {
        Start-ControlScript $stopScript
    }
    [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.Add_DoubleClick({ Show-TrayStatus })
$contextMenu.Add_Opening({ Update-TrayState })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    if (-not $script:actionPending) {
        Update-TrayState
    } else {
        $runningNow = Test-MangaService
        $actionAge = ((Get-Date) - $script:actionStartedAt).TotalSeconds
        if ($runningNow -ne $script:serviceRunning -or $actionAge -ge 30) {
            Update-TrayState
        }
    }
})
$timer.Start()

Update-TrayState
if (-not $script:serviceRunning) {
    $script:actionPending = $true
    $script:actionStartedAt = Get-Date
    $statusItem.Text = "Status: starting..."
    $toggleItem.Enabled = $false
    Start-ControlScript $startScript
}

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    $timer.Dispose()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    $contextMenu.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
