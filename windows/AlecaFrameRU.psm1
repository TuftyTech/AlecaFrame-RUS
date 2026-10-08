Set-StrictMode -Version 2.0

# Подход к запуску через Overwolf (папки, флаги, процессы) описан по открытому проекту
# AlecaFrame-ZH (MIT), автор «想吃西瓜»: https://github.com/191086215333/AlecaFrame-ZH-

$script:AppId  = 'afmcagbpgggkpdkokjhjkllpegnadmkignlonpjm'
$script:Pages  = @(
    'main.html', 'AFBuilds.html', 'InGameNotification.html', 'relicOverlay.html',
    'relicRecommendation.html', 'rivenOverlay.html', 'SquadMakingMain.html',
    'SquadMakingSquad.html', 'tradeFinishedNotification.html'
)
$script:JsName = 'alecaframe-ru.js'
# Единственное, что мы вставляем в страницы. Вставка и удаление побайтово обратимы.
$script:Tag    = '<script src="assets/js/alecaframe-ru.js" data-afru></script>'
# Latin-1 отображает байты 1:1, поэтому файл с любой кодировкой читается и пишется без потерь.
$script:Latin1 = [Text.Encoding]::GetEncoding(28591)

function Get-AfruAppId { $script:AppId }

function Assert-AfruInside {
    param([string]$Root, [string]$Path)
    $sep = [string][IO.Path]::DirectorySeparatorChar
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + $sep
    $pathFull = [IO.Path]::GetFullPath($Path)
    if (-not $pathFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Отказ: путь вне папки AlecaFrame ($Path)."
    }
}

function Read-AfruFile  { param([string]$Path) $script:Latin1.GetString([IO.File]::ReadAllBytes($Path)) }
function Write-AfruFile { param([string]$Path, [string]$Text) [IO.File]::WriteAllBytes($Path, $script:Latin1.GetBytes($Text)) }

function Get-AfruVersionDirectory {
    param([Parameter(Mandatory)][string]$ExtensionsRoot)
    if (-not (Test-Path -LiteralPath $ExtensionsRoot)) {
        throw 'AlecaFrame не найден. Установите его через Overwolf и один раз запустите.'
    }
    $found = Get-ChildItem -LiteralPath $ExtensionsRoot -Directory |
        Where-Object {
            $v = $null
            [version]::TryParse($_.Name, [ref]$v) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json'))
        } |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1
    if (-not $found) { throw 'В папке AlecaFrame нет установленной версии. Запустите AlecaFrame один раз без перевода.' }
    $found
}

# Подключает перевод: копирует alecaframe-ru.js и вставляет тег сразу после <head>.
# Сначала проверяет все страницы, потом пишет — при ошибке ничего не остаётся наполовину.
function Add-AfruLocalizer {
    param(
        [Parameter(Mandatory)][string]$VersionPath,
        [Parameter(Mandatory)][string]$ExtensionsRoot,
        [Parameter(Mandatory)][string]$LocalizerSource,
        [Parameter(Mandatory)][string]$BackupRoot
    )
    Assert-AfruInside $ExtensionsRoot $VersionPath
    $web = Join-Path $VersionPath 'web'
    if (-not (Test-Path -LiteralPath (Join-Path $web 'main.html'))) {
        throw 'Не найден web\main.html: структура этой версии AlecaFrame отличается от ожидаемой.'
    }
    if (-not (Test-Path -LiteralPath $LocalizerSource)) { throw "Нет файла перевода: $LocalizerSource" }

    $plan = @()
    foreach ($page in $script:Pages) {
        $file = Join-Path $web $page
        if (-not (Test-Path -LiteralPath $file)) { continue }
        $text = Read-AfruFile $file
        if ($text.Contains($script:Tag)) { continue }
        $m = [regex]::Match($text, '<head(\s[^>]*)?>', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $m.Success) { throw "В $page нет тега <head>: эта версия AlecaFrame устроена иначе, перевод не подключён." }
        $plan += [pscustomobject]@{ Page = $page; File = $file; Text = $text.Insert($m.Index + $m.Length, $script:Tag) }
    }

    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
    foreach ($item in $plan) {
        $backup = Join-Path $BackupRoot $item.Page
        if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $item.File -Destination $backup }
        Write-AfruFile $item.File $item.Text
    }
    $jsDir = Join-Path (Join-Path $web 'assets') 'js'
    Copy-Item -LiteralPath $LocalizerSource -Destination (Join-Path $jsDir $script:JsName) -Force
    @($plan | ForEach-Object { $_.Page })
}

# Возвращает файлы в исходное состояние: убирает наш тег, затем сверяет с резервной копией.
function Remove-AfruLocalizer {
    param(
        [Parameter(Mandatory)][string]$VersionPath,
        [Parameter(Mandatory)][string]$ExtensionsRoot,
        [Parameter(Mandatory)][string]$BackupRoot
    )
    Assert-AfruInside $ExtensionsRoot $VersionPath
    $web = Join-Path $VersionPath 'web'
    $restored = @()
    foreach ($page in $script:Pages) {
        $file = Join-Path $web $page
        if (-not (Test-Path -LiteralPath $file)) { continue }
        $text = Read-AfruFile $file
        if ($text.Contains($script:Tag)) {
            Write-AfruFile $file $text.Replace($script:Tag, '')
            $restored += $page
        }
        $backup = Join-Path $BackupRoot $page
        if ((Test-Path -LiteralPath $backup) -and
            (Get-FileHash -LiteralPath $file).Hash -ne (Get-FileHash -LiteralPath $backup).Hash) {
            Copy-Item -LiteralPath $backup -Destination $file -Force
            if ($restored -notcontains $page) { $restored += $page }
        }
    }
    $js = Join-Path (Join-Path (Join-Path $web 'assets') 'js') $script:JsName
    if (Test-Path -LiteralPath $js) { Remove-Item -LiteralPath $js -Force }
    $restored
}

# Overwolf закрывает приложение, если файл не совпал с подписанным списком, и пишет это в Trace_*.log.
function Get-AfruIntegrityFailure {
    param([datetime]$Since, [Parameter(Mandatory)][string]$LogRoot)
    $pattern = "Closing extension '" + [regex]::Escape($script:AppId) + "' - 'HashMismatch'"
    $traces = Get-ChildItem -LiteralPath $LogRoot -Filter 'Trace_*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $Since } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 3
    foreach ($trace in $traces) {
        foreach ($line in (Get-Content -LiteralPath $trace.FullName -Tail 500 -ErrorAction SilentlyContinue)) {
            if ($line -notmatch $pattern -or $line.Length -lt 23) { continue }
            $when = [datetime]::MinValue
            if ([datetime]::TryParseExact($line.Substring(0, 23), 'yyyy-MM-dd HH:mm:ss,fff',
                    [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$when) -and
                $when -ge $Since) {
                return [pscustomobject]@{ Time = $when; Trace = $trace.FullName; Line = $line }
            }
        }
    }
    $null
}

# ---- Overwolf (проверяется только на Windows с установленным Overwolf) -------------------------

function Find-AfruOverwolf {
    $dirs = New-Object System.Collections.Generic.List[string]
    $running = Get-Process -Name 'Overwolf' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
    if ($running) { $dirs.Add((Split-Path -Parent $running.Path)) }
    foreach ($root in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
                      'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall') {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
            Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'Overwolf' -and $_.InstallLocation } |
            ForEach-Object { $dirs.Add($_.InstallLocation.TrimEnd('\')) }
    }
    $dirs.Add((Join-Path $env:LOCALAPPDATA 'Overwolf'))
    if (${env:ProgramFiles(x86)}) { $dirs.Add((Join-Path ${env:ProgramFiles(x86)} 'Overwolf')) }
    if ($env:ProgramFiles) { $dirs.Add((Join-Path $env:ProgramFiles 'Overwolf')) }
    foreach ($dir in $dirs | Select-Object -Unique) {
        $exe = Join-Path $dir 'Overwolf.exe'
        $launcher = Join-Path $dir 'OverwolfLauncher.exe'
        if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $launcher)) {
            return [pscustomobject]@{ Overwolf = $exe; Launcher = $launcher }
        }
    }
    throw 'Не найден Overwolf. Установите его с overwolf.com и запустите AlecaFrame один раз.'
}

function Stop-AfruOverwolf {
    Get-Process -Name 'Overwolf' -ErrorAction SilentlyContinue | Stop-Process -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20 -and (Get-Process -Name 'Overwolf' -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 2
}

function Get-AfruRenderer {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'OverwolfBrowser.exe' -and $_.CommandLine -match 'AlecaFrame' } |
        Select-Object -First 1
}

function Start-AfruApp {
    param([Parameter(Mandatory)][string]$Launcher, [int]$TimeoutSeconds = 90, [datetime]$Since = (Get-Date))
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $next = Get-Date
    do {
        if ((Get-Date) -ge $next) {
            Start-Process -FilePath $Launcher -ArgumentList '-launchapp', $script:AppId, '-from-desktop'
            $next = (Get-Date).AddSeconds(3)
        }
        Start-Sleep -Milliseconds 500
        $found = Get-AfruRenderer
        if ($found) { return $found }
    } while ((Get-Date) -lt $deadline)
    throw 'AlecaFrame не запустился за отведённое время.'
}

function Stop-AfruRenderer {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'OverwolfBrowser.exe' -and $_.CommandLine -match 'AlecaFrame' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}

Export-ModuleMember -Function Get-AfruAppId, Get-AfruVersionDirectory, Add-AfruLocalizer, Remove-AfruLocalizer,
    Get-AfruIntegrityFailure, Find-AfruOverwolf, Stop-AfruOverwolf, Get-AfruRenderer, Start-AfruApp, Stop-AfruRenderer
