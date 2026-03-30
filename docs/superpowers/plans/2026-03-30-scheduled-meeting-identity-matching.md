# Scheduled Meeting Identity Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe speaker identity matching for scheduled meetings by persisting attendee/organizer/current-user hints, mapping diarized speakers to real names only when confidence is sufficient, and preserving generic fallback labels when uncertain.

**Architecture:** Extend the scheduled-meeting metadata path from Electron to backend so meeting records store candidate identity hints at upload time. Then enrich transcript storage to keep both raw speaker identity and visible label, add a backend matching layer after transcription, and keep summary/action-item ownership aligned with the safe visible labels used in the transcript and exports.

**Tech Stack:** Electron + Next.js TypeScript bridge, FastAPI, SQLAlchemy, Alembic, Celery, AssemblyAI, OpenAI, pytest

---

## File Structure

**Create**
- `backend/alembic/versions/002_scheduled_meeting_identity_hints.py` - schema migration for meeting identity metadata, participant flags, and richer transcript segment storage support
- `backend/tests/test_identity_matching.py` - focused tests for candidate-pool building, confidence fallback, and transcript/action-item mapping behavior

**Modify**
- `desktop/src/main/graph.ts` - fetch organizer data from Graph calendar events and include it in the Electron calendar payload
- `desktop/tests/graph.test.ts` - verify organizer extraction and backward-compatible calendar mapping
- `desktop/src/renderer/preload-web.ts` - extend recording/upload metadata types exposed to the renderer
- `web/src/lib/electron-bridge.ts` - mirror richer meeting metadata contract in the web/Electron bridge
- `web/src/types/index.ts` - enrich `CalendarEvent`, `Participant`, `TranscriptSegment`, and meeting detail types for raw speaker id + visible label
- `web/src/components/RecordingPanel.tsx` - include organizer and scheduled-meeting context in upload metadata for selected calendar meetings
- `backend/app/models.py` - add meeting identity-hints JSON, participant flags / optional stable ids, and richer transcript segment expectations
- `backend/app/schemas.py` - expose organizer/current-user identity hints on upload metadata and enriched transcript segment shape on responses
- `backend/app/routers/meetings.py` - persist identity hints and return enriched transcript segments / participants
- `backend/app/services/diarisation.py` - replace simple `Speaker N` renaming with identity-aware matching plus safe fallback
- `backend/app/services/transcription.py` - preserve raw provider speaker ids and emit stable speaker keys for downstream matching
- `backend/app/services/summarisation.py` - keep summary/action-item owner extraction aligned with safe visible labels and optional matched participant refs
- `backend/tests/test_diarisation.py` - extend existing diarisation tests for raw-speaker preservation and fallback behavior
- `backend/tests/test_summarisation.py` - verify action-item ownership remains generic/unassigned on uncertain matches
- `backend/tests/test_read_endpoints.py` - verify enriched transcript response shape and participant metadata
- `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx` - render visible speaker labels from the enriched transcript structure without changing layout
- `web/src/components/ActionItemsTable.tsx` - keep owner display compatible with real-name or generic fallback labels

## Task 1: Extend Scheduled Meeting Metadata From Graph To Upload

**Files:**
- Modify: `desktop/src/main/graph.ts`
- Modify: `desktop/tests/graph.test.ts`
- Modify: `desktop/src/renderer/preload-web.ts`
- Modify: `web/src/lib/electron-bridge.ts`
- Modify: `web/src/types/index.ts`
- Modify: `web/src/components/RecordingPanel.tsx`

- [ ] **Step 1: Write the failing Graph mapping test**

```ts
it("maps organizer details from Graph calendar events", async () => {
  mockedAxios.get.mockResolvedValue({
    data: {
      value: [
        {
          id: "evt-1",
          subject: "AI Mission Catch Up",
          start: { dateTime: "2026-03-30T03:00:00" },
          end: { dateTime: "2026-03-30T04:30:00" },
          organizer: {
            emailAddress: {
              name: "Melissa Hall",
              address: "melissa.hall@factor1.com.au",
            },
          },
          attendees: [
            {
              emailAddress: {
                name: "Joseph Miguel Guerrero",
                address: "joseph.guerrero@factor1.com.au",
              },
            },
          ],
        },
      ],
    },
  });

  const meetings = await getUpcomingMeetings("token");

  expect(meetings[0].organizer).toEqual({
    name: "Melissa Hall",
    email: "melissa.hall@factor1.com.au",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop; npm test -- --runInBand graph.test.ts`
Expected: FAIL because `CalendarEvent` does not yet contain `organizer`

- [ ] **Step 3: Implement organizer support in Graph payload and bridge types**

```ts
export interface CalendarPerson {
  name: string;
  email: string;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: CalendarPerson[];
  organizer?: CalendarPerson | null;
}

// graph.ts mapping
organizer: evt.organizer?.emailAddress
  ? {
      name: (evt.organizer.emailAddress.name as string) ?? "",
      email: (evt.organizer.emailAddress.address as string) ?? "",
    }
  : null,
```

```ts
// preload-web.ts + electron-bridge.ts
metadata?: {
  meeting_title: string;
  attendees: { name: string; email?: string }[];
  scheduled_time?: string;
  organizer?: { name: string; email?: string } | null;
  source_event_id?: string;
}
```

- [ ] **Step 4: Pass scheduled-meeting organizer context from the recording panel**

```ts
const metadata = selectedMeeting
  ? {
      meeting_title: selectedMeeting.subject,
      attendees: selectedMeeting.attendees,
      scheduled_time: selectedMeeting.start,
      organizer: selectedMeeting.organizer ?? null,
      source_event_id: selectedMeeting.id,
    }
  : {
      meeting_title,
      attendees,
      scheduled_time,
    };
```

- [ ] **Step 5: Run desktop tests to verify the contract passes**

Run: `cd desktop; npm test -- --runInBand graph.test.ts ipc-devices.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add desktop/src/main/graph.ts desktop/tests/graph.test.ts desktop/src/renderer/preload-web.ts web/src/lib/electron-bridge.ts web/src/types/index.ts web/src/components/RecordingPanel.tsx
git commit -m "feat: include organizer in scheduled meeting metadata"
```

## Task 2: Persist Participants And Identity Hints In The Backend

**Files:**
- Create: `backend/alembic/versions/002_scheduled_meeting_identity_hints.py`
- Modify: `backend/app/models.py`
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/routers/meetings.py`
- Test: `backend/tests/test_read_endpoints.py`

- [ ] **Step 1: Write the failing API persistence test**

```python
async def test_upload_persists_identity_hints(async_client, auth_headers, sample_audio_file):
    metadata = {
        "meeting_title": "AI Mission Catch Up",
        "scheduled_time": "2026-03-30T11:00:00Z",
        "organizer": {
            "name": "Melissa Hall",
            "email": "melissa.hall@factor1.com.au",
        },
        "source_event_id": "evt-1",
        "attendees": [
            {
                "name": "Joseph Miguel Guerrero",
                "email": "joseph.guerrero@factor1.com.au",
            }
        ],
    }

    response = await async_client.post(
        "/api/meetings/upload",
        headers=auth_headers,
        files={"audio_file": ("sample.wav", sample_audio_file, "audio/wav")},
        data={"metadata": json.dumps(metadata)},
    )

    assert response.status_code == 200

    detail = await async_client.get(f"/api/meetings/{response.json()['meeting_id']}", headers=auth_headers)
    payload = detail.json()
    assert payload["identity_hints"]["source_event_id"] == "evt-1"
    assert payload["identity_hints"]["organizer"]["email"] == "melissa.hall@factor1.com.au"
    assert payload["identity_hints"]["current_user"]["azure_ad_id"] is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend; python -m pytest backend/tests/test_read_endpoints.py -k identity_hints -v`
Expected: FAIL because meeting detail has no `identity_hints` and upload schema rejects organizer/source-event fields

- [ ] **Step 3: Add schema and model support for persisted identity hints**

```python
# models.py
class Meeting(Base):
    ...
    identity_hints = Column(JSONB, nullable=True)

class Participant(Base):
    ...
    azure_ad_id = Column(String, nullable=True, index=True)
    is_organizer = Column(Boolean, nullable=False, default=False)
```

```python
# schemas.py
class IdentityPerson(BaseModel):
    name: str
    email: Optional[EmailStr] = None
    azure_ad_id: Optional[str] = None
    is_organizer: bool = False
    is_current_user: bool = False

class MeetingUploadMetadata(BaseModel):
    meeting_title: str
    attendees: List[ParticipantBase] = Field(..., min_length=1)
    scheduled_time: Optional[datetime] = None
    organizer: Optional[ParticipantBase] = None
    source_event_id: Optional[str] = None
```

- [ ] **Step 4: Add the Alembic migration**

```python
def upgrade() -> None:
    op.add_column("meetings", sa.Column("identity_hints", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("participants", sa.Column("azure_ad_id", sa.String(), nullable=True))
    op.add_column("participants", sa.Column("is_organizer", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index(op.f("ix_participants_azure_ad_id"), "participants", ["azure_ad_id"], unique=False)

def downgrade() -> None:
    op.drop_index(op.f("ix_participants_azure_ad_id"), table_name="participants")
    op.drop_column("participants", "is_organizer")
    op.drop_column("participants", "azure_ad_id")
    op.drop_column("meetings", "identity_hints")
```

- [ ] **Step 5: Persist current-user and organizer hints during upload**

```python
identity_hints = {
    "source_event_id": meeting_metadata.source_event_id,
    "current_user": {
        "name": current_user.name,
        "email": current_user.email,
        "azure_ad_id": current_user.azure_ad_id,
        "is_current_user": True,
    },
    "organizer": (
        {
            "name": meeting_metadata.organizer.name,
            "email": meeting_metadata.organizer.email,
            "is_organizer": True,
        }
        if meeting_metadata.organizer else None
    ),
    "candidates": [],
}

meeting = Meeting(
    ...,
    identity_hints=identity_hints,
)
```

```python
for attendee in meeting_metadata.attendees:
    db.add(Participant(
        meeting_id=meeting.id,
        name=attendee.name,
        email=attendee.email,
        is_organizer=(
            meeting_metadata.organizer is not None
            and attendee.email == meeting_metadata.organizer.email
        ),
    ))
```

- [ ] **Step 6: Return identity hints in meeting detail**

```python
class MeetingDetailResponse(BaseModel):
    ...
    identity_hints: Optional[dict] = None
```

```python
return MeetingDetailResponse(
    ...,
    participants=[...],
    identity_hints=meeting.identity_hints,
    transcript=transcript,
    summary=summary,
    action_items=[...],
)
```

- [ ] **Step 7: Run migration and backend tests**

Run: `cd backend; alembic upgrade head`
Expected: migration applies cleanly

Run: `cd backend; python -m pytest backend/tests/test_read_endpoints.py backend/tests/test_delete_meeting.py -v`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/alembic/versions/002_scheduled_meeting_identity_hints.py backend/app/models.py backend/app/schemas.py backend/app/routers/meetings.py backend/tests/test_read_endpoints.py
git commit -m "feat: persist meeting identity hints"
```

## Task 3: Preserve Raw Speaker Identity And Add Safe Matching

**Files:**
- Create: `backend/tests/test_identity_matching.py`
- Modify: `backend/app/services/transcription.py`
- Modify: `backend/app/services/diarisation.py`
- Modify: `backend/app/services/pipeline.py`
- Modify: `backend/tests/test_diarisation.py`

- [ ] **Step 1: Write the failing identity-matching tests**

```python
def test_match_speakers_uses_real_name_on_confident_match(db_session, test_meeting):
    from app.services.diarisation import match_speakers_to_candidates

    segments = [
        {"raw_speaker": "A", "speaker_key": "speaker_1", "speaker": "Speaker 1", "text": "I'll send the report"},
        {"raw_speaker": "B", "speaker_key": "speaker_2", "speaker": "Speaker 2", "text": "Thanks"},
    ]
    candidates = [
        {"display_name": "Joseph Miguel Guerrero", "email": "joseph.guerrero@factor1.com.au", "is_current_user": True},
        {"display_name": "Melissa Hall", "email": "melissa.hall@factor1.com.au", "is_organizer": True},
    ]

    mapped = match_speakers_to_candidates(segments, candidates, confidence_floor=0.8)

    assert mapped[0]["display_speaker"] == "Joseph Miguel Guerrero"
    assert mapped[1]["display_speaker"] == "Speaker 2"
```

```python
def test_process_diarisation_preserves_raw_speaker_and_visible_label(db_session, test_meeting):
    from app.services.diarisation import process_diarisation

    test_meeting.identity_hints = {
        "current_user": {
            "name": "Joseph Miguel Guerrero",
            "email": "joseph.guerrero@factor1.com.au",
            "azure_ad_id": "user-1",
            "is_current_user": True,
        },
        "organizer": None,
        "candidates": [],
    }
    db_session.commit()

    transcript = Transcript(
        meeting_id=test_meeting.id,
        full_text="Hello",
        segments=[{"speaker": "A", "start": 0.0, "end": 1.0, "text": "Hello"}],
    )
    db_session.add(transcript)
    db_session.commit()

    updated = process_diarisation(db_session, test_meeting.id)

    assert updated.segments[0]["raw_speaker"] == "A"
    assert updated.segments[0]["speaker_key"] == "speaker_1"
    assert updated.segments[0]["speaker"] in {"Joseph Miguel Guerrero", "Speaker 1"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend; python -m pytest backend/tests/test_identity_matching.py backend/tests/test_diarisation.py -v`
Expected: FAIL because segments do not yet preserve `raw_speaker` / `speaker_key` and no matching helpers exist

- [ ] **Step 3: Preserve raw speaker ids during transcription**

```python
segments.append({
    "raw_speaker": utterance.speaker,
    "speaker_key": f"speaker_{speaker_order.setdefault(utterance.speaker, len(speaker_order) + 1)}",
    "speaker": utterance.speaker,
    "start": utterance.start / 1000.0,
    "end": utterance.end / 1000.0,
    "text": utterance.text.strip(),
})
```

- [ ] **Step 4: Implement candidate-pool building and safe speaker matching**

```python
def build_candidate_pool(meeting: Meeting) -> list[dict[str, Any]]:
    participants = [
        {
            "display_name": p.name,
            "email": p.email,
            "azure_ad_id": p.azure_ad_id,
            "is_organizer": p.is_organizer,
            "is_current_user": False,
        }
        for p in meeting.participants
    ]
    hints = meeting.identity_hints or {}
    current_user = hints.get("current_user")
    organizer = hints.get("organizer")
    return dedupe_candidates(participants, organizer, current_user)

def apply_safe_labels(segments: list[dict[str, Any]], speaker_mapping: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    labeled = []
    for segment in segments:
        match = speaker_mapping.get(segment["speaker_key"])
        display = match["display_name"] if match and match["confidence"] >= 0.8 else segment["speaker_key"].replace("_", " ").title()
        labeled.append({
            **segment,
            "matched_participant_email": match["email"] if match and match["confidence"] >= 0.8 else None,
            "matched_participant_azure_ad_id": match["azure_ad_id"] if match and match["confidence"] >= 0.8 else None,
            "speaker": display if not display.startswith("Speaker Key") else fallback_label(segment["speaker_key"]),
        })
    return labeled
```

- [ ] **Step 5: Keep pipeline semantics unchanged while swapping in matching**

```python
# pipeline.py stays:
transcribe_meeting(meeting_id)
diarize_meeting(meeting_id)
summarise_meeting(meeting_id)

# diarisation.py now:
candidate_pool = build_candidate_pool(meeting)
speaker_mapping = match_speakers_to_candidates(transcript.segments or [], candidate_pool)
final_segments = apply_safe_labels(transcript.segments or [], speaker_mapping)
```

- [ ] **Step 6: Run backend diarisation tests**

Run: `cd backend; python -m pytest backend/tests/test_identity_matching.py backend/tests/test_diarisation.py backend/tests/test_transcription.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/transcription.py backend/app/services/diarisation.py backend/app/services/pipeline.py backend/tests/test_identity_matching.py backend/tests/test_diarisation.py
git commit -m "feat: add safe scheduled meeting speaker matching"
```

## Task 4: Keep Summary, Action Items, And API Responses Aligned With Safe Labels

**Files:**
- Modify: `backend/app/schemas.py`
- Modify: `backend/app/services/summarisation.py`
- Modify: `backend/tests/test_summarisation.py`
- Modify: `backend/tests/test_read_endpoints.py`
- Modify: `web/src/types/index.ts`
- Modify: `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`
- Modify: `web/src/components/ActionItemsTable.tsx`

- [ ] **Step 1: Write the failing summary/action-item safety test**

```python
def test_save_summary_keeps_unmatched_owner_generic(db_session, test_meeting):
    from app.services.summarisation import save_summary

    summarisation_result = {
        "summary": "Test summary",
        "key_points": [],
        "action_items": [
            {
                "description": "Check device settings",
                "owner": "Speaker 2",
                "due_date": None,
            }
        ],
        "follow_ups": [],
    }

    _, action_items = save_summary(db_session, test_meeting.id, summarisation_result)

    assert action_items[0].owner_name == "Speaker 2"
    assert action_items[0].owner_email is None
```

```python
async def test_meeting_detail_returns_enriched_segments(async_client, auth_headers, seeded_meeting):
    response = await async_client.get(f"/api/meetings/{seeded_meeting.id}", headers=auth_headers)
    segment = response.json()["transcript"]["segments"][0]
    assert "raw_speaker" in segment
    assert "speaker_key" in segment
    assert "speaker" in segment
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend; python -m pytest backend/tests/test_summarisation.py backend/tests/test_read_endpoints.py -k \"speaker or enriched\" -v`
Expected: FAIL because transcript schema only exposes `speaker/start/end/text`

- [ ] **Step 3: Expand transcript schemas and keep owner mapping conservative**

```python
class TranscriptSegment(BaseModel):
    speaker: str
    start: float
    end: float
    text: str
    raw_speaker: Optional[str] = None
    speaker_key: Optional[str] = None
    matched_participant_email: Optional[EmailStr] = None
    matched_participant_azure_ad_id: Optional[str] = None
```

```python
if item.get("owner") and item["owner"].startswith("Speaker "):
    owner_name = item["owner"]
    owner_email = None
else:
    owner_name = item.get("owner")
    owner_email = lookup_participant_email(meeting_id, owner_name, db)
```

- [ ] **Step 4: Keep frontend rendering on visible labels only**

```ts
export interface TranscriptSegment {
  speaker: string; // visible display label
  raw_speaker?: string | null;
  speaker_key?: string | null;
  matched_participant_email?: string | null;
  matched_participant_azure_ad_id?: string | null;
  start: number;
  end: number;
  text: string;
}
```

```tsx
<span className={`text-sm font-semibold ${speakerColors[seg.speaker] || "text-[color:var(--text-secondary)]"}`}>
  {seg.speaker}
</span>
```

- [ ] **Step 5: Run backend and web contract tests**

Run: `cd backend; python -m pytest backend/tests/test_summarisation.py backend/tests/test_read_endpoints.py -v`
Expected: PASS

Run: `cd web; npx next lint --file src/types/index.ts --file \"src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx\" --file src/components/ActionItemsTable.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/app/schemas.py backend/app/services/summarisation.py backend/tests/test_summarisation.py backend/tests/test_read_endpoints.py web/src/types/index.ts "web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx" web/src/components/ActionItemsTable.tsx
git commit -m "feat: align transcript and action items with safe speaker labels"
```

## Task 5: Final Verification And Demo Readiness

**Files:**
- Modify: none
- Test: `backend/tests/test_identity_matching.py`
- Test: `backend/tests/test_diarisation.py`
- Test: `backend/tests/test_summarisation.py`
- Test: `backend/tests/test_read_endpoints.py`
- Test: `desktop/tests/graph.test.ts`
- Test: `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`

- [ ] **Step 1: Run the full backend test suite**

Run: `cd backend; python -m pytest`
Expected: PASS

- [ ] **Step 2: Run the desktop test suite**

Run: `cd desktop; npm test -- --runInBand`
Expected: PASS

- [ ] **Step 3: Run Electron build verification**

Run: `cd desktop; npm run build:electron`
Expected: PASS

- [ ] **Step 4: Run web lint and build verification**

Run: `cd web; npm run lint`
Expected: PASS

Run: `cd web; npm run build`
Expected: PASS

- [ ] **Step 5: Perform manual scheduled-meeting smoke test**

Run:

```bash
cd backend
docker compose up -d
docker compose exec api alembic upgrade head

cd ../desktop
npm run dev
```

Expected:
- select a scheduled meeting
- complete recording/upload
- meeting detail reaches `complete`
- transcript shows real display names only on confident matches
- uncertain speakers remain `Speaker N`
- action items do not assign a real person when the transcript label stayed generic

- [ ] **Step 6: Commit**

```bash
git status --short
```

Expected: no unverified identity-matching changes remain uncommitted

## Self-Review

- **Spec coverage:** The plan covers Graph organizer/current-user capture, persistence of identity hints, raw-speaker preservation, safe matching rules, transcript/action-item alignment, and verification. No spec sections are unassigned.
- **Placeholder scan:** No `TODO` / `TBD` placeholders remain in tasks. All file paths, commands, and example code are explicit.
- **Type consistency:** The plan uses `organizer`, `source_event_id`, `identity_hints`, `raw_speaker`, `speaker_key`, and visible `speaker` consistently across Electron, backend schemas, transcript storage, and frontend response types.
