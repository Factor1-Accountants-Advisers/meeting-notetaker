# Claude Code Prompt — Phase 1: AI Meeting Note-Taker MVP

## Project Context

We are building an in-house AI meeting note-taking application for an Australian accounting firm. The tool replaces fragmented third-party apps (Otter AI, Turboscribe, Meetily, Vinyl) with a single centralised platform. It records meetings, transcribes audio, identifies speakers, and uses AI to extract summaries and action items. It integrates with Microsoft Teams and Xero Practice Manager (XPM).

This prompt covers **Phase 1 only** — the foundation and MVP. The goal is a working end-to-end pipeline: desktop audio capture → backend upload → transcription → speaker diarisation → AI summarisation → viewable in a basic web app.

---

## Architecture Overview

The system has 4 components to build in Phase 1:

### 1. Desktop Capture Agent (Electron)
A lightweight Electron app that sits in the Windows system tray.

**Requirements:**
- System tray icon with status indicator (grey = idle, green = recording)
- Right-click tray menu with: "Start Recording", "Stop Recording", "Open Web App", "Settings", "Quit"
- When "Start Recording" is clicked: capture dual audio streams using Windows WASAPI — microphone input AND system audio (loopback) — mixed into a single .wav file
- When "Stop Recording" is clicked: stop capture, save the .wav locally to a configurable directory, then upload it to the backend API via `POST /api/meetings/upload`
- Authentication: Azure AD SSO via MSAL (Microsoft Authentication Library). User signs in with their Microsoft 365 credentials on first launch. The access token is sent as a Bearer token with all API requests.
- Pull the user's upcoming meetings from Microsoft Graph API (`/me/calendarView`) and display them in a small popup when the tray icon is clicked, so the user can select which meeting they're recording. The selected meeting's title and attendees are sent as metadata with the upload.
- Auto-update support via electron-updater
- Package as MSI installer for Windows deployment

**Tech:** Electron, Node.js, node-audio (or similar native WASAPI binding), MSAL for Electron, electron-builder

### 2. Backend API (Python / FastAPI)
A REST API that receives audio uploads and orchestrates the processing pipeline.

**API Endpoints:**

```
Authentication: All endpoints require Bearer token (Azure AD JWT), validated via JWKS.

POST   /api/meetings/upload
       - Accepts: multipart/form-data with audio file (.wav) + JSON metadata (meeting_title, attendees[], scheduled_time)
       - Action: saves audio to Azure Blob Storage, creates a Meeting record in PostgreSQL with status="processing", enqueues a Celery task for the transcription pipeline
       - Returns: { meeting_id, status: "processing" }

GET    /api/meetings
       - Returns: paginated list of meetings for the authenticated user
       - Query params: page, per_page, status, date_from, date_to
       - Each meeting includes: id, title, date, duration, status, participant_count, has_summary

GET    /api/meetings/{id}
       - Returns: full meeting detail — metadata, transcript (speaker-labelled segments), summary, key_points[], action_items[]
       - Include: audio_url (pre-signed Azure Blob URL for playback)

GET    /api/meetings/{id}/transcript
       - Returns: full transcript as speaker-labelled segments with timestamps
       - Format: [{ speaker: "Speaker 1", start: 0.0, end: 5.2, text: "..." }, ...]

GET    /api/meetings/{id}/action-items
       - Returns: action items for this meeting

GET    /api/action-items
       - Returns: all action items for the authenticated user (across all meetings)
       - Query params: status (open/complete), due_before, due_after, page, per_page

PATCH  /api/action-items/{id}
       - Update action item: status, owner, due_date, description

GET    /api/me
       - Returns: authenticated user profile (name, email, role)

WebSocket /ws/meetings/{id}/status
       - Pushes real-time processing status updates: "uploading" → "transcribing" → "diarising" → "summarising" → "complete"
```

**Database Models (PostgreSQL via SQLAlchemy):**

```
User: id, email, name, azure_ad_id, role, created_at
Meeting: id, title, scheduled_time, duration_seconds, status (enum: processing/transcribing/summarising/complete/failed), audio_blob_url, user_id (FK), created_at
Participant: id, meeting_id (FK), name, email
Transcript: id, meeting_id (FK, unique), full_text, segments (JSONB — array of {speaker, start, end, text})
Summary: id, meeting_id (FK, unique), summary_text, key_points (JSONB), follow_ups (JSONB)
ActionItem: id, meeting_id (FK), description, owner_name, owner_email, due_date, status (enum: open/complete), created_at, updated_at
```

**Tech:** Python 3.11+, FastAPI, SQLAlchemy + Alembic (migrations), asyncpg, Celery + Redis, Azure Blob Storage SDK, Azure AD JWT validation via python-jose + JWKS

### 3. Transcription & AI Pipeline (Celery Workers)
Background workers that process uploaded audio files.

**Pipeline steps (executed as a Celery task chain):**

1. **Download audio** from Azure Blob Storage to local temp directory
2. **Transcribe** using Whisper (use `openai-whisper` Python package with the `medium` or `large-v3` model). Output: timestamped text segments.
3. **Speaker diarisation** using `pyannote.audio` (the `pyannote/speaker-diarization-3.1` pipeline). Requires a HuggingFace token. Output: speaker-labelled time segments. Merge Whisper segments with Pyannote speaker labels by timestamp overlap.
4. **AI summarisation** using the Anthropic Claude API (`claude-sonnet-4-20250514` model). Send the full speaker-labelled transcript as input. Use the following system prompt:

```
You are a meeting summariser for an Australian accounting firm. Given a meeting transcript with speaker labels, produce a JSON response with exactly this structure:
{
  "summary": "A 3-5 sentence overview of the meeting",
  "key_points": ["Point 1", "Point 2", ...],
  "action_items": [
    {
      "description": "What needs to be done",
      "owner": "Speaker name or 'Unassigned'",
      "due_date": "YYYY-MM-DD or null if not mentioned"
    }
  ],
  "follow_ups": ["Any unresolved questions or topics to revisit"]
}
Be specific about action items. Extract real deadlines mentioned in the conversation. If a speaker volunteers to do something, they are the owner.
```

5. **Save results** to PostgreSQL: create Transcript, Summary, and ActionItem records. Update Meeting status to "complete".
6. **Update clients** via WebSocket: push status changes at each step.

**Tech:** Celery, Redis, openai-whisper, pyannote.audio, anthropic Python SDK, torch (for GPU inference)

### 4. Web Application (React / Next.js)
A basic but functional web app for viewing meeting records.

**Pages:**

1. **Dashboard / Meeting List** (`/`)
   - Table/list of all meetings, newest first
   - Columns: Date, Title, Participants, Duration, Status (with colour-coded badge)
   - Click a meeting to go to its detail page
   - Status badge shows real-time progress for meetings still processing (via WebSocket)

2. **Meeting Detail** (`/meetings/[id]`)
   - Header: meeting title, date/time, duration, list of participants
   - Three tabs:
     - **Transcript**: Speaker-labelled transcript with timestamps. Each segment shows speaker name (colour-coded) and text. Clicking a segment timestamp plays audio from that point.
     - **Summary**: AI-generated summary paragraph, followed by key discussion points as a list, followed by follow-up questions.
     - **Action Items**: Table of action items with description, owner, due date, and status toggle (open/complete). Inline editing for owner and due date.
   - Audio player bar at the top (HTML5 audio element with the pre-signed Blob URL)

3. **Action Items** (`/action-items`)
   - Aggregated list of all action items across all meetings
   - Filters: status (open/complete), owner, date range
   - Each item links back to its source meeting

4. **Login** (`/login`)
   - "Sign in with Microsoft" button using MSAL.js
   - Redirects to dashboard after authentication

**Tech:** Next.js 14 (App Router), TypeScript, Tailwind CSS, MSAL.js for React (@azure/msal-react), SWR or React Query for data fetching

---

## Project Structure

```
meeting-notetaker/
├── desktop/                    # Electron desktop agent
│   ├── src/
│   │   ├── main/              # Electron main process
│   │   │   ├── index.ts       # App entry, tray setup
│   │   │   ├── tray.ts        # System tray logic
│   │   │   ├── recorder.ts    # WASAPI audio capture
│   │   │   ├── uploader.ts    # Upload to backend API
│   │   │   └── auth.ts        # MSAL authentication
│   │   └── renderer/          # Electron renderer (meeting selector popup)
│   ├── package.json
│   └── electron-builder.yml
├── backend/                    # FastAPI backend
│   ├── app/
│   │   ├── main.py            # FastAPI app entry
│   │   ├── config.py          # Settings (env vars)
│   │   ├── auth.py            # Azure AD JWT validation
│   │   ├── models.py          # SQLAlchemy models
│   │   ├── schemas.py         # Pydantic request/response schemas
│   │   ├── routers/
│   │   │   ├── meetings.py
│   │   │   ├── action_items.py
│   │   │   └── users.py
│   │   ├── services/
│   │   │   ├── storage.py     # Azure Blob operations
│   │   │   ├── transcription.py  # Whisper transcription
│   │   │   ├── diarisation.py    # Pyannote speaker labelling
│   │   │   ├── summarisation.py  # Claude API summarisation
│   │   │   └── pipeline.py       # Celery task chain orchestration
│   │   └── websocket.py       # WebSocket status updates
│   ├── alembic/               # Database migrations
│   ├── requirements.txt
│   ├── Dockerfile
│   └── docker-compose.yml     # Backend + Redis + PostgreSQL for local dev
├── web/                        # Next.js web app
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx              # Dashboard / meeting list
│   │   │   ├── meetings/[id]/page.tsx # Meeting detail
│   │   │   ├── action-items/page.tsx  # Action items view
│   │   │   └── login/page.tsx         # Login page
│   │   ├── components/
│   │   │   ├── MeetingList.tsx
│   │   │   ├── TranscriptView.tsx
│   │   │   ├── SummaryView.tsx
│   │   │   ├── ActionItemsTable.tsx
│   │   │   ├── AudioPlayer.tsx
│   │   │   ├── StatusBadge.tsx
│   │   │   └── Layout.tsx
│   │   ├── lib/
│   │   │   ├── api.ts          # API client
│   │   │   ├── auth.ts         # MSAL config
│   │   │   └── websocket.ts    # WebSocket client
│   │   └── types/
│   │       └── index.ts        # TypeScript interfaces
│   ├── package.json
│   ├── tailwind.config.ts
│   └── tsconfig.json
├── .env.example                # All required environment variables
├── README.md
└── Makefile                    # Common dev commands
```

---

## Environment Variables (.env.example)

```env
# Azure AD
AZURE_AD_TENANT_ID=
AZURE_AD_CLIENT_ID=
AZURE_AD_CLIENT_SECRET=

# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=
AZURE_STORAGE_CONTAINER_NAME=meeting-audio

# PostgreSQL
DATABASE_URL=postgresql+asyncpg://user:password@localhost:5432/meetings

# Redis
REDIS_URL=redis://localhost:6379/0

# Anthropic
ANTHROPIC_API_KEY=

# HuggingFace (for Pyannote)
HF_TOKEN=

# Whisper
WHISPER_MODEL=medium

# Web App
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_AZURE_AD_CLIENT_ID=
NEXT_PUBLIC_AZURE_AD_TENANT_ID=
```

---

## Implementation Order

Build in this exact sequence so each step is testable before moving on:

1. **Backend skeleton** — FastAPI app with health check, Docker Compose with PostgreSQL + Redis, SQLAlchemy models, Alembic initial migration. Get `docker-compose up` working.
2. **Azure AD auth** — JWT validation middleware on FastAPI. Test with a manually obtained token.
3. **Upload endpoint** — `POST /api/meetings/upload` that accepts a .wav file, stores it in Azure Blob (or local filesystem for dev), creates a Meeting record, and enqueues a Celery task. For local dev, use MinIO as an S3-compatible blob store instead of Azure.
4. **Transcription worker** — Celery task that downloads audio, runs Whisper, saves transcript to DB. Test with a sample .wav file.
5. **Diarisation worker** — Add Pyannote step after Whisper. Merge speaker labels with transcript segments.
6. **Summarisation worker** — Add Claude API step. Parse the JSON response and save Summary + ActionItems to DB.
7. **Read endpoints** — `GET /meetings`, `GET /meetings/{id}`, `GET /action-items`, `PATCH /action-items/{id}`. Test with curl/Postman.
8. **Web app** — Next.js app with MSAL login, meeting list page, meeting detail page with transcript/summary/action items tabs.
9. **Desktop agent** — Electron app with tray icon, manual start/stop recording, .wav capture, upload to backend. This is last because you can test steps 1-8 by manually uploading .wav files.

---

## Key Technical Decisions

- **Local dev without Azure:** Use Docker Compose with PostgreSQL, Redis, and MinIO (S3-compatible). The code should use environment variables to switch between local MinIO and Azure Blob Storage.
- **Whisper model:** Start with `medium` for speed during development. Switch to `large-v3` for production accuracy.
- **No Teams bot:** We capture audio on the desktop via WASAPI, not via a Teams bot. This avoids admin setup and bot-joins-meeting awkwardness.
- **Manual recording only (Phase 1):** User explicitly clicks "Start Recording" in the system tray. Automatic recording comes in Phase 4.
- **Authentication:** Azure AD SSO throughout. The desktop agent, web app, and API all use the same Azure AD app registration. The API validates JWTs. No separate user/password system.

---

## What NOT to build in Phase 1

Do not implement any of the following — these come in later phases:
- XPM integration (Phase 2)
- Client-to-meeting linking (Phase 2)
- "Ask AI" chat feature (Phase 3)
- Automatic recording / calendar-based triggers (Phase 4)
- Mobile app (Phase 4)
- Admin panel (Phase 4)

Focus purely on: record → upload → transcribe → diarise → summarise → view in web app.
