# Write environment variables for the CURRENT user from a JSON payload file.
# Used by @local/dsh-assets-import, which never puts a value on a command line:
# the only argument is the path of a payload file whose ACL is narrowed to the
# calling user and which the caller deletes right after this script exits.
#
# Payload: [ { "name": "VAR_NAME", "value": "secret" }, ... ]
# Output:  {"written":["VAR_NAME",...],"count":N}   (names only, никогда значения)
param(
    [Parameter(Mandatory = $true)]
    [string] $PayloadPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $PayloadPath)) {
    Write-Error 'payload file not found'
    exit 2
}

$payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
$written = New-Object 'System.Collections.Generic.List[string]'

foreach ($entry in @($payload)) {
    if ($null -eq $entry) { continue }
    $name = [string] $entry.name
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $value = [string] $entry.value
    [Environment]::SetEnvironmentVariable($name, $value, 'User')
    $written.Add($name)
}

[ordered] @{ written = @($written); count = $written.Count } | ConvertTo-Json -Compress
