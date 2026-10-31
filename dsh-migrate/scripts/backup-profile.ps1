# Snapshot the DSH profile patch (models, providers, API wiring, plugin config).
#
# The harness's crash dialog can replace `cordis.patch.yml` with a minimal file — that is what
# wiped the owner's model/API settings once. This script keeps a dated copy so the file can be
# restored with one command.
#
# Portable on purpose: the profile comes from the environment, the copies stay inside the profile,
# and no absolute personal path is written anywhere.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File backup-profile.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File backup-profile.ps1 -ProfileDir <path>
#
# Prints one machine-readable line, which the plugin parses:
#   saved: cordis.patch.yml.<ДД.ММ.ГГГГ>-<ЧЧММСС>.good
param(
    [string]$ProfileDir = '',
    [int]$Keep = 5
)

$ErrorActionPreference = 'Stop'

if ($ProfileDir -eq '') {
    if ($env:DSH_PROFILE_DIR -and $env:DSH_PROFILE_DIR.Trim() -ne '') {
        $ProfileDir = $env:DSH_PROFILE_DIR
    } else {
        $ProfileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
    }
}

$src = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $src)) {
    Write-Error "profile patch not found: $src"
    exit 2
}

$dst = if ($env:DSH_BACKUP_DIR -and $env:DSH_BACKUP_DIR.Trim() -ne '') {
    $env:DSH_BACKUP_DIR
} else {
    Join-Path $ProfileDir 'backups'
}
New-Item -ItemType Directory -Path $dst -Force | Out-Null

$stamp = Get-Date -Format 'dd.MM.yyyy-HHmmss'
$name = 'cordis.patch.yml.' + $stamp + '.good'
Copy-Item -LiteralPath $src -Destination (Join-Path $dst $name) -Force

Write-Host ('saved: ' + $name)
Get-ChildItem -LiteralPath $dst -Filter '*.good' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $Keep |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
