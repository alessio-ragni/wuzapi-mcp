# Creates .env from .env.example, filling every secret with a fresh random value.
# Windows twin of init-env.sh. Runs on Windows PowerShell 5.1 and PowerShell 7:
#   powershell -ExecutionPolicy Bypass -File scripts\init-env.ps1
# Refuses to touch an existing .env: rotating the encryption key would lock WuzAPI out of its own data.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (Test-Path '.env') {
  Write-Host '.env already exists - not overwriting it.'
  exit 1
}

function Rand([int]$bytes) {
  $buf = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buf)
  $rng.Dispose()
  return ($buf | ForEach-Object { $_.ToString('x2') }) -join ''
}

# Time zone as an IANA name (Europe/Rome). The conversion exists on PowerShell 7 only.
$tz = ''
try {
  $iana = ''
  if ([System.TimeZoneInfo]::TryConvertWindowsIdToIanaId((Get-TimeZone).Id, [ref]$iana)) { $tz = $iana }
} catch { $tz = '' }

$userHome = $env:USERPROFILE
$lines = Get-Content '.env.example' | ForEach-Object {
  switch -Regex ($_) {
    '^WUZAPI_ADMIN_TOKEN='           { "WUZAPI_ADMIN_TOKEN=$(Rand 24)"; break }
    '^WUZAPI_GLOBAL_ENCRYPTION_KEY=' { "WUZAPI_GLOBAL_ENCRYPTION_KEY=$(Rand 16)"; break }
    '^WUZAPI_GLOBAL_HMAC_KEY='       { "WUZAPI_GLOBAL_HMAC_KEY=$(Rand 32)"; break }
    '^WUZAPI_USER_TOKEN='            { "WUZAPI_USER_TOKEN=$(Rand 24)"; break }
    '^FILES_ROOT='                   { "FILES_ROOT=$userHome"; break }
    '^DOWNLOADS_DIR='                { "DOWNLOADS_DIR=$userHome\Downloads\wuzapi-mcp"; break }
    '^TZ='                           { if ($tz) { "TZ=$tz" } else { $_ }; break }
    default                          { $_ }
  }
}

# UTF-8 without BOM and LF line endings: Docker Compose reads a BOM as part of the first variable name.
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), (($lines -join "`n") + "`n"), $utf8)

Write-Host 'Created .env with random secrets.'
if (-not $tz) { Write-Host 'Time zone left as UTC: set TZ=Europe/Rome (or yours) in .env to see local times.' }
Write-Host 'Next: docker compose up -d, then open http://127.0.0.1:8091'
