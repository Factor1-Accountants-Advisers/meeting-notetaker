# Demo Installer Design

## Goal

Create a Windows-only installer that the demo team can run without developer setup. After installation, users should be able to:

- open the app
- sign in with their Microsoft account
- access calendar meetings
- record live meeting audio
- upload/process recordings
- review transcripts, summaries, and action items

The installer must avoid any requirement for users to install Python, Node.js, FFmpeg, or backend dependencies manually.

## Background

The current product is already split into three runtime surfaces:

- `desktop/`: Electron shell with tray, device detection, recording control, and Microsoft auth
- `web/`: Next.js frontend exported as static assets for Electron
- `backend/`: FastAPI API with SQLite/local storage defaults and cloud-backed AI processing

Important current-state observations:

- `desktop/electron-builder.yml` already targets Windows `msi`
- `desktop/src/main/auth.ts` already owns Microsoft sign-in via `@azure/msal-node`
- `desktop/src/main/index.ts` expects a backend URL but does not start a backend process
- `backend/app/core/config.py` already defaults to SQLite and local file storage
- `backend/app/services/transcription.py` and `backend/app/services/summarisation.py` still depend on external APIs

This means the right installer problem is not “convert the app into a pure desktop app”. It is “ship the existing architecture in a self-contained Windows package”.

## Scope

### In scope

- Windows-only installer for the demo team
- packaged Electron app
- packaged local FastAPI backend
- private Python runtime bundled with the installer
- local SQLite database and local audio/blob storage
- bundled FFmpeg for backend video-to-audio extraction
- bundled demo configuration and API secrets
- backend process supervision from Electron
- first-run and runtime failure handling suitable for non-technical users

### Out of scope

- offline mode
- removal of Microsoft, AssemblyAI, or OpenAI cloud dependencies
- production-grade secret management
- multi-platform packaging
- background Windows service installation
- auto-update for the first installer release

## User Constraints

The demo team is:

- Windows-only
- non-technical
- expected to use the full current workflow, including live recording

The installer therefore must be a single-click experience with no prerequisite installs.

## Recommendation

Use a packaged local-runtime architecture:

1. Electron remains the primary desktop application.
2. The installer bundles a private Python runtime, backend code, backend dependencies, and FFmpeg.
3. Electron starts a local FastAPI backend process on app launch.
4. The frontend talks only to the local backend on `127.0.0.1`.
5. Cloud services remain external only where the current app already requires them:
   - Microsoft identity and Microsoft Graph
   - AssemblyAI
   - OpenAI

This is the lowest-risk path because it preserves the current code boundaries. It avoids the complexity of:

- hosting an Azure backend just for demos
- asking users to install Python
- rewriting backend logic into Electron
- compiling the backend into a standalone executable too early

## Alternatives Considered

### Option A: Hosted backend + packaged Electron desktop

Pros:

- smallest installer
- simplest local runtime
- no local backend orchestration

Cons:

- requires hosted infrastructure and operations
- adds deployment coordination for demo use
- conflicts with the goal of avoiding backend overhead

### Option B: Packaged Electron + local FastAPI + private Python runtime

Pros:

- matches the current codebase
- avoids hosted backend operations
- preserves all existing features
- lowest implementation risk

Cons:

- larger installer
- bundled demo secrets are acceptable only for limited demo use
- local process supervision must be added

### Option C: Packaged Electron + compiled backend executable

Pros:

- simpler-looking runtime on the user machine
- no visible Python runtime folder

Cons:

- higher packaging and debugging risk
- more likely to fail due to native dependencies and dynamic imports
- unnecessary for the first demo installer

### Recommended option

Choose Option B.

## Runtime Architecture

The installed application is one product with two local processes:

- Electron process
- local FastAPI backend process

### Responsibilities

Electron owns:

- app shell and windows
- Microsoft sign-in
- Microsoft Graph calendar access
- tray integration
- recording control
- backend lifecycle management

Backend owns:

- API routes
- SQLite persistence
- local audio/blob storage
- upload handling
- transcription pipeline orchestration
- diarisation and summarisation persistence

### Startup sequence

1. User launches the installed app.
2. Electron shows a lightweight loading shell.
3. Electron starts the backend child process on a fixed localhost port.
4. Electron polls `/health` until the backend is ready.
5. Electron loads the packaged web UI.
6. The frontend uses the local backend for all `/api/*` requests.

### Shutdown sequence

1. Electron closes the main UI.
2. Electron stops the backend child process gracefully.
3. Logs and user data remain on disk.

## Windows File Layout

Use the install directory only for immutable application assets. Keep all writable state in the user profile.

### Install directory

Recommended under:

- `C:\Program Files\Meeting Note-Taker\`

Contents:

- Electron app binaries
- packaged `web-out`
- private Python runtime
- backend source
- vendored Python dependencies
- bundled FFmpeg
- default demo config template

### User-writable runtime area

Recommended under:

- `%LOCALAPPDATA%\Meeting Note-Taker\`

Contents:

- `config\backend.env`
- `data\meetings.db`
- `data\audio\...`
- `logs\electron.log`
- `logs\backend.log`
- optional temp/runtime directories

This layout avoids Windows permission problems with SQLite, uploads, logs, and temp files.

## Packaging Model

### Installer target

Keep the first release on Windows `msi`.

Reason:

- it matches the current repo
- it is acceptable for the demo team
- it avoids broad packaging churn during the first installer pass

### Important compatibility note

The current repo uses `electron-updater` in `desktop/src/main/index.ts`, but official `electron-builder` guidance lists Windows auto-updatable targets as `NSIS`, not `MSI`.

Implication:

- keep `msi` for the demo installer
- disable or bypass auto-update behavior in the demo build
- revisit `NSIS` only when auto-updates become a real requirement

### Packaged assets

The Electron build should include:

- `desktop/dist/**/*`
- `web-out/**/*`
- Python embedded/runtime files
- backend application files
- backend site-packages/vendor dependencies
- `ffmpeg.exe`
- default demo config asset

`electron-builder` should carry these through `extraResources` or equivalent resource inclusion, rather than assuming they can run from source paths.

## Configuration And Secrets

### Auth model

Keep the current auth split:

- Electron performs Microsoft sign-in using `@azure/msal-node`
- the web layer gets tokens through the Electron bridge
- the backend validates Azure AD ID tokens locally

This is already aligned with the current codebase and does not need a redesign.

### Demo configuration model

For the demo installer:

1. Ship a default config template inside app resources.
2. On first launch, copy it to:
   - `%LOCALAPPDATA%\Meeting Note-Taker\config\backend.env`
3. Start the backend with that env file.

Config values should include:

- `AZURE_AD_TENANT_ID`
- `AZURE_AD_CLIENT_ID`
- `AZURE_AD_CLIENT_SECRET`
- `OPENAI_API_KEY`
- `ASSEMBLYAI_API_KEY`
- `ENVIRONMENT`
- explicit local `DATABASE_URL`
- explicit local storage path
- fixed localhost port, recommended as `38741`

### Secret handling

For this demo-only scope, bundled shared secrets are acceptable.

The preferred demo implementation is:

- ship an encrypted config asset in the installer
- decrypt/copy it into `%LOCALAPPDATA%` on first run using Windows-local protection where practical

If that adds too much friction, a plain demo env file is still acceptable for the first pass because the audience is internal and temporary.

## Backend Runtime Strategy

Do not compile the backend into an executable for the first release.

Instead:

- bundle a private Python runtime
- bundle the backend code directly
- bundle installed dependencies alongside that runtime
- launch the backend from Electron with a direct process spawn

Recommended launch pattern:

- Electron uses Node `spawn()` with an explicit executable path
- backend runs `uvicorn app.main:app --host 127.0.0.1 --port 38741`

Reasons:

- lower packaging risk than PyInstaller/Nuitka
- easier debugging when demo issues appear
- fewer surprises with `cryptography`, database drivers, and API SDKs

## FFmpeg Strategy

Two FFmpeg paths exist in the current app:

- desktop recording uses Electron-side FFmpeg packages
- backend video extraction currently assumes `ffmpeg` is on the system path

For the installer:

- bundle `ffmpeg.exe`
- update backend video extraction to use the bundled executable path instead of relying on global PATH

This is required for the “single installer, no prerequisites” promise.

## Failure Handling

The packaged app must behave like a managed local appliance.

### Startup failure UX

If the backend fails to start:

- keep the user on a startup shell
- show a short plain-language error
- provide:
  - `Retry`
  - `Copy diagnostics`
  - log file location

### Runtime failure UX

If the backend crashes after startup:

- show a blocking reconnect/restart state
- attempt one controlled restart
- surface diagnostics rather than failing silently in the UI

### Logging

Write logs to:

- `%LOCALAPPDATA%\Meeting Note-Taker\logs\electron.log`
- `%LOCALAPPDATA%\Meeting Note-Taker\logs\backend.log`

Keep logging simple and support-oriented for the first version.

## Build And Verification

The installer is not complete until it passes a fresh-machine verification flow.

### Required verification flow

On a clean Windows VM or fresh user profile:

1. Install MSI.
2. Launch app.
3. Confirm backend starts successfully.
4. Sign in with Microsoft.
5. Load calendar meetings.
6. Configure microphone and system audio.
7. Start live recording.
8. Stop recording and upload successfully.
9. Confirm meeting appears in local DB-backed UI.
10. Confirm transcription and summarisation complete.
11. Confirm data and logs are created in `%LOCALAPPDATA%`.

### Minimum success criteria

The installer is successful when a non-technical internal demo user can:

- install without prerequisites
- sign in without developer help
- record a meeting
- process it end-to-end
- open the results in the app

## Implementation Notes For Compatibility With The Current Codebase

The codebase already supports the core direction:

- static web export inside Electron
- Electron-owned auth
- Electron-owned calendar access
- local database and local file storage defaults

The required additions are focused and compatible:

- backend process manager in Electron
- packaged runtime asset layout
- explicit local runtime paths
- bundled config bootstrap
- bundled FFmpeg path wiring for backend extraction
- demo-build update behavior adjustment for MSI

The current dirty auth-related files should not be reverted blindly. Because they touch the same surface area as this installer work, they should be treated as user-owned changes and either incorporated or worked around after comparison.

## Risks

### Primary risks

- packaging Python dependencies cleanly on Windows
- ensuring bundled FFmpeg is used everywhere it is needed
- avoiding port conflicts for the local backend
- handling first-run startup failures clearly enough for non-technical users

### Secondary risks

- demo secrets are extractable from the installed app or user profile
- future auto-update work will likely require moving from `msi` to `nsis`
- cloud-service outages still affect the app even though the backend is local

## Out-Of-Scope Follow-Ups

These are reasonable later improvements, but should not block the first demo installer:

- switching Windows packaging to `NSIS` for updater support
- stronger secret protection and rotation
- compiling the backend into an exe
- Windows service mode
- offline transcription/summarisation
- macOS support

## External References

These references support the recommended packaging approach:

- Electron Builder configuration and resource packaging:
  - https://www.electron.build/configuration.html
- Electron Builder auto-update target support:
  - https://www.electron.build/auto-update.html
- Python on Windows embedded distribution:
  - https://docs.python.org/3/using/windows.html#the-embeddable-package
- Node.js child process management:
  - https://nodejs.org/api/child_process.html
