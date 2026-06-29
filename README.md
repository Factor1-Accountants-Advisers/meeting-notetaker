# Meeting Notetaker

Internal desktop app for **Factor1 Accountants & Advisers** — records meetings
(online via system-audio loopback + mic, in-person via mic, or file upload),
transcribes and diarizes them, identifies speakers against enrolled
voiceprints, and produces summaries and action items for review and email
distribution.

## Status

All product flows work end to end against **local stubs** — cloud credentials
are the only missing piece. See [`docs/azure-setup.md`](docs/azure-setup.md)
for the provisioning runbook; each credential flips a stub via `MN_*` env vars.

Working today: MS Graph calendar detection with polling runtime, auto-start/stop
recording with idempotency, MSAL interactive sign-in, WASAPI loopback + mic
capture, processing pipeline with queued/processing/ready states, Pyannote
voiceprint enrollment and speaker matching (stub until HF token provisioned),
OpenAI summaries/action items (stub until `MN_OPENAI_API_KEY` set), Graph
delegated email with transcript attachment, Windows startup + tray persistence,
recording status UI, per-meeting access control, audit log, auto-update wiring,
CI release workflow.

Slice 1 Jira items are code-complete and fixture-verified. See
[`docs/jira-progress.md`](docs/jira-progress.md) for commit evidence.

## Documentation

| File | Audience |
|---|---|
| `C:\Users\JosephMiguelGuerrero\Downloads\IN-64_Export_*.csv` | **Source of truth** — Jira export of Slice 1 child issues |
| [`notetaker-scoping-document.md`](C:\Users\JosephMiguelGuerrero\Downloads\notetaker-scoping-document.md) | Project scope, slices 1–5, interdependencies |
| [`AGENTS.md`](AGENTS.md) | AI coding agents (Codex, Cursor, …) — canonical rules |
| [`docs/jira-progress.md`](docs/jira-progress.md) | Implementation evidence ledger with commit hashes |
| [`docs/design-handoff.md`](docs/design-handoff.md) | Design system + mockups guide |
| [`docs/azure-setup.md`](docs/azure-setup.md) | Cloud provisioning, stub→real map |
| [`docs/requirements.md`](docs/requirements.md) | Historical/background — do not override Jira with it |

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
