# Установка AlecaFrame-RU один раз. Дальше всё делает фоновый агент (windows\Agent.ps1):
# AlecaFrame открывается на русском и после перезагрузки Windows, и после обновлений AlecaFrame.
param([switch]$NoDesktop)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AlecaFrameRU.psm1') -Force

$paths = Get-AfruPaths
$sourceRoot = Split-Path -Parent $PSScriptRoot
$waitSeconds = 150

function Step([string]$Message) { Write-Host "  $Message" }

function Read-Yes([string]$Prompt) { "$(Read-Host $Prompt)".Trim() -match '^(да|д|y|yes)$' }

function Confirm-Consent {
    if (Test-Path -LiteralPath $paths.Consent) { return }
    Write-Host ''
    Write-Host '  Что сделает установка:'
    Write-Host "   1. Скопирует AlecaFrame-RU в $($paths.App)"
    Write-Host '      и добавит в автозагрузку Windows маленький фоновый процесс без окна (PowerShell).'
    Write-Host '   2. Когда запускается Overwolf, этот процесс перезапускает его с флагом, ОТКЛЮЧАЮЩИМ'
    Write-Host '      проверку целостности файлов приложений (extension-validation). Это касается ВСЕХ'
    Write-Host '      приложений Overwolf, пока AlecaFrame-RU установлен. Без этого Overwolf закроет'
    Write-Host '      изменённый AlecaFrame. Если ваша сборка Overwolf закроет его и с этим флагом,'
    Write-Host '      установка отдельно спросит про второй флаг (force-validation-report-only).'
    Write-Host '   3. В 9 страниц AlecaFrame добавляется одна строка, подключающая перевод. Когда Overwolf'
    Write-Host '      закрыт или запущен без флага, файлы возвращаются в исходный вид.'
    Write-Host '   4. Появятся ярлыки «AlecaFrame (русский)» на рабочем столе и в меню «Пуск».'
    Write-Host ''
    Write-Host '  Подписка и платные функции не затрагиваются. Удаление: Uninstall.cmd или'
    Write-Host '  «Параметры -> Приложения -> AlecaFrame-RU». Оно возвращает все файлы AlecaFrame.'
    Write-Host ''
    if (-not (Read-Yes '  Установить? (да / нет)')) {
        throw [System.OperationCanceledException]::new('Отменено, ничего не изменено.')
    }
    New-Item -ItemType Directory -Force -Path $paths.State | Out-Null
    Set-Content -LiteralPath $paths.Consent -Value (Get-Date -Format o)
}

# Агент спрашивает об этом через окно установки, если оно открыто (как Start.cmd в прошлой версии).
function Confirm-ReportOnly {
    Write-Host ''
    Write-Host '  Ваша сборка Overwolf проверяет файлы даже с флагом extension-validation и закрыла' -ForegroundColor Yellow
    Write-Host '  изменённый AlecaFrame (HashMismatch). Файлы AlecaFrame уже возвращены в исходный вид.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  Можно запускать Overwolf с ещё одним флагом: force-validation-report-only.'
    Write-Host '  С ним Overwolf по-прежнему сверяет файлы, но о несовпадениях только пишет в свой журнал'
    Write-Host '  и не закрывает приложение. Как и первый флаг, это касается ВСЕХ приложений Overwolf,'
    Write-Host '  пока AlecaFrame-RU установлен. Так же запускает китайский перевод DDA-007.'
    Write-Host ''
    $answer = if (Read-Yes '  Перезапустить Overwolf с этим флагом? Ответ запомнится. (да / нет)') { $paths.ReportOnly } else { $paths.ReportOnlyNo }
    Set-Content -LiteralPath $answer -Value (Get-Date -Format o)
    Write-Host ''
}

function Get-PackageVersion {
    $file = Join-Path $sourceRoot 'package.json'
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    try { [string](Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { '' }
}

# Агент пишет в файл status, что он делает. Показываем это, пока AlecaFrame не откроется на русском.
function Wait-Agent([int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $shown = ''
    $status = $null
    while ((Get-Date) -lt $deadline) {
        $status = Read-AfruStatus -Path $paths.Status
        if ($status) {
            # Итог печатается один раз, ниже.
            if ($status.Code -in 'loaded', 'blocked', 'admin') { return $status }
            $key = "$($status.Code)`t$($status.Message)"
            if ($key -ne $shown) {
                $shown = $key
                if ($status.Code -eq 'question') {
                    Confirm-ReportOnly
                    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
                }
                elseif ($status.Code -eq 'error') { Write-Host "   ! $($status.Message)" -ForegroundColor Yellow }
                else { Write-Host "   - $($status.Message)" -ForegroundColor DarkGray }
            }
        }
        Start-Sleep -Milliseconds 500
    }
    $status
}

try {
    Write-Host ''
    Write-Host '  AlecaFrame-RU: русский интерфейс для AlecaFrame' -ForegroundColor Cyan
    $localizer = Join-Path (Join-Path $sourceRoot 'dist') 'alecaframe-ru.js'
    if (-not (Test-Path -LiteralPath $localizer)) { throw "Не найден файл перевода: $localizer. Скачайте архив заново." }
    $install = Find-AfruOverwolf
    $versionDir = Get-AfruVersionDirectory -ExtensionsRoot $paths.Extensions
    Confirm-Consent

    $overwolfVersion = (Get-Item -LiteralPath $install.Overwolf).VersionInfo.FileVersion
    Write-Host ''
    Step "AlecaFrame $($versionDir.Name), Overwolf $overwolfVersion"

    if (Stop-AfruAgent -AgentPath $paths.Agent) { Step 'Остановлен прежний фоновый процесс (обновление).' }
    if (Stop-AfruLegacySession) { Step 'Закрыто окно Start.cmd из прошлой версии: он больше не нужен.' }

    $null = Install-AfruAppFiles -SourceRoot $sourceRoot -AppRoot $paths.App
    $icon = Join-Path $versionDir.FullName 'icon.ico'
    if (Test-Path -LiteralPath $icon) { Copy-Item -LiteralPath $icon -Destination $paths.Icon -Force }
    # Переустановка — это и способ попробовать снова после отказа или несовместимой сборки Overwolf.
    foreach ($stale in $paths.Blocked, $paths.ReportOnlyNo) {
        if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }
    }
    Register-AfruIntegration -Paths $paths -Version (Get-PackageVersion) -NoDesktop:$NoDesktop
    Step "Установлено в $($paths.App)"

    if (Test-Path -LiteralPath $paths.Status) { Remove-Item -LiteralPath $paths.Status -Force }
    Step 'Открываю AlecaFrame на русском (Overwolf перезапустится)...'
    Set-Content -LiteralPath $paths.Watcher -Value $PID
    Start-AfruAgent -AgentPath $paths.Agent -Launch
    $result = Wait-Agent $waitSeconds

    Write-Host ''
    $code = if ($result) { $result.Code } else { '' }
    switch ($code) {
        'loaded' {
            Write-Host '  Готово: AlecaFrame на русском.' -ForegroundColor Green
            Write-Host '  Больше ничего запускать не нужно. Открывайте AlecaFrame как обычно или ярлыком'
            Write-Host '  «AlecaFrame (русский)». Это окно можно закрыть, а папку с архивом — удалить.'
        }
        'blocked' { Write-Host "  $($result.Message)" -ForegroundColor Yellow }
        'admin' {
            Write-Host "  $($result.Message)" -ForegroundColor Yellow
            Write-Host '  Выйдите из Overwolf и запустите его обычным способом, без «Запуска от имени администратора».'
        }
        default {
            Write-Host '  AlecaFrame-RU установлен, но перевод ещё не подтвердился.' -ForegroundColor Yellow
            Write-Host '  Фоновый процесс продолжает работу: откройте AlecaFrame ярлыком «AlecaFrame (русский)».'
            Write-Host "  Если не поможет, создайте issue и приложите журнал: $($paths.Log)"
        }
    }
}
catch [System.OperationCanceledException] {
    Write-Host "  $($_.Exception.Message)"
    exit 0
}
catch {
    Write-Host ''
    Write-Host "  Ошибка: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    Remove-Item -LiteralPath $paths.Watcher -Force -ErrorAction SilentlyContinue
}
