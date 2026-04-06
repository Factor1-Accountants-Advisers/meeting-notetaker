# Backend Testing Guide

This document outlines how to test each step of the backend implementation.

## Important

Normal local development is now native, not Docker-first.

For everyday app development, run the backend with:

```powershell
cd C:\Projects\meeting-notetaker\backend
uvicorn app.main:app --reload --port 8000
```

Use Docker in this document only when you explicitly want the production-like stack.

## Prerequisites

- Docker and Docker Compose installed and WSL integration enabled
- All environment variables configured in `.env`

## Testing After Refactoring (Current Step)

### 1. Start Services
```bash
cd backend
docker compose up -d --build
```

### 2. Verify Health Check
```bash
# Should return: {"status":"healthy","environment":"development","version":"1.0.0"}
curl http://localhost:8000/health
```

### 3. Check API Documentation
Open in browser: http://localhost:8000/docs

You should see:
- FastAPI Swagger UI
- `/health` endpoint
- `/` root endpoint

### 4. Run Database Migration
```bash
docker compose exec api alembic upgrade head
```

Expected output:
```
INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.
INFO  [alembic.runtime.migration] Will assume transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade  -> 001, Initial schema
```

### 5. Verify Database Schema
```bash
docker compose exec postgres psql -U meetings_user -d meetings_db -c "\dt"
```

Expected tables:
- users
- meetings
- participants
- transcripts
- summaries
- action_items

### 6. Verify Enums Created
```bash
docker compose exec postgres psql -U meetings_user -d meetings_db -c "\dT"
```

Expected types:
- meetingstatus
- actionitemstatus

### 7. Stop Services
```bash
docker compose down
```

## Static Testing (Without Docker)

If Docker is not available, you can verify:

### Syntax Check
```bash
# Check all Python files compile
python3 -m py_compile app/main.py app/core/*.py app/*.py alembic/env.py
```

### Import Check
```bash
# Verify imports (requires dependencies installed)
python3 test_imports.py
```

### Structure Verification
```bash
# Check directory structure
find app -type f -name "*.py" | sort
```

Expected structure:
```
app/__init__.py
app/core/__init__.py
app/core/config.py
app/core/database.py
app/main.py
app/models.py
app/schemas.py
```

## What We Verified (Refactoring Step)

✅ All Python files have correct syntax (no syntax errors)
✅ Import paths updated correctly after moving to `core/`
✅ Pydantic schemas created for all API endpoints
✅ Lifespan context manager added to FastAPI app
✅ Alembic migration files have correct imports
✅ Directory structure follows FastAPI best practices

## Step 2: Azure AD Authentication Testing

**Status**: ✅ Implemented

See **[AUTH_TESTING.md](./AUTH_TESTING.md)** for complete authentication testing guide.

### Quick Test

1. **Get a test token:**
   ```bash
   # Option 1: Using helper script (easiest)
   pip install msal
   python get_test_token.py

   # Option 2: Using Azure CLI
   az login --tenant YOUR_TENANT_ID
   az account get-access-token --resource YOUR_CLIENT_ID --query accessToken -o tsv
   ```

2. **Test the /api/me endpoint:**
   ```bash
   # Should fail (401)
   curl http://localhost:8000/api/me

   # Should succeed (200) with valid token
   curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/api/me
   ```

3. **Verify user auto-provisioned:**
   ```bash
   docker compose exec postgres psql -U meetings_user -d meetings_db -c "SELECT * FROM users;"
   ```

### Security Tests Passed

✅ Fail-closed authentication (deny by default)
✅ JWT signature validation using JWKS
✅ Token expiration validation
✅ Issuer and audience validation
✅ No information disclosure in errors
✅ User auto-provisioning
✅ Detailed server-side logging

## Step 3: Upload Endpoint Testing

**Status**: ✅ Implemented

See **[UPLOAD_TESTING.md](./UPLOAD_TESTING.md)** for complete upload testing guide.

### Quick Test

1. **Start all services:**
   ```bash
   docker compose up -d --build
   docker compose exec api alembic upgrade head
   ```

2. **Get authentication token:**
   ```bash
   python get_test_token.py
   ```

3. **Upload a test file:**
   ```bash
   curl -X POST http://localhost:8000/api/meetings/upload \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -F "audio_file=@test_audio.wav" \
     -F 'metadata={"meeting_title": "Test", "attendees": []}'
   ```

4. **Verify in database:**
   ```bash
   docker compose exec postgres psql -U meetings_user -d meetings_db \
     -c "SELECT * FROM meetings;"
   ```

5. **Check MinIO console:**
   Open http://localhost:9001 (minioadmin/minioadmin)

### Services Added

- **MinIO** (port 9000/9001) - S3-compatible blob storage
- **Celery Worker** - Background task processing

### Security Tests Passed

✅ File type validation (allowlist)
✅ Authentication required
✅ Access control on meeting retrieval
✅ Signed URLs for audio access
✅ No path traversal vulnerabilities

## Next Steps Testing

After implementing each feature in the spec:
- **Step 2 (Azure AD Auth)**: ✅ COMPLETE - See AUTH_TESTING.md
- **Step 3 (Upload Endpoint)**: ✅ COMPLETE - See UPLOAD_TESTING.md
- **Step 3 (Upload Endpoint)**: Upload a .wav file, verify blob storage and DB record
- **Step 4 (Transcription)**: Upload audio, check Celery task runs, verify transcript in DB
- **Step 5 (Diarisation)**: Verify speaker labels merged with transcript
- **Step 6 (Summarisation)**: Check Claude API integration and action items created
- **Step 7 (Read Endpoints)**: Test all GET/PATCH endpoints with curl/Postman

## Troubleshooting

### "Module not found" errors
Ensure you're running from the `backend/` directory and dependencies are installed:
```bash
pip install -r requirements.txt
```

### Docker issues
Enable WSL integration in Docker Desktop settings:
Settings → Resources → WSL Integration → Enable for your distro

### Database connection errors
Check PostgreSQL is running:
```bash
docker compose ps
```

### Migration conflicts
Reset migrations (development only):
```bash
docker compose down -v  # Removes volumes
docker compose up -d
docker compose exec api alembic upgrade head
```
