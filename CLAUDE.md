# Meeting Notetaker — Claude Code Guide

Internal desktop app for **Factor1 Accountants & Advisers** that records meetings
(online + in-person), transcribes them, identifies speakers, and produces meeting
summaries and action items for review and distribution.

This file is the entry point. **Read the linked docs before writing code.**

## Project docs (read first)

- `docs/requirements.docx` — what to build and why: architecture, the 12 locked
  decisions, data model, retention, security & compliance, packaging & updates,
  open items, and the process-flow diagram.
- `docs/design-handoff.md` — design system: tokens, layout, component inventory,
  per-screen functions, light/dark themes, and a Tabler→lucide icon mapping.
- `docs/mockups/home-screen.html`, `docs/mockups/meetings.html` — reference
  renders. Open them in a browser to see the target. **Port to React + Tailwind;
  do NOT ship the raw HTML, its inline Tabler webfont, or its CSS-variable scheme.**

## Stack

- **Desktop**: Electron — thin client (recording, upload, review UI only)
- **UI**: React + Vite + Tailwind CSS; icons via `lucide-react`
- **Backend**: Python + FastAPI — the ONLY component that touches the database
- **Cloud (Azure)**: Blob Storage (audio), Database for PostgreSQL (data),
  Key Vault (secrets), AI Speech (transcribe + diarize), OpenAI (summaries + actions)
- **Speaker ID**: pyannote (embeddings + matching only) in the backend
- **Packaging**: electron-builder → NSIS, code-signed
- **Updates**: electron-updater with a static Azure Blob feed

## Architecture rules (do not violate)

- Desktop clients never connect to the database directly — all data access is
  through the FastAPI backend.
- All client/meeting data and the LLM stay inside the Factor1 Azure tenant.
- Transcription + diarization are post-meeting (batch), not live.
- Azure AI Speech owns diarization (who-spoke-when); pyannote only extracts and
  matches voiceprint embeddings.
- LLM access sits behind a provider-agnostic interface (default: Azure OpenAI).

## Product behaviours the UI must enforce

- A meeting is **Draft** until finalised; email distribution is disabled until then.
- **Unknown** (unmatched) speakers are flagged for manual naming everywhere they
  appear — transcript, participants, and any action item they own.
- Action items carry source meeting, owner, deadline, priority, status; tracked
  **in-app only** (no Planner / To Do / Xero in v1).
- Audio-first — no video affordances.
- Ship **both light and dark** themes (Tailwind `dark:` over the design tokens).

## Navigation (5-item rail + top-bar search)

Home · Meetings · Action items · People · Settings. Global search lives in the
top bar, not the rail.

## Suggested build order

1. Scaffold Electron + React + Vite + Tailwind; load the design tokens from
   `design-handoff.md` into `tailwind.config`; set up `lucide-react`.
2. App shell: top bar + 5-item icon rail, with light/dark.
3. Home screen (match `home-screen.html`), then Meetings (match `meetings.html`).
4. FastAPI backend skeleton + Azure connections (Blob, Postgres, Key Vault).
5. Pipeline: capture/upload → AI Speech → pyannote match → Azure OpenAI → store.
6. Meeting review screen, enrollment (People), then packaging + updates.

## Conventions

- UI text in sentence case. Two font weights only (400 / 500). Flat surfaces
  (no gradients/shadows; focus rings only).
- Secrets live in Key Vault / environment, never in the repo or on the client.

## Commands (desktop client)

Stack scaffolded with **electron-vite** (Electron + React + Vite + TS + Tailwind).

- `npm run dev` — start the app with HMR (main + preload + renderer).
- `npm run build` — type-check-free production build into `out/`.
- `npm run typecheck` — type-check node (main/preload) and web (renderer).
- `npm run package` — build + electron-builder NSIS installer (Windows).
- `npm run package:dir` — unpacked build for local testing (no installer).

Source layout: `src/main` (Electron main), `src/preload` (context bridge),
`src/renderer/src` (React app). Renderer alias `@renderer` → `src/renderer/src`.
Design tokens live as CSS variables in `src/renderer/src/assets/index.css` and are
exposed to Tailwind via `tailwind.config.js`. Dark mode is class-based (`.dark`).

## Commands (backend)

Skeleton in `backend/` (FastAPI + in-memory store standing in for PostgreSQL).

- Setup: `cd backend && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt`
- Run: `backend/.venv/Scripts/python -m uvicorn app.main:app --port 8787` (from `backend/`)
- API docs (dev only): `http://127.0.0.1:8787/docs`

Layout: `app/main.py` (factory), `app/config.py` (env-driven settings, `MN_` prefix),
`app/schemas.py` (API models per requirements §6.1), `app/routers/` (health, meetings,
action-items, people), `app/services/llm.py` (provider-agnostic LLM interface),
`app/store.py` (seeded in-memory store — replace with Postgres repo).
