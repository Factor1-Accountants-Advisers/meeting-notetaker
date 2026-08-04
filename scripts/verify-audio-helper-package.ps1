param(
  [switch]$SkipPackagedCheck
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $repoRoot 'native/audio-endpoint-monitor/target/release/notetaker-audio-endpoints.exe'
$builderConfig = Join-Path $repoRoot 'electron-builder.yml'
$packagedHelper = Join-Path $repoRoot 'dist/win-unpacked/resources/audio/notetaker-audio-endpoints.exe'

if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
  throw "Release audio endpoint helper is missing: $helper"
}

$config = Get-Content -LiteralPath $builderConfig -Raw
if ($config -notmatch 'from:\s*native/audio-endpoint-monitor/target/release\s') {
  throw 'electron-builder.yml must map the helper release directory so its signing transformer runs.'
}
if ($config -notmatch 'to:\s*audio\s') {
  throw 'electron-builder.yml does not map the helper into resources/audio.'
}
if ($config -notmatch '(?ms)filter:\s*\r?\n\s*-\s*notetaker-audio-endpoints\.exe\s') {
  throw 'electron-builder.yml must filter the helper directory to notetaker-audio-endpoints.exe.'
}

if (-not $SkipPackagedCheck -and -not (Test-Path -LiteralPath $packagedHelper -PathType Leaf)) {
  throw "Packaged audio endpoint helper is missing: $packagedHelper"
}

Write-Host 'Audio endpoint helper packaging verification passed.'
