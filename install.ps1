#Requires -Version 5.1
<#
.SYNOPSIS
  Устанавливает плагины из репозитория dsh-bond-plugins в профиль DeepSeek Harness.

.DESCRIPTION
  Скрипт делает ровно четыре вещи и ничего больше:
    1) снимает резервную копию `package.json` и `cordis.patch.yml` профиля;
    2) добавляет плагины в `dependencies` профиля как `link:` на каталоги репозитория;
    3) добавляет их в `dsh.profile.bundles` (список загружаемых бандлов);
    4) ставит зависимости профиля через pnpm (создаёт junction-ссылки в node_modules).

  Ничего не удаляет и не перезаписывает в настройках моделей, провайдеров, MCP и правах.

.PARAMETER ProfileDir
  Каталог профиля DSH. По умолчанию — из `$env:DSH_PROFILE_DIR` либо `%USERPROFILE%\.dsh\profiles\desktop`.

.PARAMETER RepoRoot
  Каталог репозитория. По умолчанию — каталог, где лежит этот скрипт.

.PARAMETER Only
  Установить только перечисленные плагины (по имени пакета, например `@local/dsh-peer-bus`).

.PARAMETER SkipInstall
  Не запускать pnpm install (полезно, если профиль обновляется другим способом).

.PARAMETER WhatIf
  Показать, что было бы сделано, и выйти, ничего не меняя.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Only "@local/dsh-peer-bus","@local/dsh-migrate"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProfileDir = '',
    [string]$RepoRoot = '',
    [string[]]$Only = @(),
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$text) { Write-Host ('  ' + $text) }

# --- пути -------------------------------------------------------------------
if ($RepoRoot -eq '') { $RepoRoot = $PSScriptRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

if ($ProfileDir -eq '') {
    if ($env:DSH_PROFILE_DIR -and $env:DSH_PROFILE_DIR.Trim() -ne '') { $ProfileDir = $env:DSH_PROFILE_DIR }
    else { $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
}
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "Профиль не найден: $ProfileDir" }

$manifestPath = Join-Path $RepoRoot 'plugins.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Нет манифеста plugins.json в $RepoRoot" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$profileJsonPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $profileJsonPath)) { throw "Нет package.json в профиле: $profileJsonPath" }

Write-Host ''
Write-Host 'Установка плагинов dsh-bond-plugins' -ForegroundColor Cyan
Write-Step "репозиторий: $RepoRoot"
Write-Step "профиль:    $ProfileDir"
Write-Host ''

# --- отбор плагинов ---------------------------------------------------------
$selected = @()
foreach ($plugin in $manifest.plugins) {
    $dir = Join-Path $RepoRoot $plugin.dir
    if (-not (Test-Path -LiteralPath $dir)) { Write-Warning "пропущен $($plugin.name): нет каталога $dir"; continue }
    if ($Only.Count -gt 0 -and ($Only -notcontains $plugin.name)) { continue }
    $selected += [pscustomobject]@{ Name = $plugin.name; Dir = $dir; Leaf = ($plugin.name -split '/')[-1] }
}
if ($selected.Count -eq 0) { throw 'Не выбрано ни одного плагина.' }

# --- резервная копия --------------------------------------------------------
$stamp = Get-Date -Format 'dd.MM.yyyy-HHmmss'
$backupDir = Join-Path $ProfileDir ('backups\' + $stamp)
if ($PSCmdlet.ShouldProcess($backupDir, 'снять резервную копию профиля')) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    Copy-Item -LiteralPath $profileJsonPath -Destination $backupDir -Force
    $patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
    if (Test-Path -LiteralPath $patchPath) { Copy-Item -LiteralPath $patchPath -Destination $backupDir -Force }
    Write-Step "резервная копия: $backupDir"
}

# --- правка package.json профиля --------------------------------------------
$profileJson = Get-Content -LiteralPath $profileJsonPath -Raw | ConvertFrom-Json
if ($null -eq $profileJson.dependencies) {
    $profileJson | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{}) -Force
}
if ($null -eq $profileJson.dsh -or $null -eq $profileJson.dsh.profile) {
    throw 'В package.json профиля нет dsh.profile — это не профиль DSH.'
}

$bundles = [System.Collections.Generic.List[string]]::new()
foreach ($b in @($profileJson.dsh.profile.bundles)) { if ($b) { $bundles.Add([string]$b) } }

$deps = [ordered]@{}
foreach ($property in $profileJson.dependencies.PSObject.Properties) { $deps[$property.Name] = $property.Value }

$changed = 0
foreach ($plugin in $selected) {
    $linkPath = 'link:' + ($plugin.Dir -replace '\\', '/')
    if ($PSCmdlet.ShouldProcess($plugin.Name, 'добавить в профиль')) {
        if ($deps.Contains($plugin.Name) -and $deps[$plugin.Name] -eq $linkPath) {
            Write-Step "уже подключён: $($plugin.Name)"
        } else {
            $deps[$plugin.Name] = $linkPath
            Write-Step "зависимость: $($plugin.Name) -> $($plugin.Dir)"
            $changed++
        }
        if ($bundles -contains $plugin.Name) {
            Write-Step "бандл уже в списке: $($plugin.Name)"
        } else {
            $bundles.Add($plugin.Name)
            Write-Step "бандл добавлен: $($plugin.Name)"
            $changed++
        }
    }
}

if ($PSCmdlet.ShouldProcess($profileJsonPath, 'записать package.json профиля')) {
    $out = [ordered]@{
        name         = $profileJson.name
        private      = if ($null -ne $profileJson.private) { $profileJson.private } else { $true }
        dependencies = $deps
        dsh          = [ordered]@{ profile = [ordered]@{ bundles = $bundles } }
    }
    if ($null -ne $profileJson.dsh.profile.PSObject.Properties['agentPresets']) {
        $out.dsh.profile.agentPresets = $profileJson.dsh.profile.agentPresets
    }
    ($out | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $profileJsonPath -Encoding UTF8
    Write-Step "package.json профиля обновлён (изменений: $changed)"
}

# --- зависимости ------------------------------------------------------------
if (-not $SkipInstall) {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -eq $pnpm) {
        Write-Warning 'pnpm не найден: установите его командой "npm install -g pnpm" и запустите скрипт снова.'
        Write-Warning 'Пока профиль не установлен, DSH не увидит плагины.'
    } elseif ($PSCmdlet.ShouldProcess($ProfileDir, 'pnpm install')) {
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

Write-Host ''
Write-Host 'Готово. Дальше:' -ForegroundColor Green
Write-Host '  1. Перезагрузите плагины кнопкой ⟳ — появятся клиентские части (панели, индикаторы).'
Write-Host '  2. Если ⟳ не подхватил Host-часть, полностью перезапустите DeepSeek Harness.'
Write-Host "  3. Откат: скопируйте файлы из $backupDir обратно в профиль и запустите pnpm install."
Write-Host ''
