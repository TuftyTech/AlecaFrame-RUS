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
# Подгружаются страницами сами (описания предметов нужны только главному окну), в страницы не вставляются.
$script:ExtraJs = @('alecaframe-ru-texts.js')
# Единственное, что мы вставляем в страницы. Вставка и удаление побайтово обратимы.
$script:Tag    = '<script src="assets/js/alecaframe-ru.js" data-afru></script>'
# Latin-1 отображает байты 1:1, поэтому файл с любой кодировкой читается и пишется без потерь.
$script:Latin1 = [Text.Encoding]::GetEncoding(28591)
$script:DisableFlag    = '--ow-disable-features=extension-validation,read-opk-from-memory'
# Новые сборки Overwolf (0.310.1.1 у DDA-007/AlecaFrame-ZH) закрывают изменённое приложение и с первым флагом.
# Этот флаг оставляет проверку, но переводит её в режим «только записать в журнал».
$script:ReportOnlyFlag = '--ow-enable-features=force-validation-report-only'
# Файлы, без которых установленная копия не работает.
$script:AppFiles = @(
    'dist\alecaframe-ru.js', 'windows\Agent.ps1', 'windows\AlecaFrameRU.psm1', 'windows\Uninstall.ps1'
)
$script:OptionalAppFiles = @('dist\alecaframe-ru-texts.js', 'Uninstall.cmd', 'LICENSE', 'README.md')

function Get-AfruAppId { $script:AppId }

function Get-AfruFlags {
    param([bool]$ReportOnly)
    if ($ReportOnly) { @($script:DisableFlag, $script:ReportOnlyFlag) } else { @($script:DisableFlag) }
}

function Join-AfruPath {
    param([string]$Root, [string]$Child)
    if (-not $Root) { return $null }
    Join-Path $Root $Child
}

# Все пути AlecaFrame-RU в одном месте. Папки Windows подставляются, только если они есть.
function Get-AfruPaths {
    param([string]$LocalAppData = $env:LOCALAPPDATA)
    $state = Join-Path $LocalAppData 'AlecaFrame-RU'
    $app = Join-Path $state 'app'
    $windows = Join-Path $app 'windows'
    $shortcutName = 'AlecaFrame (русский).lnk'
    [pscustomobject]@{
        State         = $state
        App           = $app
        Localizer     = Join-Path (Join-Path $app 'dist') $script:JsName
        Agent         = Join-Path $windows 'Agent.ps1'
        Uninstaller   = Join-Path $windows 'Uninstall.ps1'
        Icon          = Join-Path $app 'alecaframe.ico'
        Backup        = Join-Path $state 'backup'
        Log           = Join-Path $state 'launcher.log'
        Status        = Join-Path $state 'status'
        Consent       = Join-Path $state 'consent-v2'
        ReportOnly    = Join-Path $state 'report-only-v1'
        ReportOnlyNo  = Join-Path $state 'report-only.declined'
        Watcher       = Join-Path $state 'install.watch'
        Blocked       = Join-Path $state 'blocked-v1'
        LaunchRequest = Join-Path $state 'launch.request'
        Extensions    = Join-Path $LocalAppData "Overwolf\Extensions\$script:AppId"
        OverwolfLog   = Join-Path $LocalAppData 'Overwolf\Log'
        AppLog        = Join-Path $LocalAppData 'Overwolf\Log\Apps\AlecaFrame'
        StartupLink   = Join-AfruPath ([Environment]::GetFolderPath('Startup')) 'AlecaFrame-RU.lnk'
        StartMenuLink = Join-AfruPath ([Environment]::GetFolderPath('Programs')) $shortcutName
        DesktopLink   = Join-AfruPath ([Environment]::GetFolderPath('Desktop')) $shortcutName
        UninstallKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AlecaFrame-RU'
    }
}

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

function Get-AfruVersionDirectories {
    param([Parameter(Mandatory)][string]$ExtensionsRoot)
    if (-not (Test-Path -LiteralPath $ExtensionsRoot)) { return @() }
    @(Get-ChildItem -LiteralPath $ExtensionsRoot -Directory |
        Where-Object {
            $v = $null
            [version]::TryParse($_.Name, [ref]$v) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json'))
        } |
        Sort-Object { [version]$_.Name } -Descending)
}

function Get-AfruVersionDirectory {
    param([Parameter(Mandatory)][string]$ExtensionsRoot)
    if (-not (Test-Path -LiteralPath $ExtensionsRoot)) {
        throw 'AlecaFrame не найден. Установите его через Overwolf и один раз запустите.'
    }
    $found = @(Get-AfruVersionDirectories -ExtensionsRoot $ExtensionsRoot) | Select-Object -First 1
    if (-not $found) { throw 'В папке AlecaFrame нет установленной версии. Запустите AlecaFrame один раз без перевода.' }
    $found
}

# Подключает перевод: копирует alecaframe-ru.js (и соседние файлы из ExtraJs) и вставляет тег сразу после <head>.
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

    # Скрипты кладутся раньше тегов: страница не должна ссылаться на файл, которого ещё н��т.
    $jsDir = Join-Path (Join-Path $web 'assets') 'js'
    $sourceDir = Split-Path -Parent $LocalizerSource
    Copy-AfruIfChanged $LocalizerSource (Join-Path $jsDir $script:JsName)
    foreach ($extra in $script:ExtraJs) {
        $extraSource = Join-Path $sourceDir $extra
        if (Test-Path -LiteralPath $extraSource) { Copy-AfruIfChanged $extraSource (Join-Path $jsDir $extra) }
    }

    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
    foreach ($item in $plan) {
        $backup = Join-Path $BackupRoot $item.Page
        if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $item.File -Destination $backup }
        Write-AfruFile $item.File $item.Text
    }
    @($plan | ForEach-Object { $_.Page })
}

function Copy-AfruIfChanged {
    param([string]$Source, [string]$Destination)
    if ((Test-Path -LiteralPath $Destination) -and
        (Get-FileHash -LiteralPath $Destination).Hash -eq (Get-FileHash -LiteralPath $Source).Hash) { return }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
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
    $jsDir = Join-Path (Join-Path $web 'assets') 'js'
    foreach ($name in @($script:JsName) + $script:ExtraJs) {
        $js = Join-Path $jsDir $name
        if (Test-Path -LiteralPath $js) { Remove-Item -LiteralPath $js -Force }
    }
    $restored
}

function Test-AfruPatched {
    param([Parameter(Mandatory)][string]$VersionPath)
    $web = Join-Path $VersionPath 'web'
    foreach ($page in $script:Pages) {
        $file = Join-Path $web $page
        if ((Test-Path -LiteralPath $file) -and (Read-AfruFile $file).Contains($script:Tag)) { return $true }
    }
    $false
}

# Возвращает исходные файлы во всех установленных версиях AlecaFrame (после обновления их бывает две).
function Restore-AfruAll {
    param([Parameter(Mandatory)][string]$ExtensionsRoot, [Parameter(Mandatory)][string]$BackupRoot)
    $count = 0
    foreach ($dir in @(Get-AfruVersionDirectories -ExtensionsRoot $ExtensionsRoot)) {
        $count += @(Remove-AfruLocalizer -VersionPath $dir.FullName -ExtensionsRoot $ExtensionsRoot `
            -BackupRoot (Join-Path $BackupRoot $dir.Name)).Count
    }
    $count
}

# ---- Установленная копия ------------------------------------------------------------------------

# Копирует нужные файлы в постоянную папку. Сначала во временную, затем подменяет целиком:
# агент не увидит половину старой и половину новой версии.
function Install-AfruAppFiles {
    param([Parameter(Mandatory)][string]$SourceRoot, [Parameter(Mandatory)][string]$AppRoot)
    foreach ($rel in $script:AppFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $rel))) { throw "В папке AlecaFrame-RU нет файла $rel. Скачайте архив заново." }
    }
    $sourceFull = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/')
    $appFull = [IO.Path]::GetFullPath($AppRoot).TrimEnd('\', '/')
    if ($sourceFull -eq $appFull) { return $false }

    $staging = "$appFull.new"
    $old = "$appFull.old"
    foreach ($dir in $staging, $old) { if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force } }
    foreach ($rel in $script:AppFiles + $script:OptionalAppFiles) {
        $from = Join-Path $SourceRoot $rel
        if (-not (Test-Path -LiteralPath $from)) { continue }
        $to = Join-Path $staging $rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
        Copy-Item -LiteralPath $from -Destination $to -Force
    }
    # Иконка AlecaFrame для ярлыков сохраняется между обновлениями.
    $icon = Join-Path $appFull 'alecaframe.ico'
    if (Test-Path -LiteralPath $icon) { Copy-Item -LiteralPath $icon -Destination (Join-Path $staging 'alecaframe.ico') -Force }
    if (Test-Path -LiteralPath $appFull) { Move-Item -LiteralPath $appFull -Destination $old }
    Move-Item -LiteralPath $staging -Destination $appFull
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
    $true
}

function Write-AfruStatus {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Code, [string]$Message = '')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    Set-Content -LiteralPath $Path -Value ("{0}`t{1}`t{2}" -f (Get-Date -Format o), $Code, $Message) -Encoding UTF8
}

function Read-AfruStatus {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $line = @(Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue) | Select-Object -First 1
    if (-not $line) { return $null }
    $parts = $line.Split("`t", 3)
    if ($parts.Count -lt 2) { return $null }
    $time = [datetime]::MinValue
    $null = [datetime]::TryParse($parts[0], [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind, [ref]$time)
    [pscustomobject]@{ Time = $time; Code = $parts[1]; Message = $(if ($parts.Count -gt 2) { $parts[2] } else { '' }) }
}

# Install.cmd записывает свой PID, пока показывает ход установки: агент задаёт вопросы в его окне.
function Test-AfruWatcher {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $id = 0
    $text = "$(Get-Content -LiteralPath $Path -TotalCount 1 -ErrorAction SilentlyContinue)".Trim()
    if (-not [int]::TryParse($text, [ref]$id) -or $id -le 0) { return $false }
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    [bool]($process -and $process.ProcessName -match '^(powershell|pwsh)$')
}

<#
  Что агент делает на очередном шаге. Главное правило: страницы AlecaFrame изменены, только пока
  Overwolf работает с нашими флагами. Во всех остальных случаях файлы возвращаются в исходный вид,
  поэтому обычный запуск Overwolf видит нетронутый AlecaFrame.
  FlagState: none | unknown | missing | ok (см. Get-AfruFlagState).
  OverwolfAgeSeconds: сколько работает Overwolf; сам по себе перезапускается только что запущенный, а не посреди игры.
  AppRunning: AlecaFrame открыт в Overwolf без флагов (из док-панели или при запуске игры) — его перезапускаем на русском.
#>
function Get-AfruAgentDecision {
    param(
        [Parameter(Mandatory)][ValidateSet('none', 'unknown', 'missing', 'ok')][string]$FlagState,
        [bool]$Patched,
        [bool]$LaunchRequested,
        [bool]$Blocked,
        [bool]$AppRunning,
        [double]$OverwolfAgeSeconds = -1,
        [int]$RestartAttempts = 0,
        [int]$FreshStartSeconds = 180,
        [int]$MaxRestarts = 2
    )
    $d = [ordered]@{ Restore = $false; StartOverwolf = $false; RestartOverwolf = $false; Patch = $false; LaunchApp = $LaunchRequested }
    if ($Blocked) {
        # Перевод отключён до повторной установки: AlecaFrame работает как обычно, на английском.
        $d.Restore = $Patched
        return [pscustomobject]$d
    }
    switch ($FlagState) {
        'ok' { $d.Patch = -not $Patched }
        'none' {
            $d.Restore = $Patched
            if ($LaunchRequested) { $d.StartOverwolf = $true; $d.Patch = $true }
        }
        'missing' {
            $d.Restore = $Patched
            $fresh = $OverwolfAgeSeconds -ge 0 -and $OverwolfAgeSeconds -lt $FreshStartSeconds
            if ($LaunchRequested -or (($fresh -or $AppRunning) -and $RestartAttempts -lt $MaxRestarts)) {
                $d.RestartOverwolf = $true
                $d.Patch = $true
            }
        }
        'unknown' { $d.Restore = $Patched }
    }
    [pscustomobject]$d
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

# Есть ли в журнале окна строка после указанного момента (например, «[AlecaFrame-RU] loaded»).
function Test-AfruLogLine {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Pattern, [datetime]$Since)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path
    if ($item.LastWriteTime -lt $Since.AddSeconds(-2)) { return $false }
    [bool](@(Get-Content -LiteralPath $Path -Tail 80 -ErrorAction SilentlyContinue) -match $Pattern)
}

# 'none' — Overwolf не запущен; 'unknown' — командная строка скрыта (Overwolf запущен от администратора);
# 'missing' — ни у одного процесса нет всех флагов (например, Overwolf обновился и перезапустился сам); 'ok'.
function Get-AfruFlagState {
    param([object[]]$Processes, [Parameter(Mandatory)][string[]]$Flags)
    $all = @($Processes | Where-Object { $_ })
    if ($all.Count -eq 0) { return 'none' }
    $readable = @($all | Where-Object { $_.CommandLine })
    if ($readable.Count -eq 0) { return 'unknown' }
    foreach ($process in $readable) {
        $missing = @($Flags | Where-Object { -not $process.CommandLine.Contains($_) })
        if ($missing.Count -eq 0) { return 'ok' }
    }
    'missing'
}

# Сколько секунд работает Overwolf: по самому старому процессу, чтобы не принять долгую сессию за новый запуск.
function Get-AfruOverwolfAge {
    param([object[]]$Processes, [datetime]$Now = (Get-Date))
    $times = @($Processes | Where-Object { $_ -and $_.PSObject.Properties['StartTime'] -and $_.StartTime } | ForEach-Object { $_.StartTime })
    if ($times.Count -eq 0) { return -1 }
    ($Now - ($times | Sort-Object | Select-Object -First 1)).TotalSeconds
}

# Строки Trace-журнала о проверке файлов и флагах: их достаточно, чтобы понять, что сделал Overwolf.
function Get-AfruTraceExcerpt {
    param([Parameter(Mandatory)][string]$Trace, [int]$Max = 40)
    $pattern = '(?i)validation|feature|report.?only|HashMismatch|read-opk'
    @(Get-Content -LiteralPath $Trace -ErrorAction SilentlyContinue | Where-Object { $_ -match $pattern } | Select-Object -Last $Max)
}

# ---- Overwolf и Windows (проверяется только на Windows с установленным Overwolf) ---------------

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

# Если старый Overwolf не закрылся, новый запуск лишь передаст ему управление, и флаги не применятся.
function Stop-AfruOverwolf {
    param([int]$TimeoutSeconds = 20)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (Get-Process -Name 'Overwolf' -ErrorAction SilentlyContinue) {
        if ((Get-Date) -ge $deadline) {
            throw ('Не удалось закрыть Overwolf: скорее всего, он запущен от имени администратора. ' +
                   'Выйдите из Overwolf (значок в трее -> Exit) и попробуйте ещё раз.')
        }
        Get-Process -Name 'Overwolf' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    Start-Sleep -Seconds 2
}

function Get-AfruProcessInfo {
    param([Parameter(Mandatory)][string]$Name)
    @(Get-CimInstance Win32_Process -Filter "Name = '$Name'" -ErrorAction SilentlyContinue |
        ForEach-Object {
            [pscustomobject]@{ Id = $_.ProcessId; Path = $_.ExecutablePath; CommandLine = $_.CommandLine; StartTime = $_.CreationDate }
        })
}

function Get-AfruOverwolfProcess { Get-AfruProcessInfo 'Overwolf.exe' }

function Wait-AfruOverwolf {
    param([int]$TimeoutSeconds = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Seconds 1
        if (@(Get-AfruOverwolfProcess).Count) {
            # Даём Overwolf.exe из корня папки передать запуск версии из подпапки.
            Start-Sleep -Seconds 4
            return @(Get-AfruOverwolfProcess)
        }
    } while ((Get-Date) -lt $deadline)
    throw 'Overwolf не запустился за отведённое время.'
}

function Get-AfruRenderer {
    Get-AfruProcessInfo 'OverwolfBrowser.exe' | Where-Object { $_.CommandLine -match 'AlecaFrame' } | Select-Object -First 1
}

# Пользователь открывал AlecaFrame: окно уже работает или запуск через ярлык ещё в пути.
function Test-AfruAppWanted {
    if (Get-AfruRenderer) { return $true }
    foreach ($process in @(Get-AfruOverwolfProcess) + @(Get-AfruProcessInfo 'OverwolfLauncher.exe')) {
        if ($process.CommandLine -and $process.CommandLine.Contains($script:AppId)) { return $true }
    }
    $false
}

function Start-AfruApp {
    param([Parameter(Mandatory)][string]$Launcher, [int]$TimeoutSeconds = 90)
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
    Get-AfruProcessInfo 'OverwolfBrowser.exe' | Where-Object { $_.CommandLine -match 'AlecaFrame' } |
        ForEach-Object { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue }
}

function Get-AfruPowerShell { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }

function Get-AfruAgentArguments {
    param([Parameter(Mandatory)][string]$AgentPath, [switch]$Launch)
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentPath`""
    if ($Launch) { $arguments += ' -Launch' }
    $arguments
}

<#
  Чем запускать агента без окна. Если консолью по умолчанию выбран Windows Terminal, -WindowStyle Hidden
  оставляет на экране пустое окно терминала; conhost --headless (Windows 10 1809+) окна не создаёт вовсе.
#>
function Get-AfruAgentCommand {
    param(
        [Parameter(Mandatory)][string]$AgentPath, [switch]$Launch,
        [string]$PowerShell = (Get-AfruPowerShell),
        [string]$Conhost = $(if ($env:SystemRoot) { Join-Path $env:SystemRoot 'System32\conhost.exe' } else { '' }),
        [int]$Build = [Environment]::OSVersion.Version.Build
    )
    $arguments = Get-AfruAgentArguments -AgentPath $AgentPath -Launch:$Launch
    if ($Conhost -and $Build -ge 17763 -and (Test-Path -LiteralPath $Conhost)) {
        return [pscustomobject]@{ Target = $Conhost; Arguments = "--headless `"$PowerShell`" $arguments" }
    }
    [pscustomobject]@{ Target = $PowerShell; Arguments = $arguments }
}

function Get-AfruAgentProcess {
    param([Parameter(Mandatory)][string]$AgentPath)
    @(@(Get-AfruProcessInfo 'powershell.exe') + @(Get-AfruProcessInfo 'pwsh.exe') | Where-Object {
        $_.Id -ne $PID -and $_.CommandLine -and
        $_.CommandLine.IndexOf($AgentPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
}

function Stop-AfruAgent {
    param([Parameter(Mandatory)][string]$AgentPath)
    $agents = @(Get-AfruAgentProcess -AgentPath $AgentPath)
    foreach ($agent in $agents) { Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue }
    if ($agents.Count) { Start-Sleep -Seconds 1 }
    $agents.Count
}

function Start-AfruAgent {
    param([Parameter(Mandatory)][string]$AgentPath, [switch]$Launch)
    $command = Get-AfruAgentCommand -AgentPath $AgentPath -Launch:$Launch
    Start-Process -FilePath $command.Target -ArgumentList $command.Arguments -WindowStyle Hidden
}

# Старая версия (Start.cmd) держала открытое окно и при выходе из Overwolf возвращала файлы:
# параллельно с агентом она бы откатывала его изменения.
function Stop-AfruLegacySession {
    $count = 0
    foreach ($process in @(Get-AfruProcessInfo 'powershell.exe') + @(Get-AfruProcessInfo 'pwsh.exe')) {
        if ($process.Id -eq $PID -or -not $process.CommandLine) { continue }
        $m = [regex]::Match($process.CommandLine, '"?([^"]*\\windows\\Start\.ps1)"?', 'IgnoreCase')
        if (-not $m.Success) { continue }
        $module = Join-Path (Split-Path -Parent $m.Groups[1].Value) 'AlecaFrameRU.psm1'
        if (-not (Test-Path -LiteralPath $module)) { continue }
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $count++
    }
    $count
}

function New-AfruShortcut {
    param(
        [Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Target, [string]$Arguments = '',
        [string]$Icon, [string]$Description = '', [string]$WorkingDirectory
    )
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Path)
    $link.TargetPath = $Target
    $link.Arguments = $Arguments
    $link.Description = $Description
    # Свёрнутое окно: PowerShell с -WindowStyle Hidden не мелькает на экране.
    $link.WindowStyle = 7
    if ($WorkingDirectory) { $link.WorkingDirectory = $WorkingDirectory }
    if ($Icon -and (Test-Path -LiteralPath $Icon)) { $link.IconLocation = "$Icon,0" }
    $link.Save()
}

# Автозапуск агента, ярлыки «AlecaFrame (русский)» и запись в «Приложения и возможности».
function Register-AfruIntegration {
    param([Parameter(Mandatory)][object]$Paths, [string]$Version = '', [switch]$NoDesktop)
    $ps = Get-AfruPowerShell
    $agent = Get-AfruAgentCommand -AgentPath $Paths.Agent
    $launch = Get-AfruAgentCommand -AgentPath $Paths.Agent -Launch
    if ($Paths.StartupLink) {
        New-AfruShortcut -Path $Paths.StartupLink -Target $agent.Target -Arguments $agent.Arguments -Icon $Paths.Icon `
            -Description 'AlecaFrame-RU: русский интерфейс AlecaFrame при каждом запуске Overwolf' -WorkingDirectory $Paths.App
    }
    $links = @($Paths.StartMenuLink)
    if (-not $NoDesktop) { $links += $Paths.DesktopLink }
    foreach ($link in $links) {
        if (-not $link) { continue }
        New-AfruShortcut -Path $link -Target $launch.Target -Arguments $launch.Arguments -Icon $Paths.Icon `
            -Description 'Открыть AlecaFrame на русском' -WorkingDirectory $Paths.App
    }
    $key = $Paths.UninstallKey
    New-Item -Path $key -Force | Out-Null
    $values = [ordered]@{
        DisplayName = 'AlecaFrame-RU (русский интерфейс AlecaFrame)'; DisplayVersion = $Version; Publisher = 'AlecaFrame-RU'
        InstallLocation = $Paths.App; DisplayIcon = $Paths.Icon; URLInfoAbout = 'https://github.com/TuftyTech/AlecaFrame-RUS'
        UninstallString = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$($Paths.Uninstaller)`" -Pause"
    }
    foreach ($name in $values.Keys) { Set-ItemProperty -Path $key -Name $name -Value $values[$name] }
    foreach ($name in 'NoModify', 'NoRepair') { Set-ItemProperty -Path $key -Name $name -Value 1 -Type DWord }
}

function Unregister-AfruIntegration {
    param([Parameter(Mandatory)][object]$Paths)
    foreach ($link in $Paths.StartupLink, $Paths.StartMenuLink, $Paths.DesktopLink) {
        if ($link -and (Test-Path -LiteralPath $link)) { Remove-Item -LiteralPath $link -Force }
    }
    if (Test-Path -LiteralPath $Paths.UninstallKey) { Remove-Item -LiteralPath $Paths.UninstallKey -Recurse -Force }
}

Export-ModuleMember -Function Get-AfruAppId, Get-AfruFlags, Get-AfruPaths, Get-AfruVersionDirectories, Get-AfruVersionDirectory,
    Add-AfruLocalizer, Remove-AfruLocalizer, Test-AfruPatched, Restore-AfruAll, Install-AfruAppFiles,
    Write-AfruStatus, Read-AfruStatus, Test-AfruWatcher, Get-AfruAgentDecision, Get-AfruIntegrityFailure, Test-AfruLogLine,
    Get-AfruFlagState, Get-AfruOverwolfAge, Get-AfruTraceExcerpt, Find-AfruOverwolf, Stop-AfruOverwolf,
    Get-AfruOverwolfProcess, Wait-AfruOverwolf, Get-AfruRenderer, Test-AfruAppWanted, Start-AfruApp, Stop-AfruRenderer,
    Get-AfruPowerShell, Get-AfruAgentArguments, Get-AfruAgentCommand, Get-AfruAgentProcess, Stop-AfruAgent, Start-AfruAgent,
    Stop-AfruLegacySession, Register-AfruIntegration, Unregister-AfruIntegration
