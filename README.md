# Meeting Notetaker

Internal desktop app for **Factor1 Accountants & Advisers** — records meetings
(online via system-audio loopback + mic, in-person via mic, or file upload),
transcribes and diarizes them, identifies speakers against enrolled
voiceprints, and produces summaries and action items for review and email
distribution.

## Status

All product flows work end to end against **local stubs** — Azure credentials
are the only missing piece. See [`docs/azure-setup.md`](docs/azure-setup.md)
for the provisioning runbook; each credential flips a stub via `MN_*` env vars.

Working today: capture (WASAPI loopback + mic), processing pipeline with
queued/processing/ready states, review with transcript editing and speaker
naming, finalize gating, email distribution (stub send), voiceprint
enrollment, per-meeting access control, audit log, global search,
notifications, auto-update wiring, CI release workflow.

## Documentation

| File | Audience |
|---|---|
| [`AGENTS.md`](AGENTS.md) | AI coding agents (Codex, Cursor, …) — canonical rules |
| [`CLAUDE.md`](CLAUDE.md) | Claude Code — machine-specific notes on top of AGENTS.md |
| [`docs/requirements.md`](docs/requirements.md) | Product requirements, locked decisions |
| [`docs/design-handoff.md`](docs/design-handoff.md) | Design system + mockups guide |
| [`docs/azure-setup.md`](docs/azure-setup.md) | Azure provisioning, stub→real map |

## Develop

Two processes: Electron client + FastAPI backend.

```bash
# client (repo root)
npm install
npm run dev          # app with hot reload (renderer only; restart for main/preload)
npm run typecheck
npm run package:dir  # unpacked Windows build

# backend
cd backend
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --port 8787
```

Backend state persists to `backend/var/store.json` (delete to reset).
API docs in dev: `http://127.0.0.1:8787/docs`.

The client works without the backend — screens fall back to sample data with
a "sample data" notice.

## Release

Push a tag `vX.Y.Z` → GitHub Actions builds the NSIS installer (unsigned
until the code-signing certificate is procured). Auto-updates ship from a
static Azure Blob feed once provisioned.
