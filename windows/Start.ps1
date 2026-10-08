$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AlecaFrameRU.psm1') -Force

$appId          = Get-AfruAppId
$repoRoot       = Split-Path -Parent $PSScriptRoot
$localizer      = Join-Path (Join-Path $repoRoot 'dist') 'alecaframe-ru.js'
$extensionsRoot = Join-Path $env:LOCALAPPDATA "Overwolf\Extensions\$appId"
$logRoot        = Join-Path $env:LOCALAPPDATA 'Overwolf\Log'
$stateRoot      = Join-Path $env:LOCALAPPDATA 'AlecaFrame-RU'
$consentFile    = Join-Path $stateRoot 'consent-v1'
$launcherLog    = Join-Path $stateRoot 'launcher.log'
$overwolfFlags  = '--ow-disable-features=extension-validation,read-opk-from-memory'

function Write-Log([string]$Message) {
    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    Add-Content -LiteralPath $launcherLog -Value ("{0} {1}" -f (Get-Date -Format o), $Message) -Encoding UTF8
}

function Step([string]$Message) { Write-Host "  $Message"; Write-Log $Message }

function Confirm-Consent {
    if (Test-Path -LiteralPath $consentFile) { return }
    Write-Host ''
    Write-Host '  AlecaFrame-RU: русский интерфейс для AlecaFrame' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  Что сейчас произойдёт:'
    Write-Host '   1. Overwolf будет закрыт и запущен заново (все его приложения перезапустятся).'
    Write-Host '   2. В 9 страниц AlecaFrame будет добавлена одна строка, подключающая файл перевода.'
    Write-Host '   3. Пока открыто это окно, Overwolf работает с ОТКЛЮЧЕННОЙ проверкой целостности'
    Write-Host '      файлов приложений (флаг extension-validation). Это касается ВСЕХ приложений Overwolf,'
    Write-Host '      не только AlecaFrame. Без этого Overwolf закрыл бы изменённый AlecaFrame.'
    Write-Host '   4. Когда вы выйдете из Overwolf, все файлы вернутся в исходное состояние.'
    Write-Host ''
    Write-Host '  Реклама, подписка и платные функции не затрагиваются.'
    Write-Host ''
    $answer = Read-Host '  Продолжить? (да / нет)'
    if ($answer.Trim() -notmatch '^(да|д|y|yes)$') {
        throw [System.OperationCanceledException]::new('Отменено.')
    }
    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    Set-Content -LiteralPath $consentFile -Value (Get-Date -Format o)
}

function Wait-LogLine([string]$Path, [string]$Pattern, [datetime]$Since, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $failure = Get-AfruIntegrityFailure -Since $Since -LogRoot $logRoot
        if ($failure) {
            throw ("Overwolf закрыл AlecaFrame из-за проверки целостности (HashMismatch). Эта сборка Overwolf " +
                   "не принимает такой способ подключения перевода. Файлы будут возвращены. Журнал: " + $failure.Trace)
        }
        if (Test-Path -LiteralPath $Path) {
            $item = Get-Item -LiteralPath $Path
            if ($item.LastWriteTime -ge $Since.AddSeconds(-2) -and
                (Get-Content -LiteralPath $Path -Tail 80 -ErrorAction SilentlyContinue) -match $Pattern) { return $true }
        }
        Start-Sleep -Milliseconds 500
    }
    $false
}

$versionDir = $null
$overwolfStarted = $false
$failed = $false
$backupRoot = $null
try {
    Write-Host ''
    if (-not (Test-Path -LiteralPath $localizer)) { throw "Не найден файл перевода: $localizer" }
    Confirm-Consent

    $install = Find-AfruOverwolf
    $versionDir = Get-AfruVersionDirectory -ExtensionsRoot $extensionsRoot
    $backupRoot = Join-Path (Join-Path $stateRoot 'backup') $versionDir.Name
    Step "AlecaFrame $($versionDir.Name), Overwolf: $($install.Overwolf)"

    Step 'Закрываю Overwolf...'
    Stop-AfruOverwolf
    # На случай прерванного прошлого запуска.
    $null = Remove-AfruLocalizer -VersionPath $versionDir.FullName -ExtensionsRoot $extensionsRoot -BackupRoot $backupRoot

    Step 'Запускаю Overwolf...'
    $startedAt = Get-Date
    Start-Process -FilePath $install.Overwolf -ArgumentList $overwolfFlags
    $overwolfStarted = $true
    Start-Sleep -Seconds 6

    # Первый запуск идёт на нетронутых файлах, чтобы AlecaFrame спокойно инициализировался.
    Step 'Запускаю AlecaFrame...'
    $null = Start-AfruApp -Launcher $install.Launcher -TimeoutSeconds 120 -Since $startedAt
    $bgLog = Join-Path $env:LOCALAPPDATA 'Overwolf\Log\Apps\AlecaFrame\BackGround.html.log'
    if (-not (Wait-LogLine $bgLog 'Plugin initialization successful!' $startedAt 90)) {
        Write-Log 'Нет сообщения об инициализации за 90 с, продолжаю.'
    }
    Start-Sleep -Seconds 3

    Step 'Подключаю русский интерфейс...'
    $patchedAt = Get-Date
    $pages = Add-AfruLocalizer -VersionPath $versionDir.FullName -ExtensionsRoot $extensionsRoot `
        -LocalizerSource $localizer -BackupRoot $backupRoot
    Write-Log ("Страницы: " + ($pages -join ', '))
    Stop-AfruRenderer
    Start-Sleep -Seconds 3
    $null = Start-AfruApp -Launcher $install.Launcher -TimeoutSeconds 120 -Since $patchedAt

    $mainLog = Join-Path $env:LOCALAPPDATA 'Overwolf\Log\Apps\AlecaFrame\MainWindow.html.log'
    if (-not (Wait-LogLine $mainLog '\[AlecaFrame-RU\] loaded' $patchedAt 60)) {
        throw "Перевод не загрузился (в журнале AlecaFrame нет отметки). Подробности: $launcherLog"
    }

    Write-Host ''
    Write-Host '  Готово: AlecaFrame на русском.' -ForegroundColor Green
    Write-Host '  НЕ ЗАКРЫВАЙТЕ это окно. Когда закончите, выйдите из Overwolf (значок в трее -> Exit):'
    Write-Host '  файлы AlecaFrame вернутся в исходное состояние, и окно закроется само.'
    Write-Log 'Русский интерфейс загружен.'
    while (Get-Process -Name 'Overwolf' -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }
    Write-Log 'Overwolf закрыт пользователем.'
}
catch [System.OperationCanceledException] {
    Write-Host '  Отменено, ничего не изменено.'
    exit 0
}
catch {
    $failed = $true
    $message = $_.Exception.Message
    Write-Log "ОШИБКА: $message"
    Write-Host ''
    Write-Host "  Ошибка: $message" -ForegroundColor Red
    Write-Host '  Файлы AlecaFrame возвращаются в исходное состояние. Если AlecaFrame всё равно не открывается, запустите Uninstall.cmd.'
    exit 1
}
finally {
    if ($versionDir) {
        try {
            if ($overwolfStarted -and $failed) { Stop-AfruOverwolf }
            $null = Remove-AfruLocalizer -VersionPath $versionDir.FullName -ExtensionsRoot $extensionsRoot -BackupRoot $backupRoot
            Write-Log 'Файлы AlecaFrame возвращены в исходное состояние.'
        }
        catch { Write-Log "ОШИБКА при возврате файлов: $($_.Exception.Message)" }
    }
}
