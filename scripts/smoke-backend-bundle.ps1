<#
.SYNOPSIS
Smoke-test the PyInstaller backend bundle on Windows.

.DESCRIPTION
Starts the frozen ``notetaker-backend.exe`` with a temporary data directory,
verifies the health endpoint, uploads a short webm recording, waits for the
pipeline to reach a terminal state, checks that ffmpeg volumedetect ran, and
kills the process.  Designed to pass on a machine with **no** Python and **no**
ffmpeg on PATH — the bundle ships its own ffmpeg.

.PARAMETER BundleDir
Path to the ``backend/dist/notetaker-backend/`` directory.
Default: ``backend\dist\notetaker-backend`` relative to the repo root.

.PARAMETER Port
Port for the backend health endpoint.  Default: 18787 (non-standard to avoid
collisions with a running dev server on 8787).

.EXAMPLE
.\scripts\smoke-backend-bundle.ps1
.\scripts\smoke-backend-bundle.ps1 -BundleDir C:\build\notetaker-backend -Port 18788
#>

param(
    [string]$BundleDir = (Join-Path $PSScriptRoot "..\backend\dist\notetaker-backend"),
    [int]$Port = 18787
)

$ErrorActionPreference = "Stop"
$ExePath = Join-Path $BundleDir "notetaker-backend.exe"
$DataDir = Join-Path $Env:TEMP "mn-smoke-$PID"
$HealthUrl = "http://127.0.0.1:$Port/health"
$CreateMeetingUrl = "http://127.0.0.1:$Port/api/v1/meetings"
$UploadAudioUrl = "http://127.0.0.1:$Port/api/v1/meetings/{0}/upload"

if (-not (Test-Path $ExePath)) {
    Write-Error "notetaker-backend.exe not found at $ExePath — run pyinstaller first"
    exit 1
}

Write-Host "=== Smoke: notetaker-backend ==="
Write-Host "Bundle:  $BundleDir"
Write-Host "Data:    $DataDir"
Write-Host "Port:    $Port"
Write-Host ""

# Clean up leftover data from a previous run.
if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }

# ------------------------------------------------------------------
# 1. Start the backend
# ------------------------------------------------------------------
Write-Host "[1/5] Starting backend..."
$env:MN_DATA_DIR = $DataDir
$env:MN_BACKEND_PORT = $Port

$proc = Start-Process -FilePath $ExePath -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $Env:TEMP "mn-smoke-stdout-$PID.log") -RedirectStandardError (Join-Path $Env:TEMP "mn-smoke-stderr-$PID.log")

# Under some hosts (e.g. WSL interop) the -PassThru object can carry a null
# Id, and a null -Id binding error is terminating despite -ErrorAction.
# Fall back to killing by image name so cleanup never fails the smoke.
function Stop-Backend {
    if ($proc -and $proc.Id) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    } else {
        Get-Process -Name "notetaker-backend" -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------------
# 2. Wait for health endpoint (up to 30 s)
# ------------------------------------------------------------------
Write-Host "[2/5] Waiting for health endpoint..."
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -Method GET -TimeoutSec 2 -UseBasicParsing
        if ($resp.StatusCode -eq 200) {
            $healthy = $true
            Write-Host "  healthy after $($i + 1)s"
            break
        }
    } catch {
        # Still starting up.
    }
    Start-Sleep -Seconds 1
}

if (-not $healthy) {
    Write-Error "Backend failed to become healthy within 30 s"
    Stop-Backend
    exit 1
}

# ------------------------------------------------------------------
# 3. Create a meeting + upload a silent webm
# ------------------------------------------------------------------
Write-Host "[3/5] Creating meeting..."
$createBody = @{
    title = "Smoke test $PID"
    source = "in_person"
} | ConvertTo-Json

$createResp = Invoke-RestMethod -Uri $CreateMeetingUrl -Method POST -Body $createBody -ContentType "application/json" -UseBasicParsing
$meetingId = $createResp.id
Write-Host "  meeting: $meetingId"

Write-Host "[3/5] Uploading audio..."
# Minimal valid webm (EBML header + empty cluster). Long enough to pass
# the 1 000-byte minimum in _decode_audio_b64.
$silentWebm = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes(
    (Join-Path $PSScriptRoot "fixtures\smoke-silent.webm")))

$uploadBody = @{
    audio_b64 = $silentWebm
    mime_type = "audio/webm"
    duration_seconds = 1
} | ConvertTo-Json

$uploadResp = Invoke-RestMethod -Uri ($UploadAudioUrl -f $meetingId) -Method POST -Body $uploadBody -ContentType "application/json" -UseBasicParsing -Headers @{ "X-MN-User" = "smoke" }
Write-Host "  upload accepted: status $($uploadResp.pipeline_status)"

# ------------------------------------------------------------------
# 4. Poll until pipeline reaches a terminal state
# ------------------------------------------------------------------
Write-Host "[4/5] Waiting for pipeline..."
$meetingUrl = "$CreateMeetingUrl/$meetingId"
$done = $false
for ($i = 0; $i -lt 30; $i++) {
    $meeting = Invoke-RestMethod -Uri $meetingUrl -Method GET -UseBasicParsing -Headers @{ "X-MN-User" = "smoke" }
    if ($meeting.pipeline_status -eq "ready" -or $meeting.pipeline_status -eq "failed") {
        Write-Host "  pipeline: $($meeting.pipeline_status) after $($i + 1)s"
        $done = $true
        break
    }
    Start-Sleep -Seconds 2
}

if (-not $done) {
    Write-Error "Pipeline did not reach terminal state within 60 s"
    Stop-Backend
    exit 1
}

# ------------------------------------------------------------------
# 5. Assertions
# ------------------------------------------------------------------
Write-Host "[5/5] Assertions..."

# Pipeline reached a terminal state.
if ($meeting.pipeline_status -ne "ready" -and $meeting.pipeline_status -ne "failed") {
    Write-Error "Expected pipeline to be ready or failed, got $($meeting.pipeline_status)"
    Stop-Backend
    exit 1
}
Write-Host "  [PASS] pipeline terminal state: $($meeting.pipeline_status)"

# ffmpeg proof: the fixture is REAL silent audio, so if the bundled ffmpeg
# executed, volumedetect measures ~-91 dB and the pipeline stamps the flag
# True. The schema defaults this field to False, so anything other than True
# means ffmpeg never ran (a null/absent check would pass vacuously).
if ($meeting.recorder_audio_missing -ne $true) {
    Write-Error "recorder_audio_missing=$($meeting.recorder_audio_missing) — bundled ffmpeg did not run on the silent fixture"
    Stop-Backend
    exit 1
}
Write-Host "  [PASS] bundled ffmpeg executed: silent fixture flagged recorder_audio_missing=True"

# Cleanup
Write-Host ""
Write-Host "=== Stopping backend ==="
Stop-Backend

# Verify the backend is gone (by image name — $proc.Id can be null under
# WSL interop hosts).
Start-Sleep -Seconds 2
$stillRunning = Get-Process -Name "notetaker-backend" -ErrorAction SilentlyContinue
if ($stillRunning) {
    Write-Error "Backend process still running after stop"
    exit 1
}
Write-Host "  [PASS] backend process stopped"

Write-Host ""
Write-Host "=== ALL SMOKE CHECKS PASSED ==="
exit 0
