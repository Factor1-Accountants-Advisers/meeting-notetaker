# Demo Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-only demo installer that packages the Electron app, a local FastAPI backend, a private Python runtime, and bundled FFmpeg so demo users can install once, sign in with Microsoft, and use the full current workflow without installing prerequisites.

**Architecture:** Keep the existing split between Electron, static web UI, and FastAPI. Add a small Electron-side runtime manager that bootstraps writable directories, copies a bundled backend env file, starts the local backend on `127.0.0.1:38741`, and exposes that URL consistently to the tray, protocol proxy, uploader, and settings UI. Package Python, backend files, config assets, and FFmpeg through `electron-builder`, and make the backend resolve runtime paths from environment instead of assuming source-tree defaults.

**Tech Stack:** Electron 29, TypeScript, `electron-builder` MSI, Node `child_process.spawn`, FastAPI, Pydantic settings, SQLite, local filesystem storage, Jest, pytest

---

## File Structure

### Desktop runtime and packaging

- Create: `desktop/src/main/runtime-paths.ts`
  - Centralize install-resource paths, `%LOCALAPPDATA%` runtime directories, backend port, and demo-mode flags.
- Create: `desktop/src/main/backend-runtime.ts`
  - Manage backend env bootstrap, process spawn, health polling, graceful shutdown, and log paths.
- Modify: `desktop/src/main/index.ts`
  - Replace static `BACKEND_URL` assumptions with runtime startup orchestration and disable auto-update for packaged MSI demo builds.
- Modify: `desktop/src/main/ipc.ts`
  - Use the resolved backend URL from the runtime manager instead of `process.env.BACKEND_URL`.
- Modify: `desktop/src/main/tray.ts`
  - Use the resolved backend URL provided at runtime.
- Modify: `desktop/electron-builder.yml`
  - Add bundled runtime assets through `extraResources` and keep Windows target on `msi`.
- Modify: `desktop/package.json`
  - Add packaging/staging scripts for backend runtime assets.
- Create: `desktop/scripts/stage-runtime.mjs`
  - Assemble the backend bundle, FFmpeg, and demo config into a predictable `build-resources/runtime` directory before `electron-builder`.
- Create: `desktop/resources/demo/backend.env`
  - Template/default demo backend configuration copied to `%LOCALAPPDATA%` on first launch.
- Create: `desktop/tests/backend-runtime.test.ts`
  - Cover env bootstrap, backend spawn args, health polling, and shutdown behavior.
- Create: `desktop/tests/index.test.ts`
  - Assert packaged startup skips `electron-updater` and still boots the local backend runtime path.
- Modify: `desktop/tests/ipc-devices.test.ts`
  - Assert uploader IPC uses the runtime backend URL accessor.
- Modify: `desktop/tests/tray.test.ts`
  - Assert tray uploads use the provided runtime backend URL.

### Backend runtime configuration

- Modify: `backend/app/core/config.py`
  - Add explicit runtime-path and FFmpeg configuration settings for packaged execution.
- Modify: `backend/app/services/audio.py`
  - Resolve FFmpeg from `settings.ffmpeg_path` before falling back to PATH.
- Create: `backend/tests/test_runtime_config.py`
  - Verify packaged env values are honored and local directories can be configured.
- Create: `backend/tests/test_audio_runtime.py`
  - Verify `extract_audio_from_video()` uses configured FFmpeg path and raises a supportable error when missing.

### Verification docs

- Create: `docs/demo-installer-smoke-test.md`
  - Fresh-machine verification checklist for MSI install, first launch, sign-in, recording, upload, and processing.

## Task 1: Add packaged-backend runtime settings in FastAPI

**Files:**
- Modify: `backend/app/core/config.py`
- Test: `backend/tests/test_runtime_config.py`

- [ ] **Step 1: Write the failing backend config tests**

```python
from importlib import reload

import app.core.config as config_module


def test_settings_accept_packaged_runtime_paths(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///C:/Users/demo/AppData/Local/Meeting Note-Taker/data/meetings.db")
    monkeypatch.setenv("LOCAL_STORAGE_DIR", "C:/Users/demo/AppData/Local/Meeting Note-Taker/data/audio")
    monkeypatch.setenv("FFMPEG_PATH", "C:/Program Files/Meeting Note-Taker/resources/runtime/ffmpeg/ffmpeg.exe")
    monkeypatch.setenv("BACKEND_HOST", "127.0.0.1")
    monkeypatch.setenv("BACKEND_PORT", "38741")

    reload(config_module)
    settings = config_module.Settings()

    assert settings.database_url.endswith("meetings.db")
    assert settings.local_storage_dir.endswith("data/audio")
    assert settings.ffmpeg_path.endswith("ffmpeg.exe")
    assert settings.backend_host == "127.0.0.1"
    assert settings.backend_port == 38741
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend; .\.venv\Scripts\Activate.ps1; pytest tests/test_runtime_config.py -v`

Expected: FAIL with `AttributeError` or validation failure because `ffmpeg_path`, `backend_host`, and `backend_port` do not exist on `Settings`.

- [ ] **Step 3: Add the minimal packaged-runtime settings**

```python
"""Application configuration using Pydantic Settings."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Environment
    environment: str = "development"

    # Local packaged backend listener
    backend_host: str = "127.0.0.1"
    backend_port: int = 38741

    # Azure AD
    azure_ad_tenant_id: str = ""
    azure_ad_client_id: str = ""
    azure_ad_client_secret: str = ""

    # Azure Blob Storage
    azure_storage_connection_string: str = ""
    azure_storage_container_name: str = "meeting-audio"

    # Database (SQLite default for dev, PostgreSQL for production)
    database_url: str = "sqlite+aiosqlite:///./data/meetings.db"

    # Storage backend: "local" (default), "minio", or auto-detect Azure
    storage_backend: str = "local"
    local_storage_dir: str = ""

    # Packaged runtime helpers
    ffmpeg_path: str = ""

    # MinIO (only needed if storage_backend=minio)
    minio_endpoint: str = "http://localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"

    # OpenAI
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"

    # AssemblyAI (transcription + diarisation)
    assemblyai_api_key: str = ""

    # HuggingFace (legacy, kept for reference)
    hf_token: str = ""

    # Whisper (legacy, kept for reference)
    whisper_model: str = "medium"

    # Dev auth bypass
    use_dev_auth_bypass: bool = False

    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend; .\.venv\Scripts\Activate.ps1; pytest tests/test_runtime_config.py -v`

Expected: PASS with `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/core/config.py backend/tests/test_runtime_config.py
git commit -m "feat: add packaged backend runtime settings"
```

## Task 2: Make backend audio extraction use bundled FFmpeg

**Files:**
- Modify: `backend/app/services/audio.py`
- Test: `backend/tests/test_audio_runtime.py`

- [ ] **Step 1: Write the failing FFmpeg path tests**

```python
from unittest.mock import Mock

import pytest

from app.services.audio import extract_audio_from_video


def test_extract_audio_uses_configured_ffmpeg_path(monkeypatch, tmp_path):
    input_path = tmp_path / "meeting.mp4"
    input_path.write_bytes(b"video")

    run_mock = Mock(return_value=Mock(returncode=0, stderr="", stdout=""))
    monkeypatch.setattr("app.services.audio.settings.ffmpeg_path", "C:/demo/runtime/ffmpeg.exe")
    monkeypatch.setattr("app.services.audio.subprocess.run", run_mock)

    extract_audio_from_video(str(input_path))

    assert run_mock.call_args[0][0][0] == "C:/demo/runtime/ffmpeg.exe"


def test_extract_audio_reports_missing_bundled_ffmpeg(monkeypatch, tmp_path):
    input_path = tmp_path / "meeting.mp4"
    input_path.write_bytes(b"video")

    monkeypatch.setattr("app.services.audio.settings.ffmpeg_path", "C:/demo/runtime/ffmpeg.exe")

    def raise_missing(*args, **kwargs):
        raise FileNotFoundError

    monkeypatch.setattr("app.services.audio.subprocess.run", raise_missing)

    with pytest.raises(RuntimeError, match="Bundled FFmpeg not found"):
        extract_audio_from_video(str(input_path))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend; .\.venv\Scripts\Activate.ps1; pytest tests/test_audio_runtime.py -v`

Expected: FAIL because `extract_audio_from_video()` always shells out to `"ffmpeg"` and raises the old generic install message.

- [ ] **Step 3: Write the minimal implementation**

```python
"""Audio extraction utility for video files."""
import logging
import os
import subprocess
import tempfile
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger(__name__)


def _resolve_ffmpeg_binary() -> str:
    return settings.ffmpeg_path or "ffmpeg"


def extract_audio_from_video(input_path: str) -> str:
    output_path = os.path.join(
        tempfile.gettempdir(),
        f"{Path(input_path).stem}_extracted.wav"
    )

    cmd = [
        _resolve_ffmpeg_binary(), "-y",
        "-i", input_path,
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        output_path,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
        )
        if result.returncode != 0:
            logger.error(f"FFmpeg failed: {result.stderr}")
            raise RuntimeError(f"Audio extraction failed: {result.stderr[:200]}")

        logger.info(f"Extracted audio: {input_path} -> {output_path}")
        return output_path

    except subprocess.TimeoutExpired:
        raise RuntimeError("Audio extraction timed out (>5 minutes)")
    except FileNotFoundError:
        if settings.ffmpeg_path:
            raise RuntimeError("Bundled FFmpeg not found — reinstall the app or contact support")
        raise RuntimeError("FFmpeg not found — install FFmpeg to process video files")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend; .\.venv\Scripts\Activate.ps1; pytest tests/test_audio_runtime.py -v`

Expected: PASS with `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/audio.py backend/tests/test_audio_runtime.py
git commit -m "feat: use bundled ffmpeg for backend extraction"
```

## Task 3: Add Electron runtime path helpers and backend process manager

**Files:**
- Create: `desktop/src/main/runtime-paths.ts`
- Create: `desktop/src/main/backend-runtime.ts`
- Test: `desktop/tests/backend-runtime.test.ts`

- [ ] **Step 1: Write the failing backend runtime tests**

```typescript
jest.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: jest.fn((name: string) => {
      if (name === 'userData') return 'C:/Users/demo/AppData/Roaming/Meeting Note-Taker';
      if (name === 'temp') return 'C:/Users/demo/AppData/Local/Temp';
      return 'C:/tmp';
    }),
    getAppPath: jest.fn(() => 'C:/Program Files/Meeting Note-Taker/resources/app.asar'),
  },
}));

jest.mock('node:child_process', () => ({
  spawn: jest.fn(() => ({
    pid: 123,
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    once: jest.fn(),
    kill: jest.fn(),
  })),
}));

describe('backend runtime', () => {
  it('copies the bundled backend env on first launch and starts uvicorn on localhost', async () => {
    const fs = require('node:fs');
    jest.spyOn(fs, 'existsSync').mockImplementation((value: string) =>
      value.includes('backend.env') ? false : true
    );
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    jest.spyOn(fs, 'copyFileSync').mockImplementation(() => undefined);

    const runtime = require('../src/main/backend-runtime');
    await runtime.ensureBackendRunning();

    const { spawn } = require('node:child_process');
    expect(spawn).toHaveBeenCalledWith(
      expect.stringContaining('python'),
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '38741'],
      expect.objectContaining({
        cwd: expect.stringContaining('backend'),
        env: expect.objectContaining({
          BACKEND_HOST: '127.0.0.1',
          BACKEND_PORT: '38741',
        }),
      })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop; npm test -- backend-runtime.test.ts`

Expected: FAIL because neither `runtime-paths.ts` nor `backend-runtime.ts` exists.

- [ ] **Step 3: Add the minimal runtime path and backend manager implementation**

```typescript
// desktop/src/main/runtime-paths.ts
import { app } from 'electron';
import * as path from 'path';

export const BACKEND_PORT = 38741;
export const BACKEND_HOST = '127.0.0.1';

export function getBackendUrl(): string {
  return `http://${BACKEND_HOST}:${BACKEND_PORT}`;
}

export function getUserRuntimeRoot(): string {
  return path.join(app.getPath('userData'), 'demo-runtime');
}

export function getUserConfigDir(): string {
  return path.join(getUserRuntimeRoot(), 'config');
}

export function getUserDataDir(): string {
  return path.join(getUserRuntimeRoot(), 'data');
}

export function getUserLogsDir(): string {
  return path.join(getUserRuntimeRoot(), 'logs');
}

export function getBundledRuntimeDir(): string {
  const base = app.isPackaged
    ? process.resourcesPath
    : path.join(process.cwd(), 'build-resources', 'runtime');
  return path.join(base, 'runtime');
}

export function getBundledBackendDir(): string {
  return path.join(getBundledRuntimeDir(), 'backend');
}

export function getBundledPythonExe(): string {
  return path.join(getBundledRuntimeDir(), 'python', 'python.exe');
}

export function getBundledBackendEnvTemplate(): string {
  return path.join(getBundledRuntimeDir(), 'config', 'backend.env');
}

export function getBundledFfmpegExe(): string {
  return path.join(getBundledRuntimeDir(), 'ffmpeg', 'ffmpeg.exe');
}

export function getUserBackendEnvPath(): string {
  return path.join(getUserConfigDir(), 'backend.env');
}
```

```typescript
// desktop/src/main/backend-runtime.ts
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BACKEND_HOST,
  BACKEND_PORT,
  getBackendUrl,
  getBundledBackendDir,
  getBundledBackendEnvTemplate,
  getBundledFfmpegExe,
  getBundledPythonExe,
  getUserBackendEnvPath,
  getUserConfigDir,
  getUserDataDir,
  getUserLogsDir,
} from './runtime-paths';

let backendProcess: ChildProcess | null = null;

function ensureRuntimeDirectories(): void {
  for (const dir of [getUserConfigDir(), getUserDataDir(), getUserLogsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureBackendEnvFile(): string {
  ensureRuntimeDirectories();
  const userEnv = getUserBackendEnvPath();
  if (!fs.existsSync(userEnv)) {
    fs.copyFileSync(getBundledBackendEnvTemplate(), userEnv);
  }
  return userEnv;
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Local backend failed to start');
}

export async function ensureBackendRunning(): Promise<string> {
  if (backendProcess && backendProcess.exitCode == null) {
    return getBackendUrl();
  }

  const userEnvPath = ensureBackendEnvFile();
  const backendLogPath = path.join(getUserLogsDir(), 'backend.log');
  const backendLogFd = fs.openSync(backendLogPath, 'a');

  backendProcess = spawn(
    getBundledPythonExe(),
    ['-m', 'uvicorn', 'app.main:app', '--host', BACKEND_HOST, '--port', String(BACKEND_PORT)],
    {
      cwd: getBundledBackendDir(),
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: userEnvPath,
        DATABASE_URL: `sqlite+aiosqlite:///${path.join(getUserDataDir(), 'meetings.db').replace(/\\/g, '/')}`,
        LOCAL_STORAGE_DIR: path.join(getUserDataDir(), 'audio'),
        FFMPEG_PATH: getBundledFfmpegExe(),
        BACKEND_HOST,
        BACKEND_PORT: String(BACKEND_PORT),
      },
      stdio: ['ignore', backendLogFd, backendLogFd],
      windowsHide: true,
    }
  );

  await waitForHealth(getBackendUrl());
  return getBackendUrl();
}

export function stopBackend(): void {
  if (backendProcess && backendProcess.exitCode == null) {
    backendProcess.kill();
  }
  backendProcess = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop; npm test -- backend-runtime.test.ts`

Expected: PASS with `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/runtime-paths.ts desktop/src/main/backend-runtime.ts desktop/tests/backend-runtime.test.ts
git commit -m "feat: add packaged backend runtime manager"
```

## Task 4: Wire Electron startup, IPC, and tray flows to the runtime backend URL

**Files:**
- Modify: `desktop/src/main/index.ts`
- Modify: `desktop/src/main/ipc.ts`
- Modify: `desktop/src/main/tray.ts`
- Modify: `desktop/tests/ipc-devices.test.ts`
- Modify: `desktop/tests/tray.test.ts`

- [ ] **Step 1: Write the failing integration-oriented desktop tests**

```typescript
it('returns the runtime backend URL through app:get-backend-url', async () => {
  jest.doMock('../src/main/runtime-paths', () => ({
    getBackendUrl: () => 'http://127.0.0.1:38741',
  }));

  require('../src/main/ipc').registerIpcHandlers();
  const handleCalls = (ipcMain.handle as jest.Mock).mock.calls;
  const urlHandler = handleCalls.find((c: [string, Function]) => c[0] === 'app:get-backend-url')?.[1];

  expect(urlHandler()).toBe('http://127.0.0.1:38741');
});

it('uploads tray recordings to the runtime backend URL', async () => {
  createTray({
    backendUrl: 'http://127.0.0.1:38741',
    recordingOutputDir: 'C:/tmp',
    micName: 'Mic',
    loopbackName: 'Loop',
    onOpenApp: jest.fn(),
  });

  // existing stop/upload assertions remain the same except the URL expectation
  expect(uploadRecording).toHaveBeenCalledWith(
    expect.objectContaining({ backendUrl: 'http://127.0.0.1:38741' })
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd desktop; npm test -- ipc-devices.test.ts tray.test.ts`

Expected: FAIL because `app:get-backend-url`, uploader IPC, and tray flows still use `process.env.BACKEND_URL ?? 'http://localhost:8000'`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// desktop/src/main/ipc.ts
import { getBackendUrl } from './runtime-paths';

ipcMain.handle(
  'uploader:upload',
  async (_e, args: { filePath: string; metadata: MeetingMetadata }): Promise<UploadResult> => {
    const token = await acquireIdToken();
    return uploadRecording({
      filePath: args.filePath,
      accessToken: token,
      backendUrl: getBackendUrl(),
      metadata: args.metadata,
    });
  }
);

ipcMain.handle('app:get-backend-url', (): string => getBackendUrl());
```

```typescript
// desktop/src/main/index.ts
import { ensureBackendRunning, stopBackend } from './backend-runtime';
import { getBackendUrl } from './runtime-paths';

app.whenReady().then(async () => {
  const backendUrl = await ensureBackendRunning();

  registerIpcHandlers();

  if (app.isPackaged || !process.env.WEB_DEV_URL) {
    const staticDir = path.join(__dirname, '../../web-out');
    registerAppProtocol(staticDir, backendUrl);
  }

  createTray({
    backendUrl,
    recordingOutputDir: app.getPath('temp'),
    micName: process.env.MIC_DEVICE_NAME ?? '',
    loopbackName: process.env.LOOPBACK_DEVICE_NAME ?? '',
    onOpenApp: showMainWindow,
  });

  mainWindow = createMainWindow();

  startScheduler();

  if (!app.isPackaged) {
    void autoUpdater.checkForUpdatesAndNotify();
  }
});

app.on('will-quit', () => {
  stopScheduler();
  stopBackend();
});
```

```typescript
// desktop/src/main/tray.ts
let _backendUrl = 'http://127.0.0.1:38741';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd desktop; npm test -- ipc-devices.test.ts tray.test.ts`

Expected: PASS with existing device tests still green and URL assertions updated to `127.0.0.1:38741`.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/index.ts desktop/src/main/ipc.ts desktop/src/main/tray.ts desktop/tests/ipc-devices.test.ts desktop/tests/tray.test.ts
git commit -m "feat: route desktop flows through local backend runtime"
```

## Task 5: Package backend runtime assets into the MSI build

**Files:**
- Modify: `desktop/package.json`
- Modify: `desktop/electron-builder.yml`
- Create: `desktop/scripts/stage-runtime.mjs`
- Create: `desktop/resources/demo/backend.env`

- [ ] **Step 1: Write the failing packaging smoke step**

```powershell
cd C:\Projects\meeting-notetaker\desktop
npm run stage:runtime
Test-Path .\build-resources\runtime\backend
Test-Path .\build-resources\runtime\config\backend.env
Test-Path .\build-resources\runtime\ffmpeg\ffmpeg.exe
```

Expected: FAIL because `stage:runtime` does not exist and no staged runtime directory is produced.

- [ ] **Step 2: Add the staging script and package hooks**

```json
{
  "scripts": {
    "build:web": "cd ../web && npx next build && cd ../desktop && node -e \"require('fs').cpSync('../web/out', 'web-out', { recursive: true })\"",
    "build:electron": "tsc -p tsconfig.main.json && tsc -p tsconfig.renderer.json && node -e \"require('fs').cpSync('src/renderer/meeting-selector/index.html','dist/renderer/meeting-selector/index.html')\"",
    "stage:runtime": "node ./scripts/stage-runtime.mjs",
    "build": "npm run build:web && npm run build:electron && npm run stage:runtime",
    "pack": "npm run build && electron-builder --dir",
    "dist": "npm run build && electron-builder",
    "dist:win": "npm run build && electron-builder --win"
  }
}
```

```yaml
appId: com.yourfirm.meetingnotetaker
productName: Meeting Note-Taker
directories:
  output: release
files:
  - dist/**/*
  - web-out/**/*
  - assets/**/*
  - node_modules/**/*
  - package.json
extraResources:
  - from: build-resources/runtime
    to: runtime
win:
  target:
    - target: msi
      arch: [x64]
  icon: assets/icon-idle.png
msi:
  oneClick: false
  perMachine: true
```

```javascript
// desktop/scripts/stage-runtime.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'build-resources', 'runtime');
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'backend'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'config'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'ffmpeg'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'python'), { recursive: true });

copy(path.join(root, '..', 'backend', 'app'), path.join(outDir, 'backend', 'app'));
copy(path.join(root, '..', 'backend', 'alembic'), path.join(outDir, 'backend', 'alembic'));
copy(path.join(root, '..', 'backend', 'alembic.ini'), path.join(outDir, 'backend', 'alembic.ini'));
copy(path.join(root, 'resources', 'demo', 'backend.env'), path.join(outDir, 'config', 'backend.env'));

const ffmpegSource = path.join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
copy(ffmpegSource, path.join(outDir, 'ffmpeg', 'ffmpeg.exe'));

copy(path.join(root, 'vendor', 'python-runtime'), path.join(outDir, 'python'));
```

```env
ENVIRONMENT=production
BACKEND_HOST=127.0.0.1
BACKEND_PORT=38741
AZURE_AD_TENANT_ID=
AZURE_AD_CLIENT_ID=
AZURE_AD_CLIENT_SECRET=
OPENAI_API_KEY=
ASSEMBLYAI_API_KEY=
USE_DEV_AUTH_BYPASS=false
```

- [ ] **Step 3: Run the packaging smoke step to verify it passes**

Run:

```powershell
cd C:\Projects\meeting-notetaker\desktop
npm run stage:runtime
Test-Path .\build-resources\runtime\backend
Test-Path .\build-resources\runtime\config\backend.env
Test-Path .\build-resources\runtime\ffmpeg\ffmpeg.exe
```

Expected:

- `npm run stage:runtime` exits `0`
- each `Test-Path` prints `True`

- [ ] **Step 4: Commit**

```bash
git add desktop/package.json desktop/electron-builder.yml desktop/scripts/stage-runtime.mjs desktop/resources/demo/backend.env
git commit -m "build: stage packaged backend runtime assets"
```

## Task 6: Disable packaged auto-update assumptions and document verification

**Files:**
- Modify: `desktop/src/main/index.ts`
- Create: `desktop/tests/index.test.ts`
- Create: `docs/demo-installer-smoke-test.md`

- [ ] **Step 1: Write the failing documentation/behavior checks**

```typescript
it('does not run autoUpdater in packaged demo mode', async () => {
  const { autoUpdater } = require('electron-updater');
  const electron = require('electron');
  electron.app.isPackaged = true;

  require('../src/main/index');

  expect(autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
});
```

```markdown
# Demo Installer Smoke Test

1. Install the MSI on a clean Windows user profile.
2. Launch Meeting Note-Taker.
3. Confirm the backend starts and the login page loads.
4. Sign in with a demo Microsoft account.
5. Open Settings and verify audio devices populate.
6. Record a short meeting.
7. Stop recording and confirm upload succeeds.
8. Verify transcript, summary, and action items appear.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop; npm test -- index.test.ts`

Expected: FAIL because packaged startup still calls `autoUpdater.checkForUpdatesAndNotify()`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// desktop/src/main/index.ts
const isDemoInstallerBuild = app.isPackaged;

if (!isDemoInstallerBuild) {
  void autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => void autoUpdater.checkForUpdatesAndNotify(), 4 * 3600000);
}
```

```markdown
# Demo Installer Smoke Test

## Clean machine verification

1. Install the MSI.
2. Launch the app and wait for the loading shell to finish.
3. Confirm `%LOCALAPPDATA%\Meeting Note-Taker\demo-runtime\config\backend.env` exists.
4. Confirm `%LOCALAPPDATA%\Meeting Note-Taker\demo-runtime\logs\backend.log` exists.
5. Sign in with Microsoft.
6. Open Settings and confirm the backend URL is `http://127.0.0.1:38741`.
7. Configure microphone and system audio.
8. Start and stop a live recording.
9. Confirm the upload completes and the meeting appears.
10. Wait for transcription and summarisation to complete.
11. Confirm transcript, summary, and action items render.
```

- [ ] **Step 4: Run checks to verify they pass**

Run:

```powershell
cd C:\Projects\meeting-notetaker\desktop
npm test -- index.test.ts
```

Expected: PASS with the packaged updater assertion green.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main/index.ts docs/demo-installer-smoke-test.md
git commit -m "docs: add demo installer smoke test and disable packaged auto updates"
```

## Task 7: Full integration verification

**Files:**
- Modify: `docs/demo-installer-smoke-test.md`

- [ ] **Step 1: Build the desktop package locally**

Run:

```powershell
cd C:\Projects\meeting-notetaker\desktop
npm install
npm run dist:win
```

Expected:

- TypeScript build completes
- `stage:runtime` completes
- `electron-builder` emits an MSI under `desktop\release\`

- [ ] **Step 2: Install and verify on a clean user profile**

Run:

```powershell
Start-Process .\release\Meeting*Setup*.msi
```

Expected:

- installer completes without asking for Python or FFmpeg
- app launches
- backend log file is created

- [ ] **Step 3: Execute the smoke test checklist**

Run through `docs/demo-installer-smoke-test.md` exactly.

Expected:

- full sign-in, calendar, recording, upload, transcription, and summarisation flow succeeds

- [ ] **Step 4: Capture any gaps and patch minimally**

If a smoke-test step fails, record the exact failing step, exact error text, and the relevant log path in `docs/demo-installer-smoke-test.md`, then rerun the smoke test after the targeted fix lands in the corresponding implementation task branch.

```bash
git add docs/demo-installer-smoke-test.md
git commit -m "docs: record demo installer verification findings"
```

- [ ] **Step 5: Final validation**

Run:

```powershell
cd C:\Projects\meeting-notetaker\desktop
npm test
cd ..\backend
.\.venv\Scripts\Activate.ps1
pytest
```

Expected:

- desktop Jest suite passes
- backend pytest suite passes

## Self-Review

### Spec coverage

- Local backend packaging: covered by Tasks 1, 3, and 5.
- Runtime startup and shutdown orchestration: covered by Tasks 3 and 4.
- Bundled config and secrets bootstrap: covered by Tasks 3 and 5.
- Bundled FFmpeg for backend extraction: covered by Task 2 and staged in Task 5.
- MSI-compatible packaging path with updater disabled: covered by Tasks 4, 5, and 6.
- Fresh-machine verification: covered by Tasks 6 and 7.

No spec sections are currently uncovered.

### Placeholder scan

No `TBD`, `TODO`, or implementation placeholders remain in the plan. The private Python runtime path is concrete: `desktop/vendor/python-runtime`.

### Type consistency

- Backend host/port constants are consistently `127.0.0.1` and `38741`.
- Backend URL is consistently `http://127.0.0.1:38741`.
- Runtime env keys are consistently `BACKEND_HOST`, `BACKEND_PORT`, `DATABASE_URL`, `LOCAL_STORAGE_DIR`, and `FFMPEG_PATH`.
