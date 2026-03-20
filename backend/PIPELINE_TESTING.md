# Pipeline Testing Guide (Steps 4-5)

Testing the Transcription and Diarisation workers.

## Prerequisites

1. **Docker Desktop** with WSL integration enabled
2. **HuggingFace token** (for Pyannote diarisation)
   - Get one at: https://huggingface.co/settings/tokens
   - Accept the Pyannote model terms: https://huggingface.co/pyannote/speaker-diarization-3.1

## Setup

### 1. Configure Environment

```bash
cd backend

# Copy example env and add your tokens
cp .env.example .env

# Edit .env and set:
# HF_TOKEN=hf_your_token_here
```

### 2. Start Services

```bash
docker compose up -d --build

# Check all services are running
docker compose ps
```

Expected services:
- meetings-postgres (port 5432)
- meetings-redis (port 6379)
- meetings-minio (port 9000, console 9001)
- meetings-api (port 8000)
- meetings-celery

### 3. Run Database Migrations

```bash
docker compose exec api alembic upgrade head
```

## Unit Tests

### Run All Tests

```bash
docker compose exec api pytest tests/ -v
```

### Run Specific Test Files

```bash
# Transcription tests
docker compose exec api pytest tests/test_transcription.py -v

# Diarisation tests
docker compose exec api pytest tests/test_diarisation.py -v
```

### Run with Coverage

```bash
docker compose exec api pytest tests/ --cov=app --cov-report=html
# Coverage report at htmlcov/index.html
```

## Integration Testing

### Step 4: Transcription Worker

Test transcription in isolation:

```python
# In Python shell (docker compose exec api python)
from app.services.transcription import transcribe_audio

# Test with a sample .wav file
result = transcribe_audio("/path/to/sample.wav")
print(f"Text: {result['text'][:100]}...")
print(f"Segments: {len(result['segments'])}")
```

### Step 5: Diarisation Worker

Test diarisation in isolation:

```python
# In Python shell
from app.services.diarisation import run_diarisation

# Test with a sample .wav file (requires HF_TOKEN)
segments = run_diarisation("/path/to/sample.wav")
print(f"Speaker segments: {len(segments)}")
for seg in segments[:5]:
    print(f"  {seg['speaker']}: {seg['start']:.1f}s - {seg['end']:.1f}s")
```

### Full Pipeline Test

1. **Upload a test audio file:**

```bash
# Get a test token (replace with your Azure AD setup or use mock)
TOKEN="your_jwt_token"

# Upload audio
curl -X POST http://localhost:8000/api/meetings/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "audio=@/path/to/test.wav" \
  -F 'metadata={"meeting_title": "Test Meeting", "attendees": [{"name": "John", "email": "john@test.com"}]}'
```

2. **Check Celery logs for pipeline progress:**

```bash
docker compose logs -f celery-worker
```

3. **Verify in database:**

```bash
docker compose exec postgres psql -U meetings_user -d meetings_db

# Check meeting status
SELECT id, title, status FROM meetings ORDER BY id DESC LIMIT 5;

# Check transcript
SELECT id, meeting_id, full_text,
       jsonb_array_length(segments) as segment_count
FROM transcripts ORDER BY id DESC LIMIT 5;

# Check if segments have speakers
SELECT segments->0 FROM transcripts ORDER BY id DESC LIMIT 1;
```

## Troubleshooting

### "HF_TOKEN environment variable required"

Set `HF_TOKEN` in your `.env` file with a valid HuggingFace token.

### "Model not found" errors

Accept the Pyannote model terms at:
https://huggingface.co/pyannote/speaker-diarization-3.1

### Whisper model download slow

First run downloads the Whisper model (~1.5GB for medium). This is cached in the container.

### Out of memory

Whisper and Pyannote are memory-intensive. Ensure Docker has at least 8GB RAM allocated.

For development, use smaller models:
```bash
# In .env
WHISPER_MODEL=tiny  # or base, small
```

### Celery tasks not running

```bash
# Check Celery worker status
docker compose logs celery-worker

# Restart worker
docker compose restart celery-worker
```

## Sample Audio Files

For testing, you can use:
- Your own meeting recordings (.wav format)
- Generated test audio with multiple speakers
- LibriSpeech samples: https://www.openslr.org/12

## Expected Results

After successful pipeline run:

1. **Meeting status**: Should progress through `processing` → `transcribing` → `diarising` → (later: `summarising`) → `complete`

2. **Transcript record**: Should have:
   - `full_text`: Complete transcription
   - `segments`: Array with speaker labels like:
     ```json
     [
       {"speaker": "Speaker 1", "start": 0.0, "end": 5.2, "text": "Hello everyone."},
       {"speaker": "Speaker 2", "start": 5.5, "end": 10.1, "text": "Hi, thanks for joining."}
     ]
     ```

## Next Steps

Once Steps 4-5 are verified:
1. Run Step 6 (Summarisation) tests
2. Test Claude API integration
3. Verify action items extraction
