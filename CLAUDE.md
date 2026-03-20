# Meeting Note-Taker

Read docs/claude-code-prompt-phase1.md for the full project spec before doing any work.

## Tech Stack
- Backend: Python 3.11+, FastAPI, SQLAlchemy, Celery, Redis
- Frontend: Next.js 14 (App Router), TypeScript, Tailwind CSS
- Desktop: Electron
- Auth: Azure AD SSO
- Storage: Azure Blob Storage, PostgreSQL
- AI: Whisper (transcription), Pyannote (diarisation), Claude API (summarisation)

## Rules
- Always follow the implementation order in the project spec
- Never hardcode API keys or secrets
- Write tests before implementation