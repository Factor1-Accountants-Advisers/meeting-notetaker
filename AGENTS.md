# Meeting Notetaker — Agent Guide

Canonical guide for AI coding agents (Codex, Cursor, Claude Code, etc.).
Claude Code users: `CLAUDE.md` adds Claude-specific notes on top of this file.

Internal desktop app for **Factor1 Accountants & Advisers**: records meetings
(online + in-person), transcribes them, identifies speakers, produces summaries
and action items for review and email distribution.

## Read first

- `docs/requirements.md` — what to build and why: the 12 locked decisions,
  data model, retention, security/compliance, packaging, open items.
- `docs/design-handoff.md` — design tokens, layout system, component
  inventory, icon mapping. UI work must follow it.
- `docs/azure-setup.md` — provisioning runbook + stub→real map. The app runs
  fully on local stubs today; each Azure credential flips one via `MN_*` env.

## Stack

- **Desktop**: Electron (thin client) + React + Vite + TypeScript + Tailwind,
  scaffolded with electron-vite; icons `lucide-react`
- **Backend**: Python + FastAPI — the ONLY component that touches data
- **Cloud (pending credentials)**: Azure Blob, PostgreSQL, Key Vault,
  AI Speech, OpenAI; Entra ID + Graph

## Architecture rules (do not violate)

- The renderer never touches the network or database. All backend calls go
  renderer → preload bridge (`window.api`) → main-process IPC → FastAPI.
- All client/meeting data and the LLM stay inside the Factor1 Azure tenant.
- Transcription + diarization are post-meeting batch, never live.
- Azure AI Speech owns diarization; pyannote only matches voiceprints.
- Azure services sit behind provider interfaces (`backend/app/services/`);
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

Everything credential-free is built and audited (22-check E2E green).
Remaining (all blocked on credentials, see `docs/azure-setup.md`):

1. MSAL/Entra wiring in the main process (login is a stub; session in
   localStorage `mn.user`)
2. SQLAlchemy/Postgres repository replacing the JSON snapshot
3. Real providers: AI Speech, Azure OpenAI, Graph email/calendar, Blob
   storage + SAS audio URLs, pyannote embeddings
4. Code signing + Blob update feed (workflow steps are commented, ready)
