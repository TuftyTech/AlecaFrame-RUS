# Фоновый агент AlecaFrame-RU. Запускается при входе в Windows (ярлык в «Автозагрузке») и ярлыком
# «AlecaFrame (русский)» (-Launch). Окна у него нет.
#  - Overwolf запущен без нужных флагов (автозапуск, обновление Overwolf) -> файлы AlecaFrame возвращаются
#    в исходный вид, а только что запущенный Overwolf перезапускается с флагами.
#  - Overwolf работает с флагами -> перевод подключается, в том числе после обновления AlecaFrame.
#  - Overwolf закрыт -> файлы AlecaFrame в исходном виде.
param([switch]$Launch)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AlecaFrameRU.psm1') -Force

$paths = Get-AfruPaths
$tickMs = 2000
$maxLogBytes = 512KB
$restartWindowMinutes = 10

function Write-Log([string]$Message) {
    try {
        New-Item -ItemType Directory -Force -Path $paths.State | Out-Null
        if ((Test-Path -LiteralPath $paths.Log) -and (Get-Item -LiteralPath $paths.Log).Length -gt $maxLogBytes) {
            Move-Item -LiteralPath $paths.Log -Destination ($paths.Log + '.old') -Force
        }
        Add-Content -LiteralPath $paths.Log -Value ("{0} [агент] {1}" -f (Get-Date -Format o), $Message) -Encoding UTF8
    }
    catch { }
}

function Set-Status([string]$Code, [string]$Message) {
    try { Write-AfruStatus -Path $paths.Status -Code $Code -Message $Message } catch { }
    Write-Log "$Code`: $Message"
}

function Request-Launch {
    New-Item -ItemType Directory -Force -Path $paths.State | Out-Null
    Set-Content -LiteralPath $paths.LaunchRequest -Value (Get-Date -Format o)
}

# Окно с вопросом поверх остальных; у агента нет консоли, а решение нужно от пользователя.
function Show-Message([string]$Text, [switch]$Question) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $result = [System.Windows.Forms.MessageBox]::Show($Text, 'AlecaFrame-RU',
            $(if ($Question) { [System.Windows.Forms.MessageBoxButtons]::YesNo } else { [System.Windows.Forms.MessageBoxButtons]::OK }),
            $(if ($Question) { [System.Windows.Forms.MessageBoxIcon]::Question } else { [System.Windows.Forms.MessageBoxIcon]::Warning }),
            $(if ($Question) { [System.Windows.Forms.MessageBoxDefaultButton]::Button2 } else { [System.Windows.Forms.MessageBoxDefaultButton]::Button1 }),
            [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly)
        return $result -eq [System.Windows.Forms.DialogResult]::Yes
    }
    catch {
        Write-Log "Не удалось показать сообщение: $($_.Exception.Message)"
        return $false
    }
}

# Один агент на пользователя. Второй экземпляр (ярлык) только просит первый открыть AlecaFrame.
$mutex = New-Object System.Threading.Mutex($false, 'Local\AlecaFrameRU-Agent')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
    if ($Launch) { Request-Launch }
    exit 0
}
if ($Launch) { Request-Launch }

$install = $null
$installCheckedAt = [datetime]::MinValue
$reportOnly = Test-Path -LiteralPath $paths.ReportOnly
$flags = Get-AfruFlags $reportOnly
$restarts = New-Object System.Collections.Generic.List[datetime]
$patchedAt = $null
$loadedSeen = $true
$lastState = ''
$lastError = ''
$scanCache = $null
$tick = 0
$stop = $false

function Get-Install {
    if ($script:install) { return $script:install }
    if (((Get-Date) - $script:installCheckedAt).TotalSeconds -lt 30) { return $null }
    $script:installCheckedAt = Get-Date
    try { $script:install = Find-AfruOverwolf } catch { Write-Log $_.Exception.Message }
    $script:install
}

# Чтение девяти страниц каждые 2 секунды ни к чему: состояние меняется в основном нашими же действиями.
function Get-PatchState([object[]]$Versions, [bool]$Force) {
    if ($Force -or -not $script:scanCache -or ($script:tick % 15) -eq 0) {
        $latest = $false
        $any = $false
        for ($i = 0; $i -lt $Versions.Count; $i++) {
            $p = Test-AfruPatched -VersionPath $Versions[$i].FullName
            if ($p -and $i -eq 0) { $latest = $true }
            if ($p) { $any = $true }
        }
        $script:scanCache = [pscustomobject]@{ Latest = $latest; Any = $any }
    }
    $script:scanCache
}

function Restore-Files([string]$Why) {
    $count = Restore-AfruAll -ExtensionsRoot $paths.Extensions -BackupRoot $paths.Backup
    $script:scanCache = $null
    $script:patchedAt = $null
    if ($count) { Write-Log "Файлы AlecaFrame возвращены в исходный вид ($count стр.): $Why" }
}

function Invoke-Patch([object]$VersionDir) {
    $pages = @(Add-AfruLocalizer -VersionPath $VersionDir.FullName -ExtensionsRoot $paths.Extensions `
        -LocalizerSource $paths.Localizer -BackupRoot (Join-Path $paths.Backup $VersionDir.Name))
    $script:scanCache = $null
    $script:patchedAt = Get-Date
    $script:loadedSeen = $false
    Set-Status 'patched' "Перевод подключён к AlecaFrame $($VersionDir.Name) (страниц: $($pages.Count))"
}

function Restart-Overwolf([object]$Install, [string]$Why) {
    Set-Status 'restarting' "Перезапускаю Overwolf с флагами ($Why)"
    Stop-AfruOverwolf
    Restore-Files 'перед перезапуском Overwolf'
    Write-Log ('Флаги: ' + ($script:flags -join ' '))
    Start-Process -FilePath $Install.Overwolf -ArgumentList $script:flags
    $processes = Wait-AfruOverwolf -TimeoutSeconds 60
    $state = Get-AfruFlagState -Processes $processes -Flags $script:flags
    if ($state -ne 'ok') {
        Write-Log "После перезапуска Overwolf: $state"
        foreach ($process in $processes) { Write-Log "  $($process.Path) $($process.CommandLine)" }
    }
    $state
}

function Write-IntegrityDiagnostics([object]$Failure) {
    Write-Log "HashMismatch: $($Failure.Line)"
    Write-Log "Журнал Overwolf: $($Failure.Trace)"
    foreach ($line in (Get-AfruTraceExcerpt -Trace $Failure.Trace)) { Write-Log "  trace: $line" }
}

<#
  Можно ли добавить флаг report-only. Если открыто окно Install.cmd, вопрос задаётся там, как в Start.cmd:
  у агента нет окна, а отдельное сообщение легко пропустить или закрыть клавишей Enter (кнопка по умолчанию «Нет»).
#>
function Request-ReportOnly {
    if (Test-Path -LiteralPath $paths.ReportOnly) { return $true }
    if (Test-AfruWatcher -Path $paths.Watcher) {
        Remove-Item -LiteralPath $paths.ReportOnlyNo -Force -ErrorAction SilentlyContinue
        Set-Status 'question' 'Нужно ваше решение в окне установки'
        while ($true) {
            if (Test-Path -LiteralPath $paths.ReportOnly) { return $true }
            if (Test-Path -LiteralPath $paths.ReportOnlyNo) {
                Remove-Item -LiteralPath $paths.ReportOnlyNo -Force -ErrorAction SilentlyContinue
                return $false
            }
            if (-not (Test-AfruWatcher -Path $paths.Watcher)) { break }
            Start-Sleep -Milliseconds 500
        }
        Write-Log 'Окно установки закрыли, не ответив: спрашиваю отдельным окном.'
    }
    $allowed = Show-Message -Question (
        "Ваша сборка Overwolf проверяет файлы даже с флагом extension-validation и закрыла изменённый AlecaFrame. " +
        "Файлы AlecaFrame уже возвращены в исходный вид.`n`n" +
        "Можно запускать Overwolf ещё и с флагом force-validation-report-only: Overwolf по-прежнему сверяет файлы, " +
        "но о несовпадениях только пишет в журнал и не закрывает приложение. Это касается ВСЕХ приложений Overwolf, " +
        "пока AlecaFrame-RU установлен.`n`nПерезапустить Overwolf с этим флагом? Ответ запомнится.")
    if ($allowed) { Set-Content -LiteralPath $paths.ReportOnly -Value (Get-Date -Format o) }
    $allowed
}

# Overwolf закрыл изменённый AlecaFrame даже с флагом: файлы назад, дальше решает пользователь.
function Resolve-IntegrityFailure([object]$Failure, [object]$VersionDir, [object]$Install) {
    Write-IntegrityDiagnostics $Failure
    Restore-Files 'HashMismatch'
    if (-not $script:reportOnly) {
        if (Request-ReportOnly) {
            Write-Log 'Пользователь разрешил force-validation-report-only.'
            $script:reportOnly = $true
            $script:flags = Get-AfruFlags $true
            if ((Restart-Overwolf $Install 'режим force-validation-report-only') -eq 'ok') {
                Invoke-Patch $VersionDir
                $null = Start-AfruApp -Launcher $Install.Launcher
            }
            return
        }
        Write-Log 'Пользователь отказался от force-validation-report-only.'
        Set-Content -LiteralPath $paths.Blocked -Value 'declined'
        Set-Status 'blocked' ('Ответ «нет» на вопрос о флаге force-validation-report-only: без него эта сборка Overwolf ' +
            'закрывает изменённый AlecaFrame, поэтому он работает на английском. Передумаете — запустите Install.cmd ещё раз.')
    }
    else {
        Set-Content -LiteralPath $paths.Blocked -Value 'unsupported'
        Set-Status 'blocked' ("Overwolf закрыл AlecaFrame (HashMismatch) даже с флагом force-validation-report-only: " +
            "с этой сборкой Overwolf перевод пока не работает. Создайте issue и приложите журнал: $($paths.Log)")
        $null = Show-Message ("Overwolf закрыл изменённый AlecaFrame даже в режиме force-validation-report-only. " +
            "Файлы возвращены, AlecaFrame будет на английском.`n`nСоздайте issue на GitHub и приложите журнал:`n$($paths.Log)")
    }
    $null = Start-AfruApp -Launcher $Install.Launcher
}

function Invoke-Tick {
    if (-not (Test-Path -LiteralPath $paths.Localizer)) {
        Restore-Files 'AlecaFrame-RU удалён'
        $script:stop = $true
        return
    }
    $versions = @(Get-AfruVersionDirectories -ExtensionsRoot $paths.Extensions)
    if (-not $versions.Count) { return }
    $versionDir = $versions[0]

    $launch = Test-Path -LiteralPath $paths.LaunchRequest
    if ($launch) { Remove-Item -LiteralPath $paths.LaunchRequest -Force -ErrorAction SilentlyContinue }
    $blocked = Test-Path -LiteralPath $paths.Blocked
    $processes = @(Get-AfruOverwolfProcess)
    $state = Get-AfruFlagState -Processes $processes -Flags $script:flags
    $changed = $state -ne $script:lastState
    if ($changed) {
        Write-Log "Overwolf: $state"
        if ($state -eq 'unknown') { Set-Status 'admin' 'Overwolf запущен от имени администратора: агент не видит его флагов, AlecaFrame на английском.' }
    }
    $script:lastState = $state
    $scan = Get-PatchState $versions $changed

    $cutoff = (Get-Date).AddMinutes(-$restartWindowMinutes)
    while ($script:restarts.Count -and $script:restarts[0] -lt $cutoff) { $script:restarts.RemoveAt(0) }
    $age = Get-AfruOverwolfAge -Processes $processes
    # Окна AlecaFrame ищем только у Overwolf без флагов: в остальных случаях это ничего не меняет.
    $appRunning = $state -eq 'missing' -and -not $blocked -and [bool](Get-AfruRenderer)
    $decision = Get-AfruAgentDecision -FlagState $state -LaunchRequested $launch -Blocked $blocked -AppRunning $appRunning `
        -Patched $(if ($state -eq 'ok' -and -not $blocked) { $scan.Latest } else { $scan.Any }) `
        -OverwolfAgeSeconds $age -RestartAttempts $script:restarts.Count

    # Перевод подключён к старой папке, а AlecaFrame уже обновился: старую возвращаем.
    if ($state -eq 'ok' -and $scan.Any -and -not $scan.Latest -and $versions.Count -gt 1) { Restore-Files 'обновление AlecaFrame' }
    if ($decision.Restore) { Restore-Files "Overwolf: $state" }

    $install = Get-Install
    $wantApp = [bool]$decision.LaunchApp
    if (($decision.RestartOverwolf -or $decision.StartOverwolf) -and $install) {
        $why = if ($launch) { 'открытие AlecaFrame ярлыком' } elseif ($appRunning) { 'AlecaFrame открыт без перевода' } else { 'Overwolf запущен без флагов' }
        if ($decision.RestartOverwolf) {
            # AlecaFrame уже открыт или открывается, либо Overwolf успел его закрыть: после перезапуска открываем снова.
            $since = if ($age -ge 0) { (Get-Date).AddSeconds(-$age - 5) } else { (Get-Date).AddMinutes(-3) }
            $wantApp = $wantApp -or $appRunning -or (Test-AfruAppWanted) -or
                [bool](Get-AfruIntegrityFailure -Since $since -LogRoot $paths.OverwolfLog)
            $script:restarts.Add((Get-Date))
        }
        $state = Restart-Overwolf $install $why
        $script:lastState = $state
    }

    if ($state -eq 'ok' -and -not $blocked -and -not (Test-AfruPatched -VersionPath $versionDir.FullName)) {
        $rendererRunning = [bool](Get-AfruRenderer)
        Invoke-Patch $versionDir
        if ($rendererRunning) {
            # Открытые окна AlecaFrame загружены без перевода: перезапускаем их.
            Stop-AfruRenderer
            Start-Sleep -Seconds 2
            $wantApp = $true
        }
    }

    if ($wantApp -and $install) { $null = Start-AfruApp -Launcher $install.Launcher }

    if ($state -eq 'ok' -and $script:patchedAt -and -not $blocked) {
        if (-not $script:loadedSeen -and (Test-AfruLogLine -Path (Join-Path $paths.AppLog 'MainWindow.html.log') `
                -Pattern '\[AlecaFrame-RU\] loaded' -Since $script:patchedAt)) {
            $script:loadedSeen = $true
            Set-Status 'loaded' 'AlecaFrame открыт на русском'
        }
        if (($script:tick % 3) -eq 0 -and $install) {
            $failure = Get-AfruIntegrityFailure -Since $script:patchedAt -LogRoot $paths.OverwolfLog
            if ($failure) { Resolve-IntegrityFailure $failure $versionDir $install }
        }
    }
}

Write-Log ("Агент запущен (PowerShell {0}, -Launch: {1})" -f $PSVersionTable.PSVersion, [bool]$Launch)
Set-Status 'started' 'Агент запущен'
try {
    while (-not $stop) {
        try {
            Invoke-Tick
            $lastError = ''
        }
        catch {
            $message = $_.Exception.Message
            if ($message -ne $lastError) { Set-Status 'error' $message }
            $lastError = $message
        }
        $tick++
        if (-not $stop) { Start-Sleep -Milliseconds $tickMs }
    }
}
finally {
    Write-Log 'Агент остановлен.'
    $mutex.ReleaseMutex()
}
