# Diarization Review and Action Ownership Confidence Design

Date: 2026-05-29
Repo: `meeting-notetaker`
Status: Draft approved for planning review

## Goal

Improve Notetaker output trust without requiring an always-on Teams bot or cloud media service.

The user-facing goal is:

- Install and run the desktop app normally.
- Record meetings from the desktop.
- Produce highly accurate transcripts where possible.
- Produce speaker labels that are trustworthy enough for summaries and action items.
- When speaker identity is uncertain, make the uncertainty visible and let the user quickly correct it.
- Extract action items with the right owner name and email wherever possible.

The primary pain point is speaker diarization. Word-level transcription accuracy and action extraction also matter, but speaker identity has been the recurring weakness.

## Non-goals

- Do not build a Teams bot that joins meetings in this phase.
- Do not require an always-on media bot/cloud service to capture meetings.
- Do not promise 100% automatic diarization. The system must be honest when speaker identity is uncertain.
- Do not build cross-meeting voiceprint memory in this phase. User corrections are authoritative for the current meeting only.
- Do not redesign the entire meeting-processing pipeline beyond what is needed for diarization review and action ownership confidence.

## Existing pipeline summary

Current code uses:

- Desktop recording through Electron/WASAPI.
- AssemblyAI transcription with `speaker_labels: true`, `universal-2`, and optional speaker identification with up to 10 known participant names.
- Participant/name hints from calendar attendees, organizer, and current recorder.
- OpenAI-based speaker inference using conversational cues.
- OpenAI summarisation/action extraction.
- Action items currently store `owner_name`, but not `owner_email`, confidence, source, or reason.

Relevant files:

- `backend/app/services/transcription.py`
- `backend/app/services/speaker_inference.py`
- `backend/app/services/summarisation.py`
- `backend/app/models.py`
- `web/src/app/(protected)/meetings/[[...id]]/MeetingDetailContent.tsx`
- `web/src/components/action-items/*`

## Design overview

Add a diarization quality layer between transcription and summarisation.

New conceptual pipeline:

1. Record audio locally.
2. Transcribe with AssemblyAI and keep raw speaker labels.
3. Build candidate identity pool from meeting metadata.
4. Create speaker mappings with confidence and source.
5. Mark meeting as needing speaker review if important speaker labels remain uncertain.
6. Summarise and extract action items using confident speaker mappings where available.
7. Let the user review/correct uncertain speakers.
8. Re-resolve action item owners after speaker corrections.

This makes diarization uncertainty explicit instead of silently producing wrong names.

## Data model changes

### Speaker mappings

Add a table such as `speaker_mappings`:

- `id`
- `meeting_id`
- `speaker_label`
- `display_name`
- `email`
- `confidence`
- `source`
- `reason`
- `created_at`
- `updated_at`

`source` should be constrained to:

- `assemblyai`
- `llm_inference`
- `user_corrected`

Rules:

- `meeting_id + speaker_label` should be unique.
- `user_corrected` mappings override AI-generated mappings for that meeting.
- `display_name` and `email` may be null when no confident identity is available.
- `confidence` is 0.0 to 1.0.
- `reason` is short and user-safe; no secret values or raw internal prompts.

### Meeting quality flags

Add meeting-level diarization quality fields or a JSON object:

- `needs_speaker_review`
- `speaker_review_completed_at`
- `speaker_mapping_quality`
- `diarization_diagnostics`

Diagnostics should be compact and explainable:

- `detected_speaker_count`
- `mapped_speaker_count`
- `average_mapping_confidence`
- `attendee_hint_count`
- `speaker_identification_used`
- `low_confidence_labels`

### Action item ownership fields

Extend action items with:

- `owner_email`
- `owner_confidence`
- `owner_source`
- `owner_reason`

`owner_source` should be constrained to:

- `speaker_mapping`
- `explicit_name_match`
- `llm_extraction`
- `user_corrected`
- `unassigned`

The existing `owner_name` remains for compatibility and display.

## Speaker mapping pipeline

### Candidate pool

Build candidates from:

- meeting participants
- organizer
- current recorder
- attendees from Graph metadata

Each candidate should include:

- display name
- email
- organizer flag
- recorder flag
- aliases if available later

Candidate cleanup:

- dedupe by email when present
- dedupe exact display names when email missing
- filter out generic entries like `Everyone`
- cap candidates for AssemblyAI known-values input, but keep all candidates for internal matching and UI review

### AssemblyAI mapping

AssemblyAI remains the first pass.

Use speaker identification when candidates are available. Save speaker mappings from AssemblyAI as source `assemblyai` when returned identity is usable.

If AssemblyAI returns generic labels only, keep generic labels as raw transcript speakers and pass them to inference.

### LLM speaker inference

Use `speaker_inference.py` as the second pass, but require structured confidence output.

Inputs:

- generic speaker-labelled transcript segments
- candidate pool with names/emails/roles
- meeting title and organizer/current-user context where useful

Outputs:

- speaker label
- assigned display name
- assigned email
- confidence
- reason/evidence

Acceptance threshold:

- default `0.70` for saving an AI mapping
- below threshold remains unmapped and contributes to `needs_speaker_review`
- direct evidence can be higher confidence; role/context-only evidence should be lower

Important behavior:

- A wrong identity is worse than no identity.
- The model should leave ambiguous speakers unmapped.
- User correction overrides all AI mappings.

## Speaker review UI

Add a speaker review panel on the meeting detail page.

### When to show review prompt

Show a banner when:

- `needs_speaker_review` is true, or
- one or more action item owners are uncertain because speaker labels are uncertain.

Example copy:

> Some speaker labels are uncertain. Review them to improve action item ownership.

### Review panel behavior

For each detected speaker label:

- show current mapped person if any
- show confidence and source
- show 2-3 representative quotes
- provide a dropdown of meeting attendees/current user/organizer
- allow custom person entry if the speaker was not in the attendee list
- allow leaving the speaker as unknown

After the user saves mappings:

- persist `speaker_mappings` with source `user_corrected`
- update transcript display labels
- re-resolve action item ownership
- clear `needs_speaker_review` if all important speaker labels are mapped or intentionally left unknown

The review step must be quick. The goal is to map Speaker A/B/C in under a minute, not create a heavy editing workflow.

## Transcript display behavior

Transcript segments should continue storing the raw speaker label from transcription.

Display should resolve labels at render time:

- if a speaker mapping exists, display mapped name
- if no mapping exists, display generic label such as `Speaker A`
- if confidence is low, show a subtle uncertainty indicator

This avoids destructive transcript rewrites and preserves the original diarization output for debugging.

## Action item ownership resolution

Action extraction should produce action items as it does today, but ownership should be resolved through a deterministic layer after extraction.

Resolution order:

1. User-corrected action owner, if present.
2. Action owner derived from a user-corrected speaker mapping.
3. Action owner derived from high-confidence speaker mapping.
4. Explicit name/email match in action text or transcript context.
5. LLM-provided owner name if it maps cleanly to a candidate.
6. Otherwise unassigned or uncertain.

When the user corrects speaker mappings, re-run ownership resolution for affected action items without necessarily re-running full summarisation.

When the user corrects an action owner directly, save source `user_corrected` and do not overwrite it during later automatic resolution.

## Audio-quality diagnostics

Add lightweight diagnostics to explain diarization quality. This is not a full audio-analysis project.

Capture/store:

- recording duration
- file size
- whether recording started and stopped cleanly
- whether available metadata included attendees
- number of speakers detected by AssemblyAI
- whether speaker identification was enabled
- number of confident mappings

Optional later diagnostics:

- silence/volume stats
- clipping detection
- overlap/interruptions if provider exposes them

Display diagnostics only when helpful, e.g. in a small “quality details” section or developer/debug panel.

## API changes

Add these endpoints:

- `GET /api/meetings/{meeting_id}/speaker-mappings`
- `PUT /api/meetings/{meeting_id}/speaker-mappings`
- `POST /api/meetings/{meeting_id}/resolve-action-owners`

Rules:

- All endpoints must verify the meeting belongs to the current user.
- Saving mappings should validate speaker labels exist in the transcript.
- Mapping payloads should validate confidence/source constraints.
- User-corrected mappings should not be overwritten by automated processing.

## Testing strategy

### Backend unit tests

Add tests for:

- candidate pool deduplication and filtering
- AI mapping threshold behavior
- user-corrected mapping overriding AI mapping
- owner resolution order
- action owner email matching
- unresolved/uncertain owner behavior

### Backend integration tests

Add tests for:

- low-confidence speakers setting `needs_speaker_review`
- saving speaker mappings clears review flag when appropriate
- saving speaker mappings updates transcript display payload/API response
- saving speaker mappings re-resolves action owner fields
- direct user-corrected action owner is preserved on re-resolution

### Web tests

Add tests for:

- review banner appears when meeting needs speaker review
- speaker review panel shows representative quotes
- dropdown saves a mapping
- transcript labels update from speaker mappings
- action item owner confidence/source displays correctly

### Regression cases

Cover these scenarios:

- no attendees available
- more than 10 attendees
- duplicate display names
- generic speakers with no confident match
- speaker mapped by AssemblyAI
- speaker mapped by LLM inference
- speaker corrected by user
- action owner explicitly named but speaker unknown

## Feasibility study track: Teams transcript import

Run this separately from implementation.

Questions to answer:

- Can Graph access Teams meeting transcripts for Factor1 meetings?
- What permissions/admin consent are required?
- Are transcripts available soon enough after a meeting?
- Do Teams transcripts include reliable speaker attribution?
- Does this require Teams transcription to be enabled during meetings?
- Can we use Teams transcript when available and local audio transcription as fallback?

This is not a bot-joining study. It is a lower-operational-cost way to improve diarization if Microsoft already has speaker-attributed transcript data.

## Rollout plan

### Phase 1: Data and backend quality layer

- Add speaker mapping model/migration.
- Add action owner confidence fields.
- Add speaker mapping generation and owner resolution service.
- Add backend tests.

### Phase 2: Review UI

- Add meeting-level review banner.
- Add speaker review panel.
- Add action owner confidence display/editing.
- Add web tests.

### Phase 3: Audio and diagnostics polish

- Store compact diagnostics.
- Surface quality details when diarization is uncertain.
- Add recording metadata where currently missing.

### Phase 4: Teams transcript feasibility study

- Research and document Graph transcript import viability.
- Recommend whether to prototype transcript import.

## Risks and mitigations

### Risk: Users do not want extra review work

Mitigation:
- Only ask for review when confidence is low.
- Keep review panel fast with representative quotes.
- Let users skip review if they only need the summary.

### Risk: AI confidence is misleading

Mitigation:
- Keep conservative thresholds.
- Show uncertainty rather than overclaiming.
- Make user corrections authoritative.

### Risk: Action owners are overwritten incorrectly

Mitigation:
- Preserve `user_corrected` owner fields.
- Re-run automatic resolution only for non-user-corrected owners.

### Risk: Schema changes get too large

Mitigation:
- Use one focused `speaker_mappings` table and minimal action owner fields.
- Avoid cross-meeting memory and voiceprint storage in this phase.

## Success criteria

- Meetings with uncertain speakers clearly indicate review is needed.
- Users can map speakers to attendees quickly.
- Transcript display updates after speaker correction.
- Action items store owner email, confidence, and source.
- Action ownership improves after speaker correction without re-running the whole meeting pipeline.
- No Teams bot or always-on media service is required.
- Existing desktop install-and-record workflow remains intact.
