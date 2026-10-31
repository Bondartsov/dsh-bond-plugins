#Requires -Version 5.1
<#
.SYNOPSIS
  Обновляет плагины dsh-bond-plugins из репозитория GitHub.

.DESCRIPTION
  Скрипт:
    1) проверяет, что рабочая копия репозитория чистая (иначе останавливается — ваши правки не теряются);
    2) делает `git pull --ff-only` (никаких merge-коммитов и перезаписей истории);
    3) переустанавливает зависимости профиля через pnpm, чтобы новые файлы попали в node_modules;
    4) напоминает, что для применения нужен ⟳ или перезапуск DSH.

  Что важно знать: сами плагины подключены к профилю junction-ссылками (`link:`), поэтому
  обновление кода в репозитории сразу видно Host'у — но уже загруженный процесс держит старый код
  в памяти. Отсюда и ⟳/перезапуск.

.PARAMETER ProfileDir
  Каталог профиля DSH (по умолчанию из `$env:DSH_PROFILE_DIR` либо `%USERPROFILE%\.dsh\profiles\desktop`).

.PARAMETER RepoRoot
  Каталог репозитория (по умолчанию — каталог этого скрипта).

.PARAMETER Branch
  Ветка, из которой обновляемся. По умолчанию `main`.

.PARAMETER SkipInstall
  Не запускать pnpm install.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = '',
    [string]$RepoRoot = '',
    [string]$Branch = 'main',
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$text) { Write-Host ('  ' + $text) }

if ($RepoRoot -eq '') { $RepoRoot = $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) { throw "Не git-репозиторий: $RepoRoot" }

if ($ProfileDir -eq '') {
    if ($env:DSH_PROFILE_DIR -and $env:DSH_PROFILE_DIR.Trim() -ne '') { $ProfileDir = $env:DSH_PROFILE_DIR }
    else { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
}

Write-Host ''
Write-Host 'Обновление плагинов dsh-bond-plugins' -ForegroundColor Cyan
Write-Step "репозиторий: $RepoRoot"
Write-Step "ветка:       $Branch"
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
    & git fetch --prune origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git fetch завершился с кодом $LASTEXITCODE" }
    & git merge --ff-only "origin/$Branch"
    if ($LASTEXITCODE -ne 0) { throw 'Быстрое обновление невозможно (история разошлась). Обратитесь к владельцу репозитория.' }
    $after = (& git rev-parse --short HEAD).Trim()
    Write-Step "новая версия:   $after"

    if ($before -eq $after) {
        Write-Host '  Изменений нет — уже последняя версия.' -ForegroundColor Green
    } else {
        Write-Step 'изменённые файлы:'
        & git diff --name-only "$before..$after" | Select-Object -First 20 | ForEach-Object { Write-Step ('  · ' + $_) }
    }

    # --- 3. зависимости ------------------------------------------------------
    if (-not $SkipInstall) {
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
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Готово. Применение:' -ForegroundColor Green
Write-Host '  · ⟳ (перезагрузка плагинов) — обновляет клиентские части;'
Write-Host '  · полный перезапуск DSH — если менялся Host-код плагинов.'
Write-Host ''
