$shortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "Manga Translate Local.lnk"
if (Test-Path $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath
    Write-Output "Đã xóa Manga Translate khỏi Startup."
} else {
    Write-Output "Không tìm thấy shortcut Startup."
}
