# Meeting Notetaker — Agent Guide

Canonical guide for AI coding agents (Codex, Cursor, Claude Code, etc.).
Claude Code users: `CLAUDE.md` adds Claude-specific notes on top of this file.

Internal desktop app for **Factor1 Accountants & Advisers**: records meetings
(online + in-person), transcribes them, identifies speakers, produces summaries
and action items for review and email distribution.

## Read first

- `C:\\Users\\JosephMiguelGuerrero\\Downloads\\Jira.csv` (`/mnt/c/Users/JosephMiguelGuerrero/Downloads/Jira.csv`) — **source of truth** for Slice 1 scope and provider choices.
- `docs/requirements.md` — historical/background doc only; do not override Jira with it.
- `docs/design-handoff.md` — design tokens, layout system, component
  inventory, icon mapping. UI work must follow it.
- `docs/azure-setup.md` — provisioning runbook + stub→real map. The app runs
  fully on local stubs today; each credential flips one via `MN_*` env.

## Stack

- **Desktop**: Electron (thin client) + React + Vite + TypeScript + Tailwind,
  scaffolded with electron-vite; icons `lucide-react`
- **Backend**: Python + FastAPI — the ONLY component that touches data
- **Cloud (pending credentials)**: Azure Blob, PostgreSQL, Key Vault,
  Azure OpenAI; Entra ID + Graph; PyannoteAI for transcription and speaker ID

## Architecture rules (do not violate)

- The renderer never touches the network or database. All backend calls go
  renderer → preload bridge (`window.api`) → main-process IPC → FastAPI.
- All client/meeting data and the LLM stay inside the Factor1 Azure tenant.
- Transcription + diarization are post-meeting batch, never live.
- PyannoteAI owns transcription and voiceprint speaker identification per Jira IN-64/IN-69.
- Cloud services sit behind provider interfaces (`backend/app/services/`);
  stubs activate automatically when `MN_*` config is empty. Never bypass them.
- Secrets live in Key Vault / env. Never in the repo or the client.

## Product rules the code enforces (keep them enforced)

- Meetings are **Draft** until finalised; email only after finalisation.
- Finalise requires: pipeline `ready` AND zero unknown speakers (server 409s).
- Finalised meetings are immutable (transcript/naming/upload 409); action-item
  status updates remain allowed.
- **Unknown speakers** are flagged for manual naming everywhere they appear.
- Every mutation is audit-logged (who/what/when, before/after) — new mutating
  endpoints MUST call `store.add_audit`.
- Per-meeting access: viewer < editor < owner (`backend/app/access.py`);
  apply `require()` to any new endpoint. Actor = `X-MN-User` header (set by
  the Electron main process; becomes the Entra token subject later).
- Raw audio is deleted after 30 days; enrollment audio never touches disk.
- Audio-first: no video affordances anywhere.

## Commands

Desktop client (repo root):

- `npm run dev` — Electron app with HMR. **Gotcha: only the renderer
  hot-reloads; after `src/main` or `src/preload` changes, kill and rerun.**
- `npm run typecheck` — node (main/preload) + web (renderer)
- `npm run build` — production build into `out/`
- `npm run package:dir` — unpacked build (exe metadata editing disabled on
  dev machines; CI re-enables it)

Backend (`backend/`):

- Setup: `python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt`
- Run: `.venv/Scripts/python -m uvicorn app.main:app --port 8787`
- API docs (dev): `http://127.0.0.1:8787/docs`
- State persists to `backend/var/store.json`; delete it to reset to seeds.

Release: push tag `v*` → `.github/workflows/release.yml` builds the NSIS
installer (unsigned until the cert lands).

## Source layout

```
src/main/        Electron main: window, IPC (api proxy, recording save,
                 update check), WASAPI loopback grant, current-user header
src/preload/     context bridge: window.api (request/saveRecording/setUser/
                 checkUpdates)
src/renderer/src/
  assets/        design tokens as CSS vars + Tailwind entry (dark = .dark)
  components/    shell (TopBar/NavRail/AppShell) + ui primitives + modals
  lib/           api.ts (DTOs + mapping), capture.ts (mic+loopback singleton),
                 recorder.ts, prefs.ts, useLive.ts, useNotifications.ts
  screens/       Home, Meetings, MeetingReview, ActionItems, People,
                 Settings, Login, Recording
  data/mock.ts   sample data = offline fallback (intentional; do not delete)
backend/app/
  main.py        factory + snapshot middleware + retention task
  config.py      env settings, MN_ prefix (see backend/.env.example)
  schemas.py     API models (requirements §6.1)
  access.py      role checks
  store.py       seeded in-memory store + JSON snapshot (Postgres stand-in)
  routers/       health, meetings, action_items, people, search
  services/      pipeline, speech, llm, email, retention (all provider-
                 interface + stub pattern)
```

## Conventions

- UI: sentence case; font weights 400/500 only; flat surfaces (no shadows,
  focus rings only); tokens via Tailwind names `bg-*`, `content-*`, `edge-*`.
- Light + dark must both work (class-based `.dark`).
- Backend: every mutating endpoint takes `actor: str = Actor`, audits, and
  is covered by the snapshot middleware (async tasks call
  `store.save_snapshot()` explicitly).
- Renderer screens use `useLive(fetcher, sample)` — live data with offline
  fallback and a "sample data" notice. Keep that pattern.
- Verify changes: typecheck + build + (backend) run the API and exercise the
  endpoints; UI flows verified in-browser before claiming done.

## Current state / what's left

Slice 1 (v1.0.0) is code-complete and fixture-verified. Remaining:

1. Live tenant credentials for Entra ID / MS Graph (IN-68 blocked until
   MN_ENTRA_CLIENT_ID + MN_ENTRA_TENANT_ID are set in the desktop env).
2. Code signing certificate for Windows installer (IN-81 — signing disabled
   locally; enabled in CI release workflow).
3. Intune Win32 packaging per DV confirmation (IN-89 — NSIS → Intune prep
   tool, see electron-builder.yml).
4. SQLAlchemy/Postgres repository replacing the JSON snapshot.
5. Real providers: PyannoteAI transcription/speaker ID, Azure OpenAI,
   Azure Blob storage (all behind provider interfaces — drop-in).
6. Blob update feed URL for electron-updater (REPLACE_ME in config).

Slice 1 delivered features:
- MS Graph meeting detection with polling runtime + resume-aware lifecycle
- Host-only recording gate (organiser check)
- Auto-start/stop recording state machine with idempotency
- MSAL public-client auth with interactive PKCE sign-in
- System tray with status + startup persistence
- Pyannote voiceprint pipeline: embeddings, enrollment, speaker matching
- Attendee-first candidate selection + controlled expansion + false-positive suppression
- Graph delegated email with transcript attachment (Mail.Send)
- Simplified UI: manual recording, audio setup, people, settings
- Fixture-driven verification (scripts/verify-graph-fixtures.ts)
