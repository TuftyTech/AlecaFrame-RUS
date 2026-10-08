# Проверка файловой логики установщика на поддельной папке AlecaFrame.
# Запуск: pwsh -NoProfile -File test/windows.tests.ps1
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'windows') 'AlecaFrameRU.psm1') -Force

$failures = 0
function Check([string]$Name, [bool]$Ok) {
    if ($Ok) { Write-Host "ok   $Name" } else { Write-Host "FAIL $Name"; $script:failures++ }
}
function Throws([scriptblock]$Block, [string]$Match = '') {
    try { & $Block | Out-Null; $false } catch { $_.Exception.Message -match $Match }
}
function Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("afru-test-" + [guid]::NewGuid().ToString('N'))
$ext = Join-Path $tmp 'Extensions'
$state = Join-Path $tmp 'state'
$src = Join-Path $tmp 'alecaframe-ru.js'
New-Item -ItemType Directory -Force -Path $ext, $state | Out-Null
Set-Content -LiteralPath $src -Value '/* localizer */'

function New-Version([string]$Name, [switch]$NoManifest) {
    $dir = Join-Path $ext $Name
    New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path (Join-Path $dir 'web') 'assets') 'js') | Out-Null
    if (-not $NoManifest) { Set-Content -LiteralPath (Join-Path $dir 'manifest.json') -Value '{}' }
    Get-Item -LiteralPath $dir
}

# Разные «формы» страниц: BOM + CRLF + кириллица в UTF-8, <HEAD> с атрибутами, одиночный LF.
function Write-Bytes([string]$Path, [byte[]]$Bytes) { [IO.File]::WriteAllBytes($Path, $Bytes) }
$utf8 = New-Object Text.UTF8Encoding($false)
$bom = [byte[]](0xEF, 0xBB, 0xBF)
$shapes = @{
    'main.html'                    = $bom + $utf8.GetBytes("<!DOCTYPE html>`r`n<html>`r`n<head>`r`n<title>Тест</title>`r`n</head>`r`n<body>Привет</body></html>`r`n")
    'AFBuilds.html'                = $utf8.GetBytes("<html><HEAD lang=`"en`"><meta charset=utf-8></HEAD><body></body></html>")
    'relicOverlay.html'            = $utf8.GetBytes("<html>`n<head >`n</head>`n<body>ё</body>`n</html>`n")
}

$v = New-Version '2.6.9'
$v2 = New-Version '2.6.10'
$vNoManifest = New-Version '2.7.0' -NoManifest
$null = New-Item -ItemType Directory -Force -Path (Join-Path $ext 'not-a-version')

# --- выбор версии
$picked = Get-AfruVersionDirectory -ExtensionsRoot $ext
Check 'выбирается наибольшая версия (2.6.10 > 2.6.9), без manifest.json и не-версии игнорируются' ($picked.Name -eq '2.6.10')
Check 'нет папки AlecaFrame -> понятная ошибка' (Throws { Get-AfruVersionDirectory -ExtensionsRoot (Join-Path $tmp 'nope') })

# --- добавление / идемпотентность / обратимость
$web = Join-Path $v2.FullName 'web'
foreach ($name in $shapes.Keys) { Write-Bytes (Join-Path $web $name) $shapes[$name] }
$before = @{}; foreach ($name in $shapes.Keys) { $before[$name] = Sha (Join-Path $web $name) }
$backup = Join-Path (Join-Path $state 'backup') '2.6.10'

$patched = @(Add-AfruLocalizer -VersionPath $v2.FullName -ExtensionsRoot $ext -LocalizerSource $src -BackupRoot $backup)
Check 'правятся только существующие страницы' ($patched.Count -eq 3)
$tag = '<script src="assets/js/alecaframe-ru.js" data-afru></script>'
$allTagged = $true; $once = $true
foreach ($name in $shapes.Keys) {
    $text = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes((Join-Path $web $name)))
    if (-not $text.Contains($tag)) { $allTagged = $false }
    if ($text.IndexOf($tag) -ne $text.LastIndexOf($tag)) { $once = $false }
}
Check 'тег вставлен во все три страницы' $allTagged
Check 'тег вставлен ровно один раз' $once
Check 'файл перевода скопирован' (Test-Path -LiteralPath (Join-Path (Join-Path (Join-Path $web 'assets') 'js') 'alecaframe-ru.js'))
$main = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes((Join-Path $web 'main.html')))
Check 'тег стоит сразу после <head>' ($main.Contains("<head>$tag"))
Check 'BOM и кириллица в main.html не повреждены' ((Sha (Join-Path $web 'main.html')) -ne $before['main.html'] -and ([IO.File]::ReadAllBytes((Join-Path $web 'main.html')))[0] -eq 0xEF)

$again = @(Add-AfruLocalizer -VersionPath $v2.FullName -ExtensionsRoot $ext -LocalizerSource $src -BackupRoot $backup)
Check 'повторное подключение ничего не меняет' ($again.Count -eq 0)

$removed = @(Remove-AfruLocalizer -VersionPath $v2.FullName -ExtensionsRoot $ext -BackupRoot $backup)
Check 'возврат трогает три страницы' ($removed.Count -eq 3)
$identical = $true
foreach ($name in $shapes.Keys) { if ((Sha (Join-Path $web $name)) -ne $before[$name]) { $identical = $false } }
Check 'после возврата файлы побайтово совпадают с исходными' $identical
Check 'файл перевода удалён' (-not (Test-Path -LiteralPath (Join-Path (Join-Path (Join-Path $web 'assets') 'js') 'alecaframe-ru.js')))
Check 'повторный возврат безопасен' (@(Remove-AfruLocalizer -VersionPath $v2.FullName -ExtensionsRoot $ext -BackupRoot $backup).Count -eq 0)

# возврат без резервной копии (удалена) тоже побайтово точен
$null = Add-AfruLocalizer -VersionPath $v2.FullName -ExtensionsRoot $ext -LocalizerSource $src -BackupRoot $backup
Remove-Item -LiteralPath $backup -Recurse -Force
$null = Remove-AfruLocalizer -VersionPath $v2.FullName -ExtensionsRoot $ext -BackupRoot $backup
$identical = $true
foreach ($name in $shapes.Keys) { if ((Sha (Join-Path $web $name)) -ne $before[$name]) { $identical = $false } }
Check 'возврат без резервной копии тоже точен (тег удаляется детерминированно)' $identical

# возврат подчищает и случай, когда страницу испортили сверх тега
$null = Add-AfruLocalizer -VersionPath $v2.FullName -ExtensionsRoot $ext -LocalizerSource $src -BackupRoot $backup
Add-Content -LiteralPath (Join-Path $web 'main.html') -Value '<!-- чужая правка -->'
$null = Remove-AfruLocalizer -VersionPath $v2.FullName -ExtensionsRoot $ext -BackupRoot $backup
Check 'если страница отличается от резервной копии, она восстанавливается из копии' ((Sha (Join-Path $web 'main.html')) -eq $before['main.html'])

# --- ошибки не оставляют половинчатого состояния
$v3 = New-Version '2.6.11'
$web3 = Join-Path $v3.FullName 'web'
Write-Bytes (Join-Path $web3 'main.html') $shapes['main.html']
Write-Bytes (Join-Path $web3 'AFBuilds.html') $utf8.GetBytes('<html><body>без head</body></html>')
$mainBefore = Sha (Join-Path $web3 'main.html')
Check 'страница без <head> -> ошибка' (Throws { Add-AfruLocalizer -VersionPath $v3.FullName -ExtensionsRoot $ext -LocalizerSource $src -BackupRoot (Join-Path $state 'b3') })
Check 'при ошибке ни одна страница не изменена' ((Sha (Join-Path $web3 'main.html')) -eq $mainBefore)
Check 'нет main.html -> ошибка' (Throws { Add-AfruLocalizer -VersionPath $vNoManifest.FullName -ExtensionsRoot $ext -LocalizerSource $src -BackupRoot (Join-Path $state 'b4') })
Check 'путь вне папки AlecaFrame отклоняется (по причине «Отказ»)' (Throws { Add-AfruLocalizer -VersionPath $tmp -ExtensionsRoot $ext -LocalizerSource $src -BackupRoot (Join-Path $state 'b5') } 'Отказ')
$escape = Join-Path (Join-Path $v2.FullName '..') '..'
Check 'путь с .. наружу отклоняется (по причине «Отказ»)' (Throws { Remove-AfruLocalizer -VersionPath $escape -ExtensionsRoot $ext -BackupRoot $state } 'Отказ')
Check 'сосед с общим префиксом имени (Extensions-evil) отклоняется' (Throws { Remove-AfruLocalizer -VersionPath ($ext + '-evil') -ExtensionsRoot $ext -BackupRoot $state } 'Отказ')

# --- журнал целостности
$logs = Join-Path $tmp 'Log'; New-Item -ItemType Directory -Force -Path $logs | Out-Null
$since = Get-Date
$stamp = (Get-Date).AddSeconds(1).ToString('yyyy-MM-dd HH:mm:ss,fff')
$appId = Get-AfruAppId
Set-Content -LiteralPath (Join-Path $logs 'Trace_1.log') -Value @("$stamp INFO other", "$stamp WARN Closing extension 'another' - 'HashMismatch'")
Check 'HashMismatch чужого приложения не считается' ($null -eq (Get-AfruIntegrityFailure -Since $since -LogRoot $logs))
Add-Content -LiteralPath (Join-Path $logs 'Trace_1.log') -Value "$stamp WARN Closing extension '$appId' - 'HashMismatch'"
Check 'HashMismatch AlecaFrame обнаруживается' ($null -ne (Get-AfruIntegrityFailure -Since $since -LogRoot $logs))
Check 'старая запись (раньше запуска) игнорируется' ($null -eq (Get-AfruIntegrityFailure -Since (Get-Date).AddMinutes(5) -LogRoot $logs))

# --- флаги в командной строке Overwolf
$disable = '--ow-disable-features=extension-validation,read-opk-from-memory'
$report = '--ow-enable-features=force-validation-report-only'
function Proc([string]$CommandLine) { [pscustomobject]@{ Id = 1; Path = 'C:\OW\0.310.1.1\Overwolf.exe'; CommandLine = $CommandLine } }
Check 'Overwolf не запущен -> none' ((Get-AfruFlagState -Processes @() -Flags $disable) -eq 'none')
Check 'командная строка скрыта (Overwolf от администратора) -> unknown' ((Get-AfruFlagState -Processes @((Proc $null)) -Flags $disable) -eq 'unknown')
Check 'Overwolf перезапустился без флага -> missing' ((Get-AfruFlagState -Processes @((Proc '"C:\OW\Overwolf.exe"')) -Flags $disable) -eq 'missing')
Check 'флаг на месте -> ok' ((Get-AfruFlagState -Processes @((Proc "`"C:\OW\Overwolf.exe`" $disable")) -Flags $disable) -eq 'ok')
Check 'нет флага report-only, когда он нужен -> missing' ((Get-AfruFlagState -Processes @((Proc "x $disable")) -Flags $disable, $report) -eq 'missing')
Check 'достаточно одного процесса со всеми флагами' ((Get-AfruFlagState -Processes @((Proc 'helper'), (Proc "x $disable $report")) -Flags $disable, $report) -eq 'ok')

# --- выдержка из журнала Overwolf для launcher.log
$trace = Join-Path $logs 'Trace_2.log'
Set-Content -LiteralPath $trace -Value (@('INFO window moved', 'INFO features: disabled extension-validation',
    "WARN Closing extension '$appId' - 'HashMismatch'") + (1..50 | ForEach-Object { "INFO content validation $_" }))
$excerpt = @(Get-AfruTraceExcerpt -Trace $trace -Max 60)
Check 'в выдержку попадают флаги и HashMismatch, посторонние строки нет' (
    ($excerpt -match 'disabled extension-validation').Count -eq 1 -and ($excerpt -match 'HashMismatch').Count -eq 1 -and
    ($excerpt -match 'window moved').Count -eq 0)
$tail = @(Get-AfruTraceExcerpt -Trace $trace -Max 10)
Check 'выдержка ограничена последними строками' ($tail.Count -eq 10 -and $tail[-1] -eq 'INFO content validation 50')

# --- все версии AlecaFrame: после обновления их бывает две
$all = @(Get-AfruVersionDirectories -ExtensionsRoot $ext)
Check 'список версий по убыванию, без папок без manifest.json' (($all | ForEach-Object Name) -join ',' -eq '2.6.11,2.6.10,2.6.9')
Check 'нет папки AlecaFrame -> пустой список' (@(Get-AfruVersionDirectories -ExtensionsRoot (Join-Path $tmp 'nope')).Count -eq 0)
$web1 = Join-Path $v.FullName 'web'
Write-Bytes (Join-Path $web1 'main.html') $shapes['main.html']
Remove-Item -LiteralPath (Join-Path $web3 'AFBuilds.html') -Force
$backups = Join-Path $state 'backup-all'
foreach ($dir in $v, $v2, $v3) {
    $null = Add-AfruLocalizer -VersionPath $dir.FullName -ExtensionsRoot $ext -LocalizerSource $src -BackupRoot (Join-Path $backups $dir.Name)
}
Check 'Test-AfruPatched видит подключённый перевод' (Test-AfruPatched -VersionPath $v.FullName)
$restoredCount = Restore-AfruAll -ExtensionsRoot $ext -BackupRoot $backups
Check 'Restore-AfruAll возвращает страницы во всех версиях' ($restoredCount -eq 5 -and
    -not (Test-AfruPatched -VersionPath $v.FullName) -and -not (Test-AfruPatched -VersionPath $v2.FullName) -and
    -not (Test-AfruPatched -VersionPath $v3.FullName))
$identical = $true
foreach ($name in $shapes.Keys) { if ((Sha (Join-Path $web $name)) -ne $before[$name]) { $identical = $false } }
Check 'после Restore-AfruAll файлы побайтово исходные' ($identical -and (Sha (Join-Path $web3 'main.html')) -eq $mainBefore)

# --- решения агента
function Decide([hashtable]$Arguments) { Get-AfruAgentDecision @Arguments }
function Is([object]$D, [string]$Expected) {
    $on = @('Restore', 'StartOverwolf', 'RestartOverwolf', 'Patch', 'LaunchApp' | Where-Object { $D.$_ })
    ($on -join ',') -eq $Expected
}
Check 'Overwolf с флагами, перевода нет -> подключить' (Is (Decide @{ FlagState = 'ok' }) 'Patch')
Check 'Overwolf с флагами, перевод на месте -> ничего' (Is (Decide @{ FlagState = 'ok'; Patched = $true }) '')
Check 'Overwolf закрыт -> вернуть файлы' (Is (Decide @{ FlagState = 'none'; Patched = $true }) 'Restore')
Check 'Overwolf закрыт, нажат ярлык -> запустить с флагами' (
    Is (Decide @{ FlagState = 'none'; LaunchRequested = $true }) 'StartOverwolf,Patch,LaunchApp')
Check 'Overwolf давно работает без флагов -> только вернуть файлы, не мешать игре' (
    Is (Decide @{ FlagState = 'missing'; Patched = $true; OverwolfAgeSeconds = 3600 }) 'Restore')
Check 'Overwolf только что запущен без флагов (автозапуск) -> перезапустить' (
    Is (Decide @{ FlagState = 'missing'; OverwolfAgeSeconds = 20 }) 'RestartOverwolf,Patch')
Check 'перезапусков уже два -> больше не перезапускать' (
    Is (Decide @{ FlagState = 'missing'; OverwolfAgeSeconds = 20; RestartAttempts = 2 }) '')
Check 'AlecaFrame открыт в Overwolf без флагов -> перезапустить' (
    Is (Decide @{ FlagState = 'missing'; OverwolfAgeSeconds = 3600; AppRunning = $true }) 'RestartOverwolf,Patch')
Check 'ярлык срабатывает и после лимита перезапусков' (
    Is (Decide @{ FlagState = 'missing'; LaunchRequested = $true; RestartAttempts = 9 }) 'RestartOverwolf,Patch,LaunchApp')
Check 'Overwolf от администратора -> только вернуть файлы' (
    Is (Decide @{ FlagState = 'unknown'; Patched = $true; LaunchRequested = $true }) 'Restore,LaunchApp')
Check 'перевод заблокирован -> файлы исходные, Overwolf не трогаем' (
    Is (Decide @{ FlagState = 'ok'; Patched = $true; Blocked = $true; LaunchRequested = $true }) 'Restore,LaunchApp')
Check 'неизвестное состояние флагов отклоняется' (Throws { Decide @{ FlagState = 'maybe' } })

$now = Get-Date
$procs = @([pscustomobject]@{ StartTime = $now.AddSeconds(-30) }, [pscustomobject]@{ StartTime = $now.AddSeconds(-500) })
Check 'возраст Overwolf считается по самому старому процессу' ([math]::Round((Get-AfruOverwolfAge -Processes $procs -Now $now)) -eq 500)
Check 'без времени запуска возраст неизвестен (-1)' ((Get-AfruOverwolfAge -Processes @((Proc 'x'))) -eq -1)
Check 'флаги: обычный режим и report-only' ((Get-AfruFlags $false).Count -eq 1 -and (Get-AfruFlags $true)[1] -eq $report)

# --- файл состояния агента
$statusFile = Join-Path $state 'status'
Write-AfruStatus -Path $statusFile -Code 'patched' -Message "Перевод подключён`tк 2.6.90"
$status = Read-AfruStatus -Path $statusFile
Check 'статус читается обратно (кириллица, табуляция в тексте)' ($status.Code -eq 'patched' -and
    $status.Message -eq "Перевод подключён`tк 2.6.90" -and ($now - $status.Time).TotalMinutes -lt 5)
Check 'нет файла статуса -> $null' ($null -eq (Read-AfruStatus -Path (Join-Path $state 'nope')))

# --- окно установки, в котором агент задаёт вопрос о report-only
$watch = Join-Path $state 'install.watch'
Check 'окна установки нет -> вопрос отдельным окном' (-not (Test-AfruWatcher -Path $watch))
Set-Content -LiteralPath $watch -Value $PID
Check 'окно установки открыто (PID живого PowerShell) -> вопрос в нём' (Test-AfruWatcher -Path $watch)
Set-Content -LiteralPath $watch -Value 2147483000
Check 'окно установки закрыто (процесса нет) -> отдельным окном' (-not (Test-AfruWatcher -Path $watch))
Set-Content -LiteralPath $watch -Value 'мусор'
Check 'испорченный файл окна установки не считается' (-not (Test-AfruWatcher -Path $watch))

# --- пути и запуск агента без окна
$p = Get-AfruPaths -LocalAppData $tmp
Check 'пути считаются от LOCALAPPDATA' ($p.Extensions -eq (Join-Path $tmp "Overwolf\Extensions\$appId") -and
    $p.Localizer.StartsWith($p.App) -and $p.Agent.EndsWith('Agent.ps1') -and
    $p.Watcher.StartsWith($p.State) -and $p.ReportOnlyNo.StartsWith($p.State) -and $p.ReportOnly -ne $p.ReportOnlyNo)
$conhost = Join-Path $tmp 'conhost.exe'; Set-Content -LiteralPath $conhost -Value ''
$cmd = Get-AfruAgentCommand -AgentPath 'C:\A\Agent.ps1' -Launch -PowerShell 'C:\PS\powershell.exe' -Conhost $conhost -Build 22631
Check 'Windows 10 1809+ -> conhost --headless, без окна терминала' ($cmd.Target -eq $conhost -and
    $cmd.Arguments.StartsWith('--headless "C:\PS\powershell.exe" ') -and $cmd.Arguments.EndsWith('"C:\A\Agent.ps1" -Launch'))
$old = Get-AfruAgentCommand -AgentPath 'C:\A\Agent.ps1' -PowerShell 'C:\PS\powershell.exe' -Conhost $conhost -Build 17134
Check 'старая Windows -> PowerShell напрямую, без -Launch' ($old.Target -eq 'C:\PS\powershell.exe' -and -not $old.Arguments.Contains('Launch'))

# --- копия программы в LOCALAPPDATA
$source = Join-Path $tmp 'download'
foreach ($rel in 'dist\alecaframe-ru.js', 'windows\Agent.ps1', 'windows\AlecaFrameRU.psm1', 'windows\Uninstall.ps1', 'Uninstall.cmd') {
    $file = Join-Path $source $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
    Set-Content -LiteralPath $file -Value "v1 $rel"
}
$app = Join-Path (Join-Path $tmp 'installed') 'app'
Check 'копирование в папку программы' ((Install-AfruAppFiles -SourceRoot $source -AppRoot $app) -and
    (Get-Content -LiteralPath (Join-Path $app 'dist\alecaframe-ru.js')) -eq 'v1 dist\alecaframe-ru.js' -and
    (Test-Path -LiteralPath (Join-Path $app 'Uninstall.cmd')))
Set-Content -LiteralPath (Join-Path $app 'alecaframe.ico') -Value 'icon'
Set-Content -LiteralPath (Join-Path $app 'stale.txt') -Value 'old'
Set-Content -LiteralPath (Join-Path $source 'dist\alecaframe-ru.js') -Value 'v2'
$null = Install-AfruAppFiles -SourceRoot $source -AppRoot $app
Check 'обновление подменяет файлы целиком, иконка сохраняется' ((Get-Content -LiteralPath (Join-Path $app 'dist\alecaframe-ru.js')) -eq 'v2' -and
    -not (Test-Path -LiteralPath (Join-Path $app 'stale.txt')) -and (Test-Path -LiteralPath (Join-Path $app 'alecaframe.ico')) -and
    -not (Test-Path -LiteralPath "$app.new") -and -not (Test-Path -LiteralPath "$app.old"))
Check 'установка из самой папки программы ничего не делает' (-not (Install-AfruAppFiles -SourceRoot $app -AppRoot $app))
Remove-Item -LiteralPath (Join-Path $source 'windows\Agent.ps1') -Force
Check 'нет нужного файла -> ошибка, установленная копия цела' ((Throws { Install-AfruAppFiles -SourceRoot $source -AppRoot $app } 'Agent') -and
    (Get-Content -LiteralPath (Join-Path $app 'dist\alecaframe-ru.js')) -eq 'v2')



Remove-Item -LiteralPath $tmp -Recurse -Force
if ($failures) { Write-Host "`n$failures проверок не прошли"; exit 1 }
Write-Host "`nвсе проверки прошли"
