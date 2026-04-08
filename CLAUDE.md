# Meeting Note-Taker

Read docs/claude-code-prompt-phase1.md for the full project spec before doing any work.

## Tech Stack
- Backend: Python 3.11+, FastAPI, SQLAlchemy (async), background threads (no Celery/Redis)
- Frontend: Next.js 14 (App Router), TypeScript, Tailwind CSS
- Desktop: Electron (bundles web app as static export)
- Auth: Azure AD SSO (MSAL)
- Storage: Local filesystem (dev), MinIO (optional), Azure Blob Storage (prod)
- Database: SQLite + aiosqlite (dev), PostgreSQL + asyncpg (prod)
- AI: AssemblyAI (transcription + speaker diarisation), OpenAI GPT-4o (summarisation)

## Deviations from Original Spec (docs/claude-code-prompt-phase1.md)

The original spec is the design blueprint. These are the implementation decisions made during development:

- **Transcription:** AssemblyAI cloud API replaced local Whisper + Pyannote. Single API call handles both transcription and speaker diarisation, with speaker identification when attendee names are available.
- **Summarisation:** OpenAI GPT-4o replaced Anthropic Claude API. Uses JSON mode for structured output.
- **Task queue:** Background threads via `asyncio.to_thread()` replaced Celery + Redis. Simpler for single-server deployment.
- **Dev database:** SQLite replaced PostgreSQL for local development. No Docker required for everyday dev.
- **Desktop consolidation:** Web app is bundled into Electron as a static export (Option B). Single app, single sign-in.
- **Video upload:** Added support for .mp4/.m4v/.mov uploads with automatic audio extraction via ffmpeg.

## Rules
- Always follow the implementation order in the project spec
- Never hardcode API keys or secrets
- Write tests before implementation