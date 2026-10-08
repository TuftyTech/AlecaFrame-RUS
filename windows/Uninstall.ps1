# Полное удаление AlecaFrame-RU: агент, ярлыки, запись в «Приложениях», исходные файлы AlecaFrame.
# Запускается из Uninstall.cmd и из «Параметры -> Приложения» (оттуда с -Pause).
param([switch]$Pause)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AlecaFrameRU.psm1') -Force

$paths = Get-AfruPaths
$exitCode = 0

function Remove-StateFolder {
    # Этот скрипт может лежать внутри удаляемой папки: уходим из неё, а если Windows держит файл — удаляем чуть позже.
    Set-Location -LiteralPath ([IO.Path]::GetTempPath())
    if (-not (Test-Path -LiteralPath $paths.State)) { return }
    try { Remove-Item -LiteralPath $paths.State -Recurse -Force }
    catch {
        Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden `
            -ArgumentList "/c ping -n 4 127.0.0.1 >nul & rmdir /s /q `"$($paths.State)`""
    }
}

try {
    Write-Host ''
    $null = Stop-AfruAgent -AgentPath $paths.Agent
    $null = Stop-AfruLegacySession

    # Overwolf, запущенный агентом, работает без проверки файлов: перезапускаем его обычным образом.
    $overwolf = $null
    $flagState = Get-AfruFlagState -Processes @(Get-AfruOverwolfProcess) -Flags (Get-AfruFlags $false)
    if ($flagState -eq 'ok') {
        try { $overwolf = Find-AfruOverwolf } catch { }
        Write-Host '  Закрываю Overwolf, запущенный с отключённой проверкой файлов...'
        Stop-AfruOverwolf
    }

    $count = Restore-AfruAll -ExtensionsRoot $paths.Extensions -BackupRoot $paths.Backup
    Write-Host "  Исходные файлы AlecaFrame возвращены (изменённых страниц: $count)."
    Unregister-AfruIntegration -Paths $paths
    Write-Host '  Удалены автозапуск, ярлыки «AlecaFrame (русский)» и запись в «Приложениях».'
    Remove-StateFolder

    if ($overwolf) {
        Start-Process -FilePath $overwolf.Overwolf
        Write-Host '  Overwolf запущен заново, как обычно.'
    }
    Write-Host '  Готово: AlecaFrame-RU удалён. AlecaFrame работает как обычно, на английском.' -ForegroundColor Green
}
catch {
    Write-Host "  Ошибка: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}
if ($Pause) { $null = Read-Host '  Нажмите Enter, чтобы закрыть окно' }
exit $exitCode
