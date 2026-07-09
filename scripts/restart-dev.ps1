<#
.SYNOPSIS
Stop Meeting Notetaker dev processes and relaunch backend + Electron client.

.DESCRIPTION
Kills uvicorn workers (including orphaned multiprocessing children on port 8787),
electron-vite, and Electron processes tied to this repo, then starts:
  1. FastAPI backend (uvicorn on 127.0.0.1:8787, cwd backend/, loads backend/.env)
  2. npm run dev in a new PowerShell window

.PARAMETER Port
Backend port. Default: 8787.

.PARAMETER NoDevWindow
Start ``npm run dev`` hidden instead of opening a new console window.

.EXAMPLE
.\scripts\restart-dev.ps1
npm run dev:restart
#>

param(
    [int]$Port = 8787,
    [switch]$NoDevWindow
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BackendDir = Join-Path $RepoRoot "backend"
$PythonExe = Join-Path $BackendDir ".venv\Scripts\python.exe"
$HealthUrl = "http://127.0.0.1:$Port/health"

function Write-Step([string]$Message) {
    Write-Host $Message
}

function Stop-NotetakerProcesses {
    Write-Step "Stopping Meeting Notetaker processes..."

    # Release the backend port first (catches orphaned uvicorn multiprocessing workers).
    $portOwners = @(
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    foreach ($ownerId in $portOwners) {
        if ($ownerId) {
            Stop-Process -Id $ownerId -Force -ErrorAction SilentlyContinue
        }
    }

    # Stop repo-scoped dev processes by command line.
    $repoNeedle = [regex]::Escape($RepoRoot)
    $patterns = @(
        "$repoNeedle.*uvicorn app\.main:app",
        "$repoNeedle.*electron-vite",
        "$repoNeedle.*\\electron\.exe",
        "$repoNeedle.*\\node\.exe.*electron-vite"
    )

    $killed = @{}
    foreach ($proc in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
        $cmd = $proc.CommandLine
        if (-not $cmd) { continue }
        if ($cmd -like '*uvicorn app.main:app*') {
            $id = [int]$proc.ProcessId
            if (-not $killed.ContainsKey($id)) {
                Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
                $killed[$id] = $true
            }
            continue
        }
        foreach ($pattern in $patterns) {
            if ($cmd -match $pattern) {
                $id = [int]$proc.ProcessId
                if (-not $killed.ContainsKey($id)) {
                    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
                    $killed[$id] = $true
                }
                break
            }
        }
    }

    if ($killed.Count -gt 0) {
        Write-Step "  stopped $($killed.Count) process(es)"
    } else {
        Write-Step "  no matching processes found"
    }

    Start-Sleep -Seconds 2
}

function Import-BackendDotEnv {
    # pydantic-settings reads .env for Settings fields, but find_ffmpeg() reads
    # MN_FFMPEG_PATH from os.environ directly — inherit it into the uvicorn child.
    $dotenv = Join-Path $BackendDir ".env"
    if (-not (Test-Path $dotenv)) { return }

    foreach ($line in Get-Content $dotenv) {
        if ($line -match '^\s*MN_FFMPEG_PATH\s*=\s*(.+)\s*$') {
            $value = $Matches[1].Trim().Trim('"').Trim("'")
            if ($value) {
                $env:MN_FFMPEG_PATH = $value
                Write-Step "  MN_FFMPEG_PATH loaded from backend/.env"
            }
            return
        }
    }
}

function Wait-PortFree {
    for ($i = 0; $i -lt 10; $i++) {
        $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $owners) { return }
        Start-Sleep -Seconds 1
    }
    throw "Port $Port is still in use after stopping processes."
}

function Wait-BackendHealthy {
    Write-Step "Waiting for backend health at $HealthUrl ..."
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) {
                Write-Step "  backend healthy after $($i + 1)s"
                return
            }
        } catch {
            # Still starting.
        }
        Start-Sleep -Seconds 1
    }
    throw "Backend did not become healthy within 30s. Check backend/.env and backend/.venv."
}

if (-not (Test-Path $PythonExe)) {
    throw "Backend venv not found at $PythonExe. Run: cd backend; python -m venv .venv; .venv\Scripts\python -m pip install -r requirements.txt"
}

Write-Step "=== Meeting Notetaker dev restart ==="
Write-Step "Repo:    $RepoRoot"
Write-Step "Backend: $BackendDir"
Write-Step "Port:    $Port"
Write-Step ""

Stop-NotetakerProcesses
Wait-PortFree

Import-BackendDotEnv

Write-Step "Starting backend (uvicorn)..."
$backendProc = Start-Process `
    -WindowStyle Hidden `
    -WorkingDirectory $BackendDir `
    -FilePath $PythonExe `
    -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$Port") `
    -PassThru

Wait-BackendHealthy

$portOwner = (
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -First 1
)
$backendPids = @($backendProc.Id)
$childPids = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $backendProc.Id } |
        Select-Object -ExpandProperty ProcessId
)
$backendPids += $childPids
if ($portOwner -and $portOwner -notin $backendPids) {
    Write-Step "  warning: port $Port owned by PID $portOwner, expected $($backendPids -join ' or ')"
}

Write-Step "Starting Electron dev client..."
if ($NoDevWindow) {
    Start-Process `
        -WindowStyle Hidden `
        -WorkingDirectory $RepoRoot `
        -FilePath "cmd.exe" `
        -ArgumentList @("/c", "npm run dev")
} else {
    Start-Process `
        -WorkingDirectory $RepoRoot `
        -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoExit",
            "-NoProfile",
            "-Command",
            "npm run dev"
        )
}

Write-Step ""
Write-Step "Done."
Write-Step "  Backend:  $HealthUrl"
Write-Step "  API docs: http://127.0.0.1:$Port/docs"
Write-Step "  Renderer: http://localhost:5173/ (via Electron)"
