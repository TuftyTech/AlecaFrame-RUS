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

Remove-Item -LiteralPath $tmp -Recurse -Force
if ($failures) { Write-Host "`n$failures проверок не прошли"; exit 1 }
Write-Host "`nвсе проверки прошли"
