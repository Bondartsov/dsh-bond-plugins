# List the NAMES of the current user's environment variables, and nothing else.
# Used by @local/dsh-assets-import to decide whether a secret is "уже задана".
# The values never leave the environment: the script prints names only.
[Environment]::GetEnvironmentVariables('User').Keys |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { [string]$_ } |
    ConvertTo-Json -Compress
