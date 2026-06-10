# Meeting Notetaker — Claude Code Guide

**Read `AGENTS.md` first** — it is the canonical agent guide (project rules,
architecture, commands, layout, current state). This file only adds notes
specific to working in Claude Code on this machine.

## Claude-specific notes

### MSIX path virtualization (important)

Processes launched from Claude's shell run inside the Claude desktop MSIX
sandbox: **AppData writes are silently redirected** to
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\...` and are invisible in the
user's Explorer — while Claude's own shells read through the redirect and see
the virtual path as real. Repo paths under `C:\GitHub` are NOT redirected.

- Dev recordings therefore save to `<repo>/recordings` (gitignored), not
  userData — keep it that way (`src/main/index.ts`, `is.dev` branch).
- If the user reports "the file isn't there" while your shell sees it,
  check the LocalCache redirect before doubting them.

### electron-vite dev loop

`npm run dev` hot-reloads the renderer only. After editing `src/main` or
`src/preload`, kill the dev process and rerun it — otherwise the running app
keeps the old main/preload and you'll chase ghosts.

### Verifying UI without Electron

`.claude/launch.json` has `renderer-static`: serves the built renderer
(`out/renderer`) on port 4173 for the preview tools. In that context
`window.api` is undefined, so every screen falls back to sample data with a
"sample data" notice — useful for layout/flow checks, useless for IPC paths.
`preview_screenshot` times out in this environment; use `preview_eval` DOM
checks instead.

### Backend process management

Start uvicorn detached so it survives tool-call teardown:
`Start-Process -WindowStyle Hidden -WorkingDirectory <repo>\backend
<repo>\backend\.venv\Scripts\python.exe -ArgumentList '-m','uvicorn','app.main:app','--port','8787'`

Reset demo state: stop uvicorn, delete `backend/var/store.json`, restart.

### Packaging on this machine

`winCodeSign` extraction needs Windows symlink privilege (Developer Mode not
enabled here) — `signAndEditExecutable: false` is set in
`electron-builder.yml` for local builds; CI re-enables it.
