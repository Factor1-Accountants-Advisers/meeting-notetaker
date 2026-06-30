# Meeting Notetaker — Agent Guide

Canonical guide for AI coding agents (Codex, Cursor, Claude Code, etc.).
Claude Code users: `CLAUDE.md` adds Claude-specific notes on top of this file.

Internal desktop app for **Factor1 Accountants & Advisers**: records meetings
(online + in-person), transcribes them, identifies speakers, produces summaries
and action items for review, email distribution, and SharePoint storage.

## Read first

- `C:\Users\JosephMiguelGuerrero\Downloads\IN-64_Export_*.xlsx` — **source of truth** for Slice 1 scope, child issues, acceptance criteria, and provider choices. Re-export from Jira when it changes.
- `C:\Users\JosephMiguelGuerrero\Downloads\notetaker-scoping-document.md` — project-level scope, slices 1–5, interdependencies, risks, costs. Authoritative for slice boundaries.
- `docs/requirements.md` — historical/background doc only; do not override Jira with it.
- `docs/design-handoff.md` — design tokens, layout system, component inventory, icon mapping. UI work must follow it.
- `docs/jira-progress.md` — implementation evidence ledger; each crossed-off item maps to commits.
- `docs/azure-setup.md` — provisioning runbook + stub→real map. Each credential flips one provider via `MN_*` env.

## Stack

- **Desktop**: Electron (thin client) + React + Vite + TypeScript + Tailwind, scaffolded with electron-vite; icons `lucide-react`
- **Backend**: Python + FastAPI — the ONLY component that touches data
- **Auth**: MSAL public-client (PKCE) for delegated Microsoft Graph access
- **Meeting detection**: Microsoft Graph calendar polling (`/me/calendarView`)
- **Transcription + speaker ID**: PyannoteAI (Jira-mandated; IN-64, IN-69)
- **LLM (summaries + action items)**: OpenAI — direct API (`MN_OPENAI_API_KEY`) or Azure OpenAI (`MN_OPENAI_ENDPOINT` + `MN_OPENAI_DEPLOYMENT`). Provider-agnostic interface; Jira does not mandate a specific OpenAI hosting method.
- **Storage**: Azure Blob (audio, JSON), SharePoint (transcripts, summaries — Slice 1 requirement)
- **Email**: Microsoft Graph delegated `Mail.Send` (transcript text attachment)
- **Infra (future slices)**: Azure Functions (Slice 3), Azure PostgreSQL, Key Vault

## Architecture rules (do not violate)

- The renderer never touches the network or database. All backend calls go renderer → preload bridge (`window.api`) → main-process IPC → FastAPI.
- Transcription + diarization are post-meeting batch, never live.
- PyannoteAI owns transcription and voiceprint speaker identification per Jira IN-64/IN-69.
- Cloud services sit behind provider interfaces (`backend/app/services/`); stubs activate automatically when `MN_*` config is empty. Never bypass them.
- Secrets live in Key Vault / env. Never in the repo or the client.
- Desktop must not ship client secrets, API keys, database credentials, or tokens.

## Product rules the code enforces (keep them enforced)

- Meetings are **Draft** until finalised; email only after finalisation.
- Finalise requires: pipeline `ready` AND zero unknown speakers (server 409s).
- Finalised meetings are immutable (transcript/naming/upload 409); action-item status updates remain allowed.
- **Unknown speakers** are flagged in processing metadata for correction in Slice 4 (no in-app review UI in Slice 1 per Jira acceptance criteria).
- Every mutation is audit-logged (who/what/when, before/after) — new mutating endpoints MUST call `store.add_audit`.
- Per-meeting access: viewer < editor < owner (`backend/app/access.py`); apply `require()` to any new endpoint. Actor = `X-MN-User` header.
- Raw audio is deleted after 30 days; enrollment audio never touches disk.
- Audio-first: no video affordances anywhere.
- Recording starts automatically ±3 minutes of meeting start time for eligible hosted meetings (Jira AC).
- Auto-stop fires within 60 seconds of meeting end (Jira AC).

## Slice 1 Jira stories (source: Jira export)

Parent: **IN-64** — Slice 1: Auto-Triggered Recording, Pyannote Speaker ID, and UI Modernisation
Epic: **IN-50** (J000039 — The Notetaker)
Status: Scoped | Due: 10 Jul 2026 | Priority: High

Key acceptance criteria:
1. Auto-record for hosted calendar meetings within ±3 minutes of start
2. Skip + log reason when user is not organiser
3. Manual recording for in-room/ad-hoc (no calendar required)
4. Pyannote voiceprint speaker identification with confidence scores
5. Auto-stop within 60 seconds, upload begins automatically
6. Per-meeting Record button absent; manual controls retained
7. Action items view, meeting detail page, dashboard meeting list removed
8. Audio Setup page present in Settings
9. onlineMeetingId, joinWebUrl, organiser email in upload payload
10. Unidentified speakers flagged for Slice 4 correction

Child stories (code-complete, see `docs/jira-progress.md` for commit evidence):
- IN-65 — Graph meeting detection spike (polling vs webhooks)
- IN-67 — Host-only recording gate
- IN-66 — Auto-start/stop recording wiring
- IN-71 — Windows startup + tray persistence
- IN-77 — Recording status UI
- IN-69 — Pyannote transcription + voiceprint pipeline
- IN-78 — Attendee-first voiceprint selection
- IN-79 — Controlled voiceprint expansion
- IN-80 — False-positive suppression
- IN-76 — Voiceprint enrollment/admin utility
- IN-93 — Outlook emailing of transcript via Graph
- IN-72/73/74/75 — UI cleanup (remove Record button, meeting detail, action items, dashboard)
- IN-81 — Packaging/signing/installer prep
- IN-68 — MS Graph meeting detection (live smoke validated)
- IN-85/87/88/94 — QA verification items

## Commands

Desktop client (repo root):

- `npm run dev` — Electron app with HMR. **Gotcha: only the renderer hot-reloads; after `src/main` or `src/preload` changes, kill and rerun.**
- `npm run typecheck` — node (main/preload) + web (renderer)
- `npm run build` — production build into `out/`
- `npm run package:dir` — unpacked build (exe metadata editing disabled on dev machines; CI re-enables it)

Backend (`backend/`):

- Setup: `python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt`
- Run: `.venv/Scripts/python -m uvicorn app.main:app --port 8787`
- API docs (dev): `http://127.0.0.1:8787/docs`
- State persists to `backend/var/store.json`; delete it to reset to seeds.

Release: push tag `v*` → `.github/workflows/release.yml` builds the NSIS installer (unsigned until the cert lands).

## Source layout

```
src/main/        Electron main: window, IPC (api proxy, recording save, update check), WASAPI loopback grant, current-user header, MSAL auth, Graph detection runtime, startup module
src/preload/     context bridge: window.api (request/saveRecording/setUser/checkUpdates, auto-start/stop IPC, auto-launch settings)
src/renderer/src/
  assets/        design tokens as CSS vars + Tailwind entry (dark = .dark)
  components/    shell (TopBar/NavRail/AppShell) + ui primitives + modals
  lib/           api.ts (DTOs + mapping), capture.ts (mic+loopback singleton), recorder.ts, prefs.ts, useLive.ts, useNotifications.ts
  screens/       Home, People, Settings, Login, Recording
  data/mock.ts   sample data = offline fallback (intentional; do not delete)
backend/app/
  main.py        factory + snapshot middleware + retention task
  config.py      env settings, MN_ prefix (see backend/.env.example)
  schemas.py     API models
  access.py      role checks
  store.py       seeded in-memory store + JSON snapshot (Postgres stand-in)
  routers/       health, meetings, action_items, people, search
  services/      pipeline, speech, llm, email, speaker_matching, speaker_embeddings, voiceprints, retention (all provider-interface + stub pattern)
```

## Conventions

- UI: sentence case; font weights 400/500 only; flat surfaces (no shadows, focus rings only); tokens via Tailwind names `bg-*`, `content-*`, `edge-*`.
- Light + dark must both work (class-based `.dark`).
- Backend: every mutating endpoint takes `actor: str = Actor`, audits, and is covered by the snapshot middleware.
- Renderer screens use `useLive(fetcher, sample)` — live data with offline fallback and a "sample data" notice. Keep that pattern.
- Verify changes: `npm run verify:graph && npm run typecheck && npm run build && git diff --check` + run the backend API and exercise endpoints.
- Commit evidence in `docs/jira-progress.md` after verifying.

## Current state

Slice 1 is code-complete and fixture-verified. All Jira child stories crossed off with commit evidence in `docs/jira-progress.md`.

Remaining operational items:
1. Code signing certificate for Windows installer (IN-81 — signing disabled locally; enabled in CI release workflow).
2. Intune Win32 packaging per DV confirmation.
3. Provision real backend credentials: pyannoteAI API key (`MN_PYANNOTE_API_KEY`), OpenAI API key, Azure Blob, PostgreSQL.
4. Blob update feed URL for electron-updater.
5. Live voiceprint enrollment with real PyannoteAI embeddings (stub works today).
6. SharePoint transcript storage integration (Slice 1 requirement — emailed transcripts implemented; SharePoint folder pending provisioning).
