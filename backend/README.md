# Meeting Note-Taker Backend

FastAPI backend for AI-powered meeting transcription and summarisation.

## Quick Start

1. **Start the services:**
   ```bash
   docker-compose up --build
   ```

2. **Run database migrations:**
   ```bash
   docker-compose exec api alembic upgrade head
   ```

3. **Check health:**
   ```bash
   curl http://localhost:8000/health
   ```

4. **View API docs:**
   Open http://localhost:8000/docs in your browser

## Development

### Prerequisites
- Docker and Docker Compose
- Python 3.11+ (for local development)

### Environment Variables
Copy `.env.example` to `.env` and fill in the required values:
```bash
cp .env.example .env
```

### Database Migrations

Create a new migration:
```bash
docker-compose exec api alembic revision --autogenerate -m "description"
```

Apply migrations:
```bash
docker-compose exec api alembic upgrade head
```

Rollback migration:
```bash
docker-compose exec api alembic downgrade -1
```

### Running Tests
```bash
docker-compose exec api pytest
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
├── requirements.txt
├── TESTING.md            # Testing procedures
└── test_imports.py       # Import verification script
```

## API Endpoints

- `GET /health` - Health check endpoint
- `GET /docs` - Interactive API documentation (Swagger UI)
- `GET /redoc` - Alternative API documentation (ReDoc)
