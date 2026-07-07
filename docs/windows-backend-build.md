# Windows backend bundle build — step-by-step

Run these commands in a **Windows terminal** (PowerShell or Command Prompt)
from the repo root.  The result is ``backend/dist/notetaker-backend/``
containing the frozen backend + bundled ffmpeg.

## Prerequisites

- Windows Python 3.12+ (from python.org or the Microsoft Store)
- Git for Windows (or a checkout of this repo on the Windows filesystem)

## Build steps

```powershell
# 1. Create a Windows-side venv (keep it separate from any WSL .venv)
cd backend
python -m venv .venv-win

# 2. Install runtime + build dependencies
.venv-win\Scripts\python -m pip install -r requirements.txt
.venv-win\Scripts\python -m pip install -r requirements-build.txt

# 3. Create credentials file (from repo root; never committed)
#    Copy backend.env.template to backend.env and fill in the team keys:
#      MN_OPENAI_API_KEY=sk-...
#      MN_PYANNOTE_API_KEY=...
#    Or set MN_ALLOW_STUB_PACKAGE=1 for a stub-only build.
cd ..
copy backend.env.template backend.env
# (edit backend.env with real keys)

# 4. Download ffmpeg (BtbN essentials build, LGPL)
#    URL: https://www.gyan.dev/ffmpeg/builds/ffmpeg-git-essentials.7z
#    Extract bin/ffmpeg.exe -> backend/third_party/ffmpeg/ffmpeg.exe
cd backend
mkdir third_party\ffmpeg
# After extracting the 7z, copy:
#   copy ffmpeg-git-essentials\bin\ffmpeg.exe third_party\ffmpeg\ffmpeg.exe

# 5. Run PyInstaller
.venv-win\Scripts\python -m PyInstaller meeting-notetaker-backend.spec

# 6. Verify the bundle exists
if (Test-Path dist\notetaker-backend\notetaker-backend.exe) {
    Write-Host "Bundle built successfully at dist\notetaker-backend\"
} else {
    Write-Error "Bundle not found!"
}
```

## Smoke test

```powershell
# From repo root:
.\scripts\smoke-backend-bundle.ps1
```

The smoke script:
- Starts ``notetaker-backend.exe`` with a temp data directory
- Creates a meeting, uploads a silent webm
- Waits for the pipeline to finish
- Asserts ffmpeg volumedetect ran (``recorder_audio_missing`` is true/false, not null)
- Kills the process and verifies the port is released

Passes on a machine with **no** Python and **no** ffmpeg on PATH.

## CI secrets

The ``build-backend`` job in ``.github/workflows/release.yml`` writes
``backend.env`` from these GitHub Actions repository secrets:

| Secret name | Description |
|---|---|
| ``MN_OPENAI_API_KEY`` | Spend-capped OpenAI API key for summaries/actions |
| ``MN_PYANNOTE_API_KEY`` | Org pyannoteAI API key for transcription/speaker ID |

If either secret is unset, the corresponding provider runs in stub mode
(no error, but no real transcription/summaries).
