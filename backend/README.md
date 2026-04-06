# Meeting Note-Taker Backend

FastAPI backend for AI-powered meeting transcription and summarisation.

## Quick Start

Preferred local development is native, without Docker.

1. **Create and activate a virtual environment:**
   ```powershell
   cd C:\Projects\meeting-notetaker\backend
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

2. **Install dependencies:**
   ```powershell
   pip install -r requirements-base.txt
   ```

3. **Run the backend:**
   ```powershell
   uvicorn app.main:app --reload --port 8000
   ```

4. **Check health:**
   ```bash
   curl http://localhost:8000/health
   ```

5. **View API docs:**
   Open http://localhost:8000/docs in your browser

## Native Development Notes

- The default local database is `backend/data/meetings.db`
- Local file storage is created automatically under `backend/data/`
- Docker, PostgreSQL, Redis, and MinIO are not required for normal local development

To reset local state:

```powershell
Remove-Item C:\Projects\meeting-notetaker\backend\data\meetings.db
```

## Development

### Prerequisites
- Python 3.11+ (for local development)

### Environment Variables
Copy `.env.example` to `.env` and fill in the required values:
```bash
cp .env.example .env
```

### Native Local Run

```powershell
cd C:\Projects\meeting-notetaker\backend
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --reload --port 8000
```

### Docker Compose

Docker Compose is optional. Use it only when you explicitly want the PostgreSQL + Redis + MinIO + Celery stack.

```bash
docker compose up --build
docker compose exec api alembic upgrade head
```

### Database Migrations

Create a new migration:
```bash
docker compose exec api alembic revision --autogenerate -m "description"
```

Apply migrations:
```bash
docker compose exec api alembic upgrade head
```

Rollback migration:
```bash
docker compose exec api alembic downgrade -1
```

### Running Tests

Native:
```powershell
.\.venv\Scripts\Activate.ps1
pytest
```

Docker:
```bash
docker compose exec api pytest
```

## Project Structure
```
backend/
├── app/
│   ├── main.py           # FastAPI app entry point with lifespan
│   ├── core/             # Core configuration and infrastructure
│   │   ├── config.py     # Settings from environment variables
│   │   └── database.py   # Async SQLAlchemy setup
│   ├── models.py         # SQLAlchemy database models
│   ├── schemas.py        # Pydantic request/response schemas
│   ├── routers/          # API route handlers (to be added)
│   └── services/         # Business logic (to be added)
├── alembic/              # Database migrations
│   ├── env.py
│   └── versions/
│       └── 001_initial_schema.py
├── Dockerfile
├── docker-compose.yml
├── requirements-base.txt  # Native/local runtime dependencies
├── requirements.txt
├── TESTING.md            # Testing procedures
└── test_imports.py       # Import verification script
```

## API Endpoints

- `GET /health` - Health check endpoint
- `GET /docs` - Interactive API documentation (Swagger UI)
- `GET /redoc` - Alternative API documentation (ReDoc)
