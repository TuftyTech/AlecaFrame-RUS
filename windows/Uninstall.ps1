$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AlecaFrameRU.psm1') -Force

$appId          = Get-AfruAppId
$extensionsRoot = Join-Path $env:LOCALAPPDATA "Overwolf\Extensions\$appId"
$stateRoot      = Join-Path $env:LOCALAPPDATA 'AlecaFrame-RU'

try {
    Write-Host ''
    if (Get-Process -Name 'Overwolf' -ErrorAction SilentlyContinue) {
        Write-Host '  Закрываю Overwolf, чтобы вернуть файлы...'
        Stop-AfruOverwolf
    }
    if (Test-Path -LiteralPath $extensionsRoot) {
        $count = 0
        foreach ($dir in Get-ChildItem -LiteralPath $extensionsRoot -Directory) {
            $backupRoot = Join-Path (Join-Path $stateRoot 'backup') $dir.Name
            $count += @(Remove-AfruLocalizer -VersionPath $dir.FullName -ExtensionsRoot $extensionsRoot -BackupRoot $backupRoot).Count
        }
        Write-Host "  Исходные файлы AlecaFrame возвращены (изменённых страниц: $count)."
    }
    if (Test-Path -LiteralPath $stateRoot) { Remove-Item -LiteralPath $stateRoot -Recurse -Force }
    Write-Host '  Готово. Запускайте AlecaFrame как обычно, через Overwolf.' -ForegroundColor Green
}
catch {
    Write-Host "  Ошибка: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
