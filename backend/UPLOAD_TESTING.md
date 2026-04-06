# Step 3: Upload Endpoint Testing Guide

This guide explains how to test the meeting upload endpoint and verify blob storage + Celery integration.

## Important

This guide is Docker-oriented because it covers MinIO + Celery integration.
For normal local app development, the preferred backend startup is native:

```powershell
cd C:\Projects\meeting-notetaker\backend
uvicorn app.main:app --reload --port 8000
```

## Overview

The upload endpoint:
1. Accepts audio file (.wav/.mp3) + JSON metadata
2. Validates file type and metadata
3. Uploads to MinIO (local) or Azure Blob Storage (production)
4. Creates Meeting + Participant records in database
5. Enqueues Celery task for processing pipeline
6. Returns meeting_id and status

## Prerequisites

1. Docker Compose running with all services
2. Valid Azure AD token (from Step 2 testing)

## Starting the Services

```bash
cd backend

# Start all services (includes MinIO and Celery worker)
docker compose up -d --build

# Run database migrations
docker compose exec api alembic upgrade head

# Check all services are healthy
docker compose ps
```

Expected services:
- `meetings-postgres` - Database
- `meetings-redis` - Task broker
- `meetings-minio` - Blob storage (local)
- `meetings-api` - FastAPI application
- `meetings-celery` - Background worker

## Testing the Upload Endpoint

### 1. Create a Test Audio File

```bash
# Create a simple test WAV file (requires sox)
# Or download any .wav file for testing

# Option 1: Use sox to create a 5-second silent test file
sox -n -r 16000 -c 1 test_audio.wav trim 0.0 5.0 2>/dev/null || \
  echo "sox not installed, create test_audio.wav manually"

# Option 2: Download a sample WAV
curl -o test_audio.wav "https://www2.cs.uic.edu/~i101/SoundFiles/gettysburg.wav"
```

### 2. Upload Without Authentication (Should Fail)

```bash
curl -X POST http://localhost:8000/api/meetings/upload \
  -F "audio_file=@test_audio.wav" \
  -F 'metadata={"meeting_title": "Test Meeting", "attendees": []}'
```

Expected response (401):
```json
{
  "detail": "Authentication required"
}
```

### 3. Upload With Authentication (Should Succeed)

```bash
# Get token first (see AUTH_TESTING.md)
TOKEN="your-azure-ad-token-here"

# Upload with authentication
curl -X POST http://localhost:8000/api/meetings/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "audio_file=@test_audio.wav" \
  -F 'metadata={"meeting_title": "Weekly Standup", "attendees": [{"name": "John Doe", "email": "john@example.com"}, {"name": "Jane Smith", "email": "jane@example.com"}], "scheduled_time": "2026-03-19T10:00:00"}'
```

Expected response (200):
```json
{
  "meeting_id": 1,
  "status": "processing"
}
```

### 4. Upload with Invalid File Type (Should Fail)

```bash
# Create a text file
echo "not audio" > test.txt

curl -X POST http://localhost:8000/api/meetings/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "audio_file=@test.txt" \
  -F 'metadata={"meeting_title": "Test", "attendees": []}'
```

Expected response (400):
```json
{
  "detail": "Invalid file type. Allowed: .wav, .mp3"
}
```

### 5. Upload with Invalid Metadata (Should Fail)

```bash
curl -X POST http://localhost:8000/api/meetings/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "audio_file=@test_audio.wav" \
  -F 'metadata=not valid json'
```

Expected response (400):
```json
{
  "detail": "Invalid JSON in metadata"
}
```

## Verifying Upload Results

### 1. Check Database Records

```bash
# Check meetings table
docker compose exec postgres psql -U meetings_user -d meetings_db \
  -c "SELECT id, title, status, audio_blob_url, created_at FROM meetings;"

# Check participants table
docker compose exec postgres psql -U meetings_user -d meetings_db \
  -c "SELECT id, meeting_id, name, email FROM participants;"
```

Expected output:
```
 id |     title      |   status   |                audio_blob_url                 |         created_at
----+----------------+------------+-----------------------------------------------+----------------------------
  1 | Weekly Standup | processing | audio/2026/03/19/abc123_test_audio.wav        | 2026-03-19 12:00:00
```

### 2. Check MinIO Storage

Open MinIO Console: http://localhost:9001

Credentials:
- Username: `minioadmin`
- Password: `minioadmin`

Navigate to the `meeting-audio` bucket and verify the uploaded file exists.

Or use the MinIO CLI:
```bash
# Install mc (MinIO Client)
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin

# List files
docker compose exec minio mc ls local/meeting-audio/audio/
```

### 3. Check Celery Task

```bash
# View Celery worker logs
docker compose logs celery-worker

# Should see:
# [INFO] Received task: app.services.pipeline.process_meeting[task-id]
# [INFO] Starting processing pipeline for meeting 1
```

### 4. Get Meeting Details

```bash
curl -X GET http://localhost:8000/api/meetings/1 \
  -H "Authorization: Bearer $TOKEN"
```

Expected response:
```json
{
  "id": 1,
  "title": "Weekly Standup",
  "scheduled_time": "2026-03-19T10:00:00",
  "status": "processing",
  "audio_url": "http://minio:9000/meeting-audio/audio/2026/03/19/abc123_test_audio.wav?...",
  "created_at": "2026-03-19T12:00:00"
}
```

## Testing Access Control

### 1. Try to Access Another User's Meeting (Should Fail)

```bash
# User A uploads a meeting
# User B (different token) tries to access it
curl -X GET http://localhost:8000/api/meetings/1 \
  -H "Authorization: Bearer $USER_B_TOKEN"
```

Expected response (404):
```json
{
  "detail": "Meeting not found"
}
```

(Returns 404 instead of 403 to prevent meeting ID enumeration)

## Common Issues

### "Module boto3 not found"
```bash
docker compose up -d --build  # Rebuild to install new dependencies
```

### "MinIO bucket not found"
The bucket is auto-created on first upload. If issues persist:
```bash
docker compose exec minio mc mb local/meeting-audio
```

### "Celery task not executing"
```bash
# Check Celery worker is running
docker compose ps celery-worker

# Check for errors
docker compose logs celery-worker --tail=50

# Restart worker
docker compose restart celery-worker
```

### "Database connection error in Celery"
The Celery worker uses a synchronous database connection. Make sure the URL is correct:
```bash
docker compose exec celery-worker env | grep DATABASE
```

## API Documentation

View the upload endpoint in Swagger UI:
http://localhost:8000/docs#/meetings/upload_meeting_api_meetings_upload_post

## Security Checklist

✅ Authentication required (Azure AD JWT)
✅ File type validation (allowlist: .wav, .mp3)
✅ Content type validation
✅ No direct file paths exposed (blob storage)
✅ Signed URLs for audio playback
✅ Access control on meeting retrieval
✅ No user enumeration (404 for unauthorized access)
✅ Input validation on metadata JSON
✅ File size limits (500 MB max)

## Next Steps

After verifying upload works:
1. **Step 4**: Implement transcription worker (Whisper)
2. **Step 5**: Add speaker diarization (Pyannote)
3. **Step 6**: Add AI summarization (Claude)
4. **Step 7**: Complete read endpoints
