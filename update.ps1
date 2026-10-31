#Requires -Version 5.1
<#
.SYNOPSIS
  Обновляет плагины dsh-bond-plugins из репозитория GitHub.

.DESCRIPTION
  Скрипт:
    1) проверяет, что рабочая копия репозитория чистая (иначе останавливается — ваши правки не теряются);
    2) делает `git pull --ff-only` (никаких merge-коммитов и перезаписей истории);
    3) печатает, какие каталоги плагинов реально изменились и какие у них стали версии;
    4) переустанавливает зависимости профиля через pnpm — только если менялся каталог плагина;
    5) напоминает, что для применения нужен ⟳ или перезапуск DSH.

  Версии плагинов независимы, а git всегда тянет снапшот репозитория целиком. Поэтому скрипт
  печатает только фактически изменённые каталоги: если поехал один peer-bus, так и будет написано —
  «обновлён 1 плагин: peer-bus 2.1.0 → 2.2.0; остальные 6 без изменений». Никаких «обновлено всё».

  С ключом -Check ничего не меняется: `git fetch`, таблица «плагин · версия сейчас · изменился ли
  каталог в HEAD..origin/<ветка>», итог «изменено плагинов: N из M» и коммиты этих плагинов.

  Что важно знать: сами плагины подключены к профилю junction-ссылками (`link:`), поэтому
  обновление кода в репозитории сразу видно Host'у — но уже загруженный процесс держит старый код
  в памяти. Отсюда и ⟳/перезапуск.

.PARAMETER ProfileDir
  Каталог профиля DSH (по умолчанию из `$env:DSH_PROFILE_DIR` либо `%USERPROFILE%\.dsh\profiles\desktop`).

.PARAMETER RepoRoot
  Каталог репозитория (по умолчанию — каталог этого скрипта).

.PARAMETER Branch
  Ветка, из которой обновляемся. По умолчанию `main`.

.PARAMETER Only
  Обновить только один плагин — имя каталога (`peer-bus`) или имя пакета (`@local/dsh-peer-bus`).
  Git не умеет частичный pull: файлы всех плагинов приезжают вместе. Поэтому скрипт одной строкой
  предупреждает об этом, печатает, какие каталоги изменились фактически, и запускает pnpm install
  только если изменился указанный плагин; если нет — говорит прямо и установку не запускает.

.PARAMETER SkipInstall
  Не запускать pnpm install.

.PARAMETER Check
  Только проверить: `git fetch`, сравнение HEAD с origin/<ветка> и таблица по плагинам.
  Рабочая копия, текущий коммит и зависимости профиля не меняются — ни pull, ни merge,
  ни pnpm install.

  Код возврата: 0 — проверка выполнена (есть обновления или нет, в том числе без сети),
  1 — не удалось прочитать версии из git.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1

.EXAMPLE
  # узнать, есть ли новая версия и какие плагины изменились, ничего не меняя
  powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Check

.EXAMPLE
  # обновить только peer-bus (файлы приедут для всего репозитория)
  powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Only peer-bus
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = '',
    [string]$RepoRoot = '',
    [string]$Branch = 'main',
    [string]$Only = '',
    [switch]$SkipInstall,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$text) { Write-Host ('  ' + $text) }

# Список плагинов: сначала манифест репозитория (plugins.json), иначе — каталоги с package.json.
function Get-PluginList {
    param([string]$Root)
    $manifest = Join-Path $Root 'plugins.json'
    $list = @()
    if (Test-Path -LiteralPath $manifest) {
        try {
            $json = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($entry in @($json.plugins)) {
                if ($null -eq $entry) { continue }
                $dir = [string]$entry.dir
                if ($dir -eq '') { continue }
                $list += [pscustomobject]@{ Dir = $dir; Name = [string]$entry.name }
            }
        } catch { $list = @() }
    }
    if ($list.Count -eq 0) {
        $list = @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') } |
            ForEach-Object { [pscustomobject]@{ Dir = $_.Name; Name = '' } })
    }
    return $list
}

# Версия плагина в рабочей копии.
function Get-PluginVersion {
    param([string]$Root, [string]$Dir)
    $path = Join-Path (Join-Path $Root $Dir) 'package.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return [string]((Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json).version) }
    catch { return $null }
}

# Версия плагина в конкретной ревизии (HEAD, origin/main, короткий хеш).
function Get-VersionAtRevision {
    param([string]$Root, [string]$Revision, [string]$Dir)
    Push-Location $Root
    try {
        & git cat-file -e "${Revision}:${Dir}/package.json"
        if ($LASTEXITCODE -ne 0) { return $null }
        $raw = & git show "${Revision}:${Dir}/package.json"
        if ($LASTEXITCODE -ne 0 -or $null -eq $raw) { return $null }
        try { return [string](($raw -join "`n") | ConvertFrom-Json).version }
        catch { return $null }
    } finally {
        Pop-Location
    }
}

# Карта «первый сегмент пути -> сколько файлов изменилось». Git не различает плагинов — различаем мы.
function Get-ChangedDirMap {
    param([string[]]$Paths, [hashtable]$Map)
    foreach ($path in $Paths) {
        if ($null -eq $path -or $path -eq '') { continue }
        $segment = ($path -split '[\\/]')[0]
        if ($segment -eq '' -or $segment -eq '.git') { continue }
        if ($Map.ContainsKey($segment)) { $Map[$segment] = $Map[$segment] + 1 }
        else { $Map[$segment] = 1 }
    }
}

# «обновлён 1 плагин» / «обновлены 2 плагина» / «обновлено 5 плагинов».
function Format-PluginCount {
    param([int]$count)
    $mod10 = $count % 10
    $mod100 = $count % 100
    if ($mod10 -eq 1 -and $mod100 -ne 11) { return "обновлён $count плагин" }
    if ($mod10 -ge 2 -and $mod10 -le 4 -and ($mod100 -lt 12 -or $mod100 -gt 14)) { return "обновлены $count плагина" }
    return "обновлено $count плагинов"
}

# «peer-bus 2.1.0 → 2.2.0» (версии берутся из package.json обеих ревизий).
function Format-PluginChange {
    param([object]$Plugin, [string]$FromRevision, [string]$ToRevision)
    $from = Get-VersionAtRevision -Root $RepoRoot -Revision $FromRevision -Dir $Plugin.Dir
    $to = Get-VersionAtRevision -Root $RepoRoot -Revision $ToRevision -Dir $Plugin.Dir
    if ($from -and $to -and $from -ne $to) { return ('{0} {1} → {2}' -f $Plugin.Dir, $from, $to) }
    if ($to) { return ('{0} → {1}' -f $Plugin.Dir, $to) }
    return $Plugin.Dir
}

if ($RepoRoot -eq '') { $RepoRoot = $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) { throw "Не git-репозиторий: $RepoRoot" }

if ($ProfileDir -eq '') {
    if ($env:DSH_PROFILE_DIR -and $env:DSH_PROFILE_DIR.Trim() -ne '') { $ProfileDir = $env:DSH_PROFILE_DIR }
    else { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
}

$plugins = @(Get-PluginList -Root $RepoRoot)
$pluginDirs = @($plugins | ForEach-Object { $_.Dir })

if ($Check) {
    Write-Host ''
    Write-Host 'Проверка обновлений плагинов dsh-bond-plugins' -ForegroundColor Cyan
    Write-Step "репозиторий: $RepoRoot"
    Write-Step "ветка:       $Branch"
    Write-Host ''
    Push-Location $RepoRoot
    try {
        # Единственная сетевая команда: она обновляет только remote-tracking ссылки в .git,
        # рабочая копия и текущий коммит остаются как были.
        & git fetch --quiet --prune origin $Branch
        if ($LASTEXITCODE -ne 0) {
            # Без сети проверка всё равно полезна: показываем последнюю известную локальной
            # копии версию и прямо говорим, что она могла устареть.
            Write-Host '  Внимание: git fetch не удался — нет сети или доступа к GitHub.' -ForegroundColor Yellow
            Write-Host '  Ниже последняя версия, известная локальной копии; она могла устареть.' -ForegroundColor Yellow
        }
        $local = (& git rev-parse --short HEAD).Trim()
        $remote = (& git rev-parse --short "origin/$Branch").Trim()
        if ($local -eq '' -or $remote -eq '') {
            throw "не удалось прочитать версии из git (HEAD или origin/$Branch): проверьте сеть и ветку $Branch"
        }
        $behind = [int]((& git rev-list --count "HEAD..origin/$Branch").Trim())
        $ahead = [int]((& git rev-list --count "origin/$Branch..HEAD").Trim())

        $changedDirs = @{}
        if ($behind -gt 0) {
            Get-ChangedDirMap -Paths @(& git diff --name-only "HEAD..origin/$Branch") -Map $changedDirs
        }
        $changedPlugins = @($plugins | Where-Object { $changedDirs.ContainsKey($_.Dir) })

        Write-Host ("  установлена версия {0}, доступна {1}" -f $local, $remote)
        Write-Host ''
        Write-Host '  плагин                    версия сейчас   каталог в HEAD..origin'
        foreach ($plugin in $plugins) {
            $version = Get-PluginVersion -Root $RepoRoot -Dir $plugin.Dir
            if (-not $version) { $version = '?' }
            $state = if ($changedDirs.ContainsKey($plugin.Dir)) { 'изменился' } else { '—' }
            Write-Host ('  {0,-24} {1,-15} {2}' -f $plugin.Dir, $version, $state)
        }
        Write-Host ''
        if ($behind -eq 0) {
            Write-Host '  Обновлений нет — установлена последняя версия.' -ForegroundColor Green
        } elseif ($changedPlugins.Count -eq 0) {
            Write-Host ("  изменено плагинов: 0 из {0} — изменения есть только вне каталогов плагинов." -f $plugins.Count) -ForegroundColor Yellow
        } else {
            Write-Host ("  изменено плагинов: {0} из {1}" -f $changedPlugins.Count, $plugins.Count) -ForegroundColor Yellow
            $parts = @()
            foreach ($plugin in $changedPlugins) {
                $parts += (Format-PluginChange -Plugin $plugin -FromRevision 'HEAD' -ToRevision "origin/$Branch")
            }
            Write-Step ('изменения: ' + ($parts -join '; '))
            Write-Step 'коммиты этих плагинов:'
            $dirs = @($changedPlugins | ForEach-Object { $_.Dir })
            & git log --oneline --no-decorate "HEAD..origin/$Branch" -- $dirs |
                Select-Object -First 10 | ForEach-Object { Write-Step ('  · ' + $_) }
        }
        $extraDirs = @($changedDirs.Keys | Where-Object { $pluginDirs -notcontains $_ })
        if ($extraDirs.Count -gt 0) {
            Write-Step ('кроме плагинов изменены: ' + (($extraDirs | Sort-Object) -join ', '))
        }
        $dirty = (& git status --porcelain) | Where-Object { $_ -ne '' }
        if ($dirty) {
            Write-Host '  Внимание: в репозитории есть непринятые изменения — с ними update.ps1' -ForegroundColor Yellow
            Write-Host '  откажется обновляться, пока их не закоммитить или не спрятать (git stash).' -ForegroundColor Yellow
        }
        if ($behind -gt 0) {
            Write-Host ''
            Write-Host '  Обновиться: powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1' -ForegroundColor Cyan
        }
        if ($ahead -gt 0) {
            Write-Step "локальных коммитов впереди origin/${Branch}: $ahead (обновление их не трогает)"
        }
    } finally {
        Pop-Location
    }
    Write-Host ''
    return
}

Write-Host ''
Write-Host 'Обновление плагинов dsh-bond-plugins' -ForegroundColor Cyan
Write-Step "репозиторий: $RepoRoot"
Write-Step "ветка:       $Branch"
$onlyDir = ''
if ($Only -ne '') {
    foreach ($plugin in $plugins) {
        if ($plugin.Dir -ieq $Only -or ($plugin.Name -ne '' -and $plugin.Name -ieq $Only)) { $onlyDir = $plugin.Dir; break }
    }
    if ($onlyDir -eq '') {
        throw ("плагин не найден: {0}. Доступные каталоги: {1}" -f $Only, ($pluginDirs -join ', '))
    }
    Write-Step ("-Only: {0}" -f $onlyDir)
}
Write-Host ''

# --- 1. чистота рабочей копии ------------------------------------------------
Push-Location $RepoRoot
try {
    $dirty = (& git status --porcelain) | Where-Object { $_ -ne '' }
    if ($dirty) {
        Write-Host 'В репозитории есть непринятые изменения:' -ForegroundColor Yellow
        $dirty | Select-Object -First 10 | ForEach-Object { Write-Step $_ }
        throw 'Обновление остановлено. Закоммитьте или отмените правки (git stash) и повторите.'
    }

    $before = (& git rev-parse --short HEAD).Trim()
    Write-Step "текущая версия: $before"

    # --- 2. обновление -------------------------------------------------------
    & git fetch --quiet --prune origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git fetch завершился с кодом $LASTEXITCODE" }
    & git merge --ff-only "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { throw 'Быстрое обновление невозможно (история разошлась). Обратитесь к владельцу репозитория.' }
    $after = (& git rev-parse --short HEAD).Trim()
    Write-Step "новая версия:   $after"
    Write-Host ''

    # --- 3. что именно изменилось -------------------------------------------
    $changedDirs = @{}
    if ($before -ne $after) {
        Get-ChangedDirMap -Paths @(& git diff --name-only "$before..$after") -Map $changedDirs
    }
    $changedPlugins = @($plugins | Where-Object { $changedDirs.ContainsKey($_.Dir) })
    $extraDirs = @($changedDirs.Keys | Where-Object { $pluginDirs -notcontains $_ })

    if ($before -eq $after) {
        Write-Host '  Изменений нет — уже последняя версия.' -ForegroundColor Green
    } elseif ($changedPlugins.Count -eq 0) {
        Write-Host '  Каталоги плагинов не изменились — приехали только файлы вне плагинов.' -ForegroundColor Green
    } else {
        $parts = @()
        foreach ($plugin in $changedPlugins) {
            $parts += (Format-PluginChange -Plugin $plugin -FromRevision $before -ToRevision $after)
        }
        $rest = $plugins.Count - $changedPlugins.Count
        if ($rest -gt 0) {
            Write-Host ('  ' + (Format-PluginCount $changedPlugins.Count) + ': ' + ($parts -join '; ') + "; остальные $rest без изменений") -ForegroundColor Yellow
        } else {
            Write-Host ('  ' + (Format-PluginCount $changedPlugins.Count) + ': ' + ($parts -join '; ')) -ForegroundColor Yellow
        }
    }
    if ($extraDirs.Count -gt 0) {
        Write-Step ('кроме плагинов изменены: ' + (($extraDirs | Sort-Object) -join ', '))
    }

    # --- 4. -Only: предупредить, что снапшот общий --------------------------
    $targetChanged = $false
    if ($onlyDir -ne '') {
        foreach ($plugin in $changedPlugins) { if ($plugin.Dir -eq $onlyDir) { $targetChanged = $true } }
        $changedNames = @($changedPlugins | ForEach-Object { $_.Dir })
        if ($changedNames.Count -eq 0) { $changedNames = @('нет') }
        Write-Host ("  Внимание: файлы всех плагинов обновляются вместе, версии и релизы независимы; изменённым оказался: {0}." -f ($changedNames -join ', ')) -ForegroundColor Yellow
        if (-not $targetChanged) {
            Write-Host ("  плагин {0} не изменился — pnpm install не нужен." -f $onlyDir) -ForegroundColor Green
        }
    }

    # --- 5. зависимости ------------------------------------------------------
    $needInstall = ($changedPlugins.Count -gt 0)
    if ($onlyDir -ne '') {
        $needInstall = @($changedPlugins | Where-Object { $_.Dir -eq $onlyDir }).Count -gt 0
    }
    if (-not $SkipInstall) {
        if (-not $needInstall) {
            # С -Only об этом уже сказано выше — не повторяем.
            if ($onlyDir -eq '') { Write-Step 'pnpm install не требуется: ни один каталог плагина не изменился.' }
        } else {
            $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
            if ($null -eq $pnpm) {
                Write-Warning 'pnpm не найден: "npm install -g pnpm", затем повторите обновление.'
            } elseif (Test-Path -LiteralPath (Join-Path $ProfileDir 'package.json')) {
                Push-Location $ProfileDir
                try {
                    Write-Step 'pnpm install…'
                    & pnpm install --prefer-offline
                    if ($LASTEXITCODE -ne 0) { throw "pnpm install завершился с кодом $LASTEXITCODE" }
                } finally {
                    Pop-Location
                }
            }
        }
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Готово. Применение:' -ForegroundColor Green
Write-Host '  · ⟳ (перезагрузка плагинов) — обновляет клиентские части;'
Write-Host '  · полный перезапуск DSH — если менялся Host-код плагинов.'
Write-Host ''
