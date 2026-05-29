# Diarization Review and Action Ownership Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a speaker review fallback and action-owner confidence layer so Notetaker can be honest about uncertain diarization, let users quickly map speakers to attendees, and use those mappings to improve action ownership.

**Architecture:** Keep raw AssemblyAI transcript speaker labels as source of truth, add `speaker_mappings` as the resolved identity layer, and resolve transcript display/action owners from mappings at API/UI boundaries. Implement backend models/services/API first with tests, then add a meeting-detail speaker review UI, then add diagnostics and docs.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, Pydantic, pytest, Next.js 14, React 18, Vitest/Testing Library, TypeScript.

**Design Spec:** `docs/superpowers/specs/2026-05-29-diarization-review-action-ownership-design.md`

---

## Global implementation rules

1. Keep existing desktop record/upload workflow intact.
2. Do not add Teams bot work in this implementation.
3. Preserve raw transcript segments; do not destructively rewrite `Transcript.segments` just to display mapped names.
4. User corrections are authoritative for the meeting.
5. Automatic logic must not overwrite `user_corrected` speaker mappings or action owner fields.
6. Use TDD for every behavior change.
7. Commit after each completed task or small task group.
8. If backend pytest is unavailable in the local shell, create/use a venv rather than skipping tests:

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-base.txt
pytest
```

---

## Phase 1: Backend data model

### Task 1: Add speaker mapping model and ownership metadata fields

**Objective:** Add persistent storage for resolved speaker identities and action-owner confidence metadata.

**Files:**
- Modify: `backend/app/models.py`
- Test: no direct unit test yet; migration tests come next.

**Step 1: Update imports**

In `backend/app/models.py`, add `Float`, `UniqueConstraint`, and any needed constraints imports from SQLAlchemy.

**Step 2: Add enum classes**

Add these near existing enums:

```python
class SpeakerMappingSource(str, enum.Enum):
    ASSEMBLYAI = "assemblyai"
    LLM_INFERENCE = "llm_inference"
    USER_CORRECTED = "user_corrected"


class ActionOwnerSource(str, enum.Enum):
    SPEAKER_MAPPING = "speaker_mapping"
    EXPLICIT_NAME_MATCH = "explicit_name_match"
    LLM_EXTRACTION = "llm_extraction"
    USER_CORRECTED = "user_corrected"
    UNASSIGNED = "unassigned"
```

**Step 3: Add Meeting fields**

Add to `Meeting`:

```python
needs_speaker_review = Column(Boolean, default=False, nullable=False, index=True)
speaker_review_completed_at = Column(DateTime, nullable=True)
speaker_mapping_quality = Column(Float, nullable=True)
diarization_diagnostics = Column(JSONType, nullable=True)
```

**Step 4: Add relationship**

Add to `Meeting` relationships:

```python
speaker_mappings = relationship("SpeakerMapping", back_populates="meeting", cascade="all, delete-orphan")
```

**Step 5: Add ActionItem ownership fields**

Add to `ActionItem`:

```python
owner_confidence = Column(Float, nullable=True)
owner_source = Column(Enum(ActionOwnerSource, values_callable=lambda e: [x.value for x in e]), nullable=True, index=True)
owner_reason = Column(Text, nullable=True)
```

`owner_email` already exists; keep it.

**Step 6: Add SpeakerMapping model**

Add after `Transcript` or before `Summary`:

```python
class SpeakerMapping(Base):
    """Resolved identity for a raw transcript speaker label in one meeting."""
    __tablename__ = "speaker_mappings"
    __table_args__ = (
        UniqueConstraint("meeting_id", "speaker_label", name="uq_speaker_mappings_meeting_label"),
    )

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False, index=True)
    speaker_label = Column(String, nullable=False)
    display_name = Column(String, nullable=True)
    email = Column(String, nullable=True)
    confidence = Column(Float, default=0.0, nullable=False)
    source = Column(Enum(SpeakerMappingSource, values_callable=lambda e: [x.value for x in e]), nullable=False, index=True)
    reason = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    meeting = relationship("Meeting", back_populates="speaker_mappings")
```

**Step 7: Syntax check**

Run:

```bash
cd backend
python3 -m py_compile app/models.py
```

Expected: no output.

**Step 8: Commit**

```bash
git add backend/app/models.py
git commit -m "feat: add speaker mapping data model"
```

---

### Task 2: Add Alembic migration for speaker mappings

**Objective:** Add database migration for the new table and columns.

**Files:**
- Create: `backend/alembic/versions/004_add_speaker_mappings_and_owner_confidence.py`
- Test: `backend/tests/test_migrations.py`

**Step 1: Write migration file**

Create `backend/alembic/versions/004_add_speaker_mappings_and_owner_confidence.py` with revision ID `004_add_speaker_mappings_and_owner_confidence`, down_revision `003_add_speaker_identified_to_transcripts`.

Migration must:

- Add `meetings.needs_speaker_review` boolean default false, not null.
- Add `meetings.speaker_review_completed_at` datetime nullable.
- Add `meetings.speaker_mapping_quality` float nullable.
- Add `meetings.diarization_diagnostics` JSON nullable.
- Add `action_items.owner_confidence` float nullable.
- Add `action_items.owner_source` enum/string compatible column nullable.
- Add `action_items.owner_reason` text nullable.
- Create `speaker_mappings` table.
- Add unique constraint on `(meeting_id, speaker_label)`.
- Add indexes for `meeting_id` and `source`.

Follow existing migration style in `001_initial_schema.py`, `002_*`, `003_*`.

**Step 2: Add migration test**

In `backend/tests/test_migrations.py`, add/extend a test that asserts the new migration file exists and includes:

- `speaker_mappings`
- `needs_speaker_review`
- `owner_confidence`
- `uq_speaker_mappings_meeting_label`

**Step 3: Run migration tests**

Run:

```bash
cd backend
pytest tests/test_migrations.py -v
```

Expected: PASS.

If pytest is unavailable, create the venv from the global implementation rules first.

**Step 4: Commit**

```bash
git add backend/alembic/versions/004_add_speaker_mappings_and_owner_confidence.py backend/tests/test_migrations.py
git commit -m "feat: add speaker mapping migration"
```

---

### Task 3: Add Pydantic schemas for speaker mappings and ownership confidence

**Objective:** Expose speaker mapping and confidence data through typed request/response models.

**Files:**
- Modify: `backend/app/schemas.py`
- Test: `backend/tests/test_speaker_mappings.py`

**Step 1: Write failing schema tests**

Create `backend/tests/test_speaker_mappings.py` with tests for:

```python
def test_speaker_mapping_update_request_validates_confidence_range():
    SpeakerMappingUpdate(speaker_label="Speaker A", confidence=0.0)
    SpeakerMappingUpdate(speaker_label="Speaker A", confidence=1.0)
    with pytest.raises(ValidationError):
        SpeakerMappingUpdate(speaker_label="Speaker A", confidence=1.1)


def test_speaker_mapping_update_request_accepts_unknown_mapping():
    update = SpeakerMappingUpdate(
        speaker_label="Speaker A",
        display_name=None,
        email=None,
        confidence=0.0,
        reason="User left this speaker unknown",
    )
    assert update.display_name is None
    assert update.confidence == 0.0


def test_action_item_response_includes_owner_confidence_fields():
    item = ActionItemResponse(
        id=1,
        meeting_id=10,
        description="Send the draft report",
        owner_name="Joseph Guerrero",
        owner_email="joseph@example.com",
        owner_confidence=0.91,
        owner_source="speaker_mapping",
        owner_reason="Speaker mapping matched Joseph",
        due_date=None,
        status="open",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    assert item.owner_confidence == 0.91
    assert item.owner_source == "speaker_mapping"
```

Expected initially: FAIL because schemas do not exist/fields missing.

**Step 2: Add schemas**

In `backend/app/schemas.py`, add:

```python
class SpeakerMappingResponse(BaseModel):
    id: int
    meeting_id: int
    speaker_label: str
    display_name: Optional[str] = None
    email: Optional[EmailStr] = None
    confidence: float = Field(..., ge=0.0, le=1.0)
    source: str
    reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class SpeakerMappingUpdate(BaseModel):
    speaker_label: str = Field(..., min_length=1, max_length=100)
    display_name: Optional[str] = Field(None, max_length=200)
    email: Optional[EmailStr] = None
    confidence: float = Field(1.0, ge=0.0, le=1.0)
    source: str = "user_corrected"
    reason: Optional[str] = Field(None, max_length=500)


class SpeakerMappingListResponse(BaseModel):
    items: List[SpeakerMappingResponse]
    needs_speaker_review: bool
    speaker_mapping_quality: Optional[float] = None
```

Add meeting detail fields:

```python
needs_speaker_review: bool = False
speaker_review_completed_at: Optional[datetime] = None
speaker_mapping_quality: Optional[float] = None
diarization_diagnostics: Optional[dict] = None
speaker_mappings: List[SpeakerMappingResponse] = Field(default_factory=list)
```

Extend `ActionItemBase` or `ActionItemResponse` with:

```python
owner_confidence: Optional[float] = None
owner_source: Optional[str] = None
owner_reason: Optional[str] = None
```

**Step 3: Run schema tests**

```bash
cd backend
pytest tests/test_speaker_mappings.py -v
```

Expected: PASS.

**Step 4: Commit**

```bash
git add backend/app/schemas.py backend/tests/test_speaker_mappings.py
git commit -m "feat: add speaker mapping schemas"
```

---

## Phase 2: Backend speaker mapping and owner resolution services

### Task 4: Extract candidate-pool builder into a reusable service

**Objective:** Reuse candidate identity building across speaker mapping and owner resolution.

**Files:**
- Create: `backend/app/services/identity_candidates.py`
- Modify: `backend/app/services/speaker_inference.py`
- Test: `backend/tests/test_identity_candidates.py`

**Step 1: Write failing tests**

Create tests for:

- dedupe by email
- mark current user as recorder
- mark organizer
- ignore malformed `identity_hints`
- preserve candidates without email

**Step 2: Implement service**

Move or wrap current `build_candidate_pool()` logic from `speaker_inference.py` into `identity_candidates.py`.

Use function:

```python
def build_candidate_pool(participants: list, identity_hints: dict | None) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen_emails: set[str] = set()

    for participant in participants:
        email = (getattr(participant, "email", None) or "").strip().lower()
        if email and email in seen_emails:
            continue
        candidates.append({
            "display_name": getattr(participant, "name", ""),
            "email": getattr(participant, "email", None),
            "is_organizer": bool(getattr(participant, "is_organizer", False)),
            "is_recorder": False,
        })
        if email:
            seen_emails.add(email)

    hints = identity_hints if isinstance(identity_hints, dict) else {}
    # Add or mark current_user and organizer using the same email-dedupe rule.
    # Keep this implementation small and covered by tests; do not add cross-meeting memory.
    return candidates
```

Keep current behavior but normalize blank emails and guard malformed hints.

**Step 3: Update speaker_inference import**

In `speaker_inference.py`, import `build_candidate_pool` from the new service and remove duplicate implementation.

**Step 4: Run tests**

```bash
cd backend
pytest tests/test_identity_candidates.py tests/test_speaker_inference.py -v
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/services/identity_candidates.py backend/app/services/speaker_inference.py backend/tests/test_identity_candidates.py
git commit -m "refactor: share identity candidate builder"
```

---

### Task 5: Add speaker mapping service

**Objective:** Generate and persist speaker mappings from transcript segments and inference outputs.

**Files:**
- Create: `backend/app/services/speaker_mapping.py`
- Test: `backend/tests/test_speaker_mapping_service.py`

**Step 1: Write failing tests**

Test these behaviors:

1. Extract distinct labels from segments.
2. Calculate mapping quality average from mappings.
3. Preserve `user_corrected` mapping when applying AI mappings.
4. Mark `needs_speaker_review` when major labels are unmapped or low confidence.
5. Mark review not needed when all labels are confidently mapped.

**Step 2: Implement helper functions**

Create:

```python
def extract_speaker_labels(segments: list[dict]) -> list[str]:
    labels: list[str] = []
    for segment in segments or []:
        label = (segment.get("speaker") or "").strip()
        if label and label not in labels:
            labels.append(label)
    return labels


def calculate_mapping_quality(mappings: list[SpeakerMapping]) -> float | None:
    if not mappings:
        return None
    return sum(float(m.confidence or 0.0) for m in mappings) / len(mappings)


def should_require_review(labels: list[str], mappings_by_label: dict[str, SpeakerMapping], threshold: float = 0.7) -> bool:
    for label in labels:
        mapping = mappings_by_label.get(label)
        if mapping is None:
            return True
        if mapping.source != SpeakerMappingSource.USER_CORRECTED and float(mapping.confidence or 0.0) < threshold:
            return True
    return False
```

**Step 3: Implement persistence function**

Create:

```python
def upsert_speaker_mappings(
    db: Session,
    meeting: Meeting,
    proposed: list[dict[str, Any]],
    source: SpeakerMappingSource,
    preserve_user_corrected: bool = True,
) -> list[SpeakerMapping]:
    existing = {
        m.speaker_label: m
        for m in db.query(SpeakerMapping).filter(SpeakerMapping.meeting_id == meeting.id).all()
    }
    saved: list[SpeakerMapping] = []
    for item in proposed:
        label = item["speaker_label"]
        mapping = existing.get(label)
        if mapping and preserve_user_corrected and mapping.source == SpeakerMappingSource.USER_CORRECTED and source != SpeakerMappingSource.USER_CORRECTED:
            saved.append(mapping)
            continue
        if mapping is None:
            mapping = SpeakerMapping(meeting_id=meeting.id, speaker_label=label, source=source)
            db.add(mapping)
        mapping.display_name = item.get("display_name")
        mapping.email = item.get("email")
        mapping.confidence = float(item.get("confidence") or 0.0)
        mapping.source = source
        mapping.reason = item.get("reason")
        saved.append(mapping)
    return saved
```

Rules:

- Existing `user_corrected` mapping wins unless source is also `USER_CORRECTED`.
- Upsert by `meeting_id + speaker_label`.
- Update meeting diagnostics and `needs_speaker_review`.

**Step 4: Run tests**

```bash
cd backend
pytest tests/test_speaker_mapping_service.py -v
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/services/speaker_mapping.py backend/tests/test_speaker_mapping_service.py
git commit -m "feat: add speaker mapping service"
```

---

### Task 6: Add action owner resolution service

**Objective:** Resolve action owner name/email/confidence/source from speaker mappings, candidates, and extracted owner text.

**Files:**
- Create: `backend/app/services/action_owner_resolution.py`
- Test: `backend/tests/test_action_owner_resolution.py`

**Step 1: Write failing tests**

Tests:

1. `user_corrected` owner is preserved.
2. Speaker mapping owner resolves email and confidence.
3. Explicit name match resolves to candidate email.
4. LLM owner with no candidate remains name-only low/medium confidence.
5. Empty/unknown owner becomes unassigned.

**Step 2: Implement owner resolution**

Create:

```python
def resolve_action_owner(
    extracted_owner: str | None,
    speaker_label: str | None,
    candidates: list[dict[str, Any]],
    mappings_by_label: dict[str, SpeakerMapping],
) -> dict[str, Any]:
    if speaker_label and speaker_label in mappings_by_label:
        mapping = mappings_by_label[speaker_label]
        if mapping.display_name:
            return {
                "owner_name": mapping.display_name,
                "owner_email": mapping.email,
                "owner_confidence": mapping.confidence,
                "owner_source": ActionOwnerSource.SPEAKER_MAPPING,
                "owner_reason": f"Resolved from speaker mapping for {speaker_label}",
            }

    normalized_owner = (extracted_owner or "").strip().lower()
    if normalized_owner and normalized_owner not in {"unassigned", "unknown", "none"}:
        for candidate in candidates:
            if normalized_owner == (candidate.get("display_name") or "").strip().lower():
                return {
                    "owner_name": candidate.get("display_name"),
                    "owner_email": candidate.get("email"),
                    "owner_confidence": 0.8,
                    "owner_source": ActionOwnerSource.EXPLICIT_NAME_MATCH,
                    "owner_reason": "Owner text matched a meeting participant",
                }
        return {
            "owner_name": extracted_owner,
            "owner_email": None,
            "owner_confidence": 0.5,
            "owner_source": ActionOwnerSource.LLM_EXTRACTION,
            "owner_reason": "Owner came from summary extraction but did not match an attendee",
        }

    return {
        "owner_name": None,
        "owner_email": None,
        "owner_confidence": 0.0,
        "owner_source": ActionOwnerSource.UNASSIGNED,
        "owner_reason": "No owner could be resolved",
    }
```

Return keys:

- `owner_name`
- `owner_email`
- `owner_confidence`
- `owner_source`
- `owner_reason`

**Step 3: Implement action item re-resolution**

Create:

```python
def resolve_action_item_owners_for_meeting(db: Session, meeting_id: int) -> list[ActionItem]:
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).one()
    candidates = build_candidate_pool(meeting.participants, meeting.identity_hints)
    mappings_by_label = {m.speaker_label: m for m in meeting.speaker_mappings}
    changed: list[ActionItem] = []
    for item in meeting.action_items:
        if item.owner_source == ActionOwnerSource.USER_CORRECTED:
            continue
        resolved = resolve_action_owner(item.owner_name, None, candidates, mappings_by_label)
        item.owner_name = resolved["owner_name"]
        item.owner_email = resolved["owner_email"]
        item.owner_confidence = resolved["owner_confidence"]
        item.owner_source = resolved["owner_source"]
        item.owner_reason = resolved["owner_reason"]
        changed.append(item)
    db.commit()
    return changed
```

Rules:

- Do not overwrite `owner_source == USER_CORRECTED`.
- Use transcript/speaker mappings/candidates where available.
- Commit changes in one transaction.

**Step 4: Run tests**

```bash
cd backend
pytest tests/test_action_owner_resolution.py -v
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/services/action_owner_resolution.py backend/tests/test_action_owner_resolution.py
git commit -m "feat: resolve action owner confidence"
```

---

### Task 7: Integrate speaker mappings into transcription pipeline

**Objective:** Persist mapping diagnostics after transcription completes.

**Files:**
- Modify: `backend/app/services/transcription.py`
- Test: `backend/tests/test_transcription.py`

**Step 1: Write failing test**

Add a test that processes/saves a transcript with generic speakers and participants, then expects:

- `meeting.needs_speaker_review` set when mappings are absent/low-confidence
- `meeting.diarization_diagnostics.detected_speaker_count` set
- no destructive rewrite of `Transcript.segments`

**Step 2: Integrate service**

After `save_transcript()` or inside `process_transcription()` after transcript save:

- extract labels from segments
- create initial diagnostics
- if AssemblyAI speaker identification produced names, propose mappings with source `assemblyai`
- otherwise mark review needed based on unmapped labels

If current code cannot distinguish AssemblyAI named speakers vs generic labels, use a conservative rule:

- any label that matches a participant/candidate display name can become `assemblyai` mapping
- generic labels remain unmapped

**Step 3: Run tests**

```bash
cd backend
pytest tests/test_transcription.py tests/test_speaker_mapping_service.py -v
```

Expected: PASS.

**Step 4: Commit**

```bash
git add backend/app/services/transcription.py backend/tests/test_transcription.py
git commit -m "feat: track diarization review needs after transcription"
```

---

### Task 8: Integrate owner confidence into summarisation save

**Objective:** Save action owner confidence fields when summaries/action items are created.

**Files:**
- Modify: `backend/app/services/summarisation.py`
- Test: `backend/tests/test_summarisation.py`

**Step 1: Write failing test**

Add a test where LLM returns action item owner matching a participant. Expect saved action item includes:

- `owner_name`
- `owner_email`
- `owner_confidence`
- `owner_source`

**Step 2: Modify `save_summary()`**

When creating each `ActionItem`, call the owner resolution helper. Keep existing owner fallback if helper cannot resolve.

Set:

```python
owner_name=resolved["owner_name"]
owner_email=resolved["owner_email"]
owner_confidence=resolved["owner_confidence"]
owner_source=resolved["owner_source"]
owner_reason=resolved["owner_reason"]
```

**Step 3: Run tests**

```bash
cd backend
pytest tests/test_summarisation.py tests/test_action_owner_resolution.py -v
```

Expected: PASS.

**Step 4: Commit**

```bash
git add backend/app/services/summarisation.py backend/tests/test_summarisation.py
git commit -m "feat: save action owner confidence"
```

---

## Phase 3: Backend API endpoints and meeting detail response

### Task 9: Add speaker mapping API routes

**Objective:** Let frontend fetch/save speaker mappings for a meeting.

**Files:**
- Modify: `backend/app/routers/meetings.py`
- Test: `backend/tests/test_speaker_mapping_routes.py`

**Step 1: Write failing route tests**

Tests:

- GET mappings for owned meeting returns mappings and quality fields.
- GET mappings for another user returns 404.
- PUT user-corrected mapping creates/updates mapping.
- PUT rejects speaker label not present in transcript.
- PUT triggers action owner re-resolution.

**Step 2: Implement helper**

In `meetings.py`, add helper:

```python
async def get_owned_meeting_or_404(db: AsyncSession, meeting_id: int, current_user: User) -> Meeting:
    result = await db.execute(
        select(Meeting).where(Meeting.id == meeting_id, Meeting.user_id == current_user.id)
    )
    meeting = result.scalar_one_or_none()
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")
    return meeting
```

If async route uses `AsyncSession`, implement async helper matching current route style.

**Step 3: Add GET endpoint**

```python
@router.get("/{meeting_id}/speaker-mappings", response_model=SpeakerMappingListResponse)
async def get_speaker_mappings(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SpeakerMappingListResponse:
    meeting = await get_owned_meeting_or_404(db, meeting_id, current_user)
    mappings = await load_speaker_mappings_for_meeting(db, meeting.id)
    return SpeakerMappingListResponse(
        items=mappings,
        needs_speaker_review=meeting.needs_speaker_review,
        speaker_mapping_quality=meeting.speaker_mapping_quality,
    )
```

**Step 4: Add PUT endpoint**

```python
@router.put("/{meeting_id}/speaker-mappings", response_model=SpeakerMappingListResponse)
async def update_speaker_mappings(
    meeting_id: int,
    updates: list[SpeakerMappingUpdate],
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> SpeakerMappingListResponse:
    meeting = await get_owned_meeting_or_404(db, meeting_id, current_user)
    await validate_speaker_labels_exist(db, meeting.id, [u.speaker_label for u in updates])
    await save_user_corrected_mappings(db, meeting, updates)
    await resolve_action_owners_for_meeting_async(db, meeting.id)
    await db.refresh(meeting)
    mappings = await load_speaker_mappings_for_meeting(db, meeting.id)
    return SpeakerMappingListResponse(items=mappings, needs_speaker_review=meeting.needs_speaker_review, speaker_mapping_quality=meeting.speaker_mapping_quality)
```

Payload is `list[SpeakerMappingUpdate]` or wrapper model if preferred.

Force saved source to `user_corrected` regardless of client value.

**Step 5: Add owner resolution endpoint**

```python
@router.post("/{meeting_id}/resolve-action-owners", response_model=list[ActionItemResponse])
async def resolve_action_owners(
    meeting_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ActionItemResponse]:
    meeting = await get_owned_meeting_or_404(db, meeting_id, current_user)
    action_items = await resolve_action_owners_for_meeting_async(db, meeting.id)
    return [ActionItemResponse.model_validate(item) for item in action_items]
```

**Step 6: Run route tests**

```bash
cd backend
pytest tests/test_speaker_mapping_routes.py -v
```

Expected: PASS.

**Step 7: Commit**

```bash
git add backend/app/routers/meetings.py backend/tests/test_speaker_mapping_routes.py
git commit -m "feat: add speaker mapping API"
```

---

### Task 10: Include resolved labels and mapping data in meeting detail

**Objective:** Return mapped speaker labels and review status to the meeting detail UI.

**Files:**
- Modify: `backend/app/routers/meetings.py`
- Modify: `backend/app/schemas.py`
- Test: `backend/tests/test_read_endpoints.py`

**Step 1: Write failing test**

Add/extend meeting detail test:

- create transcript segment `Speaker A`
- create mapping `Speaker A -> Joseph`
- fetch meeting detail
- expect transcript segment has:
  - `speaker == Joseph`
  - `raw_speaker == Speaker A`
  - `matched_email`
  - `match_confidence`
- expect response includes `needs_speaker_review` and `speaker_mappings`

**Step 2: Implement mapping application for response only**

Create helper in `meetings.py` or service:

```python
def resolve_segments_for_display(segments: list[dict], mappings: list[SpeakerMapping]) -> list[dict]:
    by_label = {m.speaker_label: m for m in mappings}
    resolved: list[dict] = []
    for segment in segments or []:
        raw = segment.get("speaker")
        mapping = by_label.get(raw)
        item = dict(segment)
        item["raw_speaker"] = raw
        if mapping and mapping.display_name:
            item["speaker"] = mapping.display_name
            item["matched_email"] = mapping.email
            item["match_confidence"] = mapping.confidence
        else:
            item["matched_email"] = None
            item["match_confidence"] = None
        resolved.append(item)
    return resolved
```

Do not mutate the DB transcript JSON.

**Step 3: Update detail response builder**

When building `MeetingDetailResponse`, include:

- mapped transcript response
- meeting speaker review fields
- speaker mappings
- action item owner confidence fields

**Step 4: Run tests**

```bash
cd backend
pytest tests/test_read_endpoints.py::test_get_meeting_detail -v
```

If the current test name differs, add a new focused test named `test_get_meeting_detail_resolves_speaker_mappings` and run that exact test.

**Step 5: Commit**

```bash
git add backend/app/routers/meetings.py backend/app/schemas.py backend/tests/test_read_endpoints.py
git commit -m "feat: return resolved speaker mappings in meeting detail"
```

---

## Phase 4: Web types and API client

### Task 11: Extend web types for speaker mappings and owner confidence

**Objective:** Make frontend data model match new API responses.

**Files:**
- Modify: `web/src/types/index.ts`
- Modify: `web/src/lib/api.ts`
- Test: add/update lightweight TypeScript/Vitest tests if existing api tests exist; otherwise rely on `npm run lint` and `npm test`.

**Step 1: Update types**

Add types:

```ts
export type SpeakerMapping = {
  id: number;
  meeting_id: number;
  speaker_label: string;
  display_name: string | null;
  email: string | null;
  confidence: number;
  source: 'assemblyai' | 'llm_inference' | 'user_corrected';
  reason: string | null;
  created_at: string;
  updated_at: string;
};

export type SpeakerMappingUpdate = {
  speaker_label: string;
  display_name: string | null;
  email?: string | null;
  confidence?: number;
  reason?: string | null;
};
```

Extend `Meeting`/`MeetingDetail` with review fields and `speaker_mappings`.

Extend `ActionItem` with owner confidence/source/reason.

**Step 2: Add API helpers**

In `web/src/lib/api.ts`, add:

```ts
export async function getSpeakerMappings(meetingId: number) {
  return apiFetch<SpeakerMappingListResponse>(`/api/meetings/${meetingId}/speaker-mappings`);
}

export async function updateSpeakerMappings(meetingId: number, updates: SpeakerMappingUpdate[]) {
  return apiFetch<SpeakerMappingListResponse>(`/api/meetings/${meetingId}/speaker-mappings`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function resolveActionOwners(meetingId: number) {
  return apiFetch<ActionItem[]>(`/api/meetings/${meetingId}/resolve-action-owners`, {
    method: 'POST',
  });
}
```

Follow existing `apiFetch` pattern.

**Step 3: Run frontend checks**

```bash
cd web
npm run lint
npm test
```

Expected: existing stale `ActionItemContextPanel` tests may fail until later task. Do not ignore new type errors.

**Step 4: Commit**

```bash
git add web/src/types/index.ts web/src/lib/api.ts
git commit -m "feat: add speaker mapping web types and API client"
```

---

## Phase 5: Speaker review UI

### Task 12: Add speaker review utility functions

**Objective:** Compute representative quotes and display state for speaker review.

**Files:**
- Create: `web/src/components/speaker-review/speakerReview.ts`
- Create: `web/src/components/speaker-review/speakerReview.test.ts`

**Step 1: Write failing tests**

Tests:

- groups segments by raw speaker label
- selects up to 3 representative quotes per speaker
- prefers longer non-empty quotes
- resolves current mapping display

**Step 2: Implement utilities**

Create:

```ts
export function getRepresentativeQuotes(segments: TranscriptSegment[], max = 3) {
  return [...segments]
    .filter((segment) => segment.text.trim().length > 0)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, max)
    .map((segment) => segment.text);
}

export function groupSegmentsForReview(segments: TranscriptSegment[], mappings: SpeakerMapping[]) {
  const mappingByLabel = new Map(mappings.map((mapping) => [mapping.speaker_label, mapping]));
  const grouped = new Map<string, TranscriptSegment[]>();
  for (const segment of segments) {
    const label = segment.raw_speaker ?? segment.speaker;
    grouped.set(label, [...(grouped.get(label) ?? []), segment]);
  }
  return [...grouped.entries()].map(([speakerLabel, speakerSegments]) => ({
    speakerLabel,
    mapping: mappingByLabel.get(speakerLabel) ?? null,
    quotes: getRepresentativeQuotes(speakerSegments),
  }));
}
```

**Step 3: Run tests**

```bash
cd web
npm test -- src/components/speaker-review/speakerReview.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add web/src/components/speaker-review/speakerReview.ts web/src/components/speaker-review/speakerReview.test.ts
git commit -m "feat: add speaker review helpers"
```

---

### Task 13: Build SpeakerReviewPanel component

**Objective:** Let users map speakers to attendees/custom names.

**Files:**
- Create: `web/src/components/speaker-review/SpeakerReviewPanel.tsx`
- Create: `web/src/components/speaker-review/SpeakerReviewPanel.test.tsx`

**Step 1: Write failing component tests**

Tests:

- renders one card per speaker label
- shows representative quotes
- shows current mapping/confidence/source
- dropdown contains participants/current candidates
- save calls `onSave` with mapping updates
- allows “Unknown” mapping

**Step 2: Implement component**

Props:

```ts
type SpeakerReviewPanelProps = {
  segments: TranscriptSegment[];
  mappings: SpeakerMapping[];
  participants: Participant[];
  isSaving?: boolean;
  onSave: (updates: SpeakerMappingUpdate[]) => Promise<void> | void;
};
```

UI:

- speaker label heading
- confidence badge
- quote list
- select participant dropdown
- optional custom display name input
- Save mappings button

Keep styling consistent with existing rounded card style.

**Step 3: Run tests**

```bash
cd web
npm test -- src/components/speaker-review/SpeakerReviewPanel.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add web/src/components/speaker-review/SpeakerReviewPanel.tsx web/src/components/speaker-review/SpeakerReviewPanel.test.tsx
git commit -m "feat: add speaker review panel"
```

---

### Task 14: Add review banner and panel to meeting detail

**Objective:** Surface speaker review when a meeting needs it.

**Files:**
- Modify: `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`
- Test: create/update test if meeting detail tests exist; otherwise add a focused test for review banner rendering.

**Step 1: Write failing UI test**

Add a test that renders meeting detail with:

- `needs_speaker_review: true`
- transcript segments
- participants

Expect banner text:

`Some speaker labels are uncertain`

Expect speaker review panel appears.

**Step 2: Implement banner**

Add banner near top of meeting detail content when `meeting.needs_speaker_review` is true.

Copy:

```text
Some speaker labels are uncertain. Review them to improve action item ownership.
```

**Step 3: Wire save behavior**

On save:

- call `updateSpeakerMappings(meeting.id, updates)`
- call `resolveActionOwners(meeting.id)` or rely on backend endpoint to do this automatically
- revalidate meeting detail SWR/cache

**Step 4: Run tests**

```bash
cd web
npm test -- MeetingDetailContent
```

If exact filter differs, run full `npm test` and inspect failures.

**Step 5: Commit**

```bash
git add web/src/app/'(protected)'/meetings/'[[...id]]'/MeetingDetailContent.tsx web/src/app/'(protected)'/meetings/'[[...id]]'/MeetingDetailContent.test.tsx
git commit -m "feat: show speaker review on meeting detail"
```

---

### Task 15: Show owner confidence in action item UI

**Objective:** Make uncertain action ownership visible and editable.

**Files:**
- Modify: `web/src/components/action-items/ActionItemContextPanel.tsx`
- Modify: `web/src/components/action-items/ActionItemContextPanel.test.tsx`
- Possibly modify: `web/src/components/action-items/MeetingActionItemsView.tsx`

**Step 1: Fix stale existing tests first**

Current `ActionItemContextPanel.test.tsx` expects old labels:

- `Meeting context`
- `Actions`
- `Task description`
- `Delete task`

Component currently renders:

- `Source meeting`
- `Description`
- `Delete action item`

Choose one source of truth. Prefer improving accessibility without reverting product copy:

- Add `htmlFor`/`id` so labels are accessible.
- Update tests to query current labels/copy.

Run:

```bash
cd web
npm test -- src/components/action-items/ActionItemContextPanel.test.tsx
```

Expected after fix: PASS.

**Step 2: Write failing owner confidence test**

Add test showing:

- low confidence owner displays “Owner uncertain” or similar
- user-corrected owner source displays no uncertainty warning

**Step 3: Implement confidence UI**

In action item panel/card, show compact badge:

- `Owner confirmed` for `user_corrected`
- `Owner likely` for confidence >= 0.8
- `Owner uncertain` for confidence < 0.7 or missing owner

Do not overcomplicate UI.

**Step 4: Run tests**

```bash
cd web
npm test -- src/components/action-items/ActionItemContextPanel.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add web/src/components/action-items/ActionItemContextPanel.tsx web/src/components/action-items/ActionItemContextPanel.test.tsx web/src/components/action-items/MeetingActionItemsView.tsx
git commit -m "feat: show action owner confidence"
```

---

## Phase 6: Diagnostics and final verification

### Task 16: Add diagnostics API display fields

**Objective:** Expose compact diarization diagnostics for debugging/support.

**Files:**
- Modify: `backend/app/services/speaker_mapping.py`
- Modify: `backend/app/routers/meetings.py`
- Modify: `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`
- Test: backend and web tests as appropriate.

**Step 1: Write backend diagnostic test**

Assert meeting detail includes:

- `diarization_diagnostics.detected_speaker_count`
- `mapped_speaker_count`
- `average_mapping_confidence`

**Step 2: Implement/verify diagnostics building**

Keep diagnostic JSON small and stable.

**Step 3: Add optional UI display**

In web, display diagnostics in a subtle details section only when review is needed or in a collapsed panel.

**Step 4: Run tests**

```bash
cd backend && pytest tests/test_read_endpoints.py tests/test_speaker_mapping_service.py -v
cd ../web && npm test
```

**Step 5: Commit**

```bash
git add backend/app/services/speaker_mapping.py backend/app/routers/meetings.py backend/tests/test_read_endpoints.py web/src/app/'(protected)'/meetings/'[[...id]]'/MeetingDetailContent.tsx web/src/app/'(protected)'/meetings/'[[...id]]'/MeetingDetailContent.test.tsx
git commit -m "feat: expose diarization diagnostics"
```

---

### Task 17: Add documentation for speaker review workflow

**Objective:** Explain the new review fallback to developers/users.

**Files:**
- Modify: `README.md` or `docs/user-guide.md`
- Create: `docs/diarization-review.md`

**Step 1: Add docs**

Create `docs/diarization-review.md` covering:

- why speaker review exists
- when it appears
- how to map speakers
- how mappings affect action owners
- limitations of system-audio diarization

**Step 2: Link from user guide**

Add a short link/section to `docs/user-guide.md`.

**Step 3: Commit**

```bash
git add docs/diarization-review.md docs/user-guide.md
git commit -m "docs: explain diarization review workflow"
```

---

### Task 18: Final test and quality gate

**Objective:** Verify the full implementation before PR/release.

**Files:**
- No code changes expected unless tests reveal issues.

**Step 1: Run backend tests**

```bash
cd backend
pytest
```

Expected: PASS.

**Step 2: Run web tests and lint**

```bash
cd web
npm test
npm run lint
npm run build
```

Expected: tests/build PASS. Lint may have pre-existing warnings only if they remain intentionally deferred.

**Step 3: Run desktop tests/build**

```bash
cd desktop
npm test -- --runInBand
npm run build:electron
```

Expected: PASS.

**Step 4: Inspect git diff**

```bash
git status --short
git diff --stat
```

Expected: clean after commits.

**Step 5: Summarize**

Prepare summary for Joseph:

- migrations added
- APIs added
- UI added
- tests run
- any remaining limitations
- whether Supabase/production migration equivalent is needed for deployment

---

## Suggested implementation grouping

If using subagents, dispatch in this order:

1. Backend model/migration/schemas: Tasks 1-3.
2. Backend services/pipeline/API: Tasks 4-10.
3. Web types/review UI/action-owner UI: Tasks 11-15.
4. Diagnostics/docs/final verification: Tasks 16-18.

Each group should still commit per task or small task cluster.

## Out-of-scope follow-up plan

After this implementation lands, create a separate feasibility study for Teams transcript import via Graph. That study should answer whether Teams-generated transcripts can be used as a higher-quality diarization source without having a bot join meetings.
