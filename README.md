# Meeting Note-Taker

Meeting Note-Taker consists of:

- a native Python backend in `backend/`
- a Next.js frontend in `web/`
- an Electron desktop shell in `desktop/`

## Preferred Local Development Workflow

The app now runs natively by default. Docker is optional and is no longer the main local-development path.

### Terminal 1: Backend

```powershell
cd C:\Projects\meeting-notetaker\backend

# One-time setup
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-base.txt

# Run the backend
uvicorn app.main:app --reload --port 8000
```

Useful checks:

```powershell
curl http://localhost:8000/health
```

API docs:

- `http://localhost:8000/docs`

### Terminal 2: Desktop + Frontend

```powershell
cd C:\Projects\meeting-notetaker\desktop
npm install
npm run dev
```

`desktop/npm run dev` starts the Next.js frontend from `../web` and then launches Electron.
You do not need a separate `web` terminal for normal desktop development.

## Local Data

The native backend uses SQLite and local file storage by default.
It creates local state under `backend/data/`.

To reset the local database:

```powershell
Remove-Item C:\Projects\meeting-notetaker\backend\data\meetings.db
```

The backend recreates it on the next startup.

## Docker

Docker is still available for a production-like local stack using PostgreSQL, Redis, MinIO, and Celery, but it is optional and not required for everyday app development.
