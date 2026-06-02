"""Transcription service using AssemblyAI.

Handles:
1. Downloading audio from blob storage
2. Uploading to AssemblyAI for transcription + speaker diarisation
3. Saving transcript to database
4. Updating meeting status

AssemblyAI performs transcription and speaker diarisation in a single API call,
eliminating the need for local Whisper and Pyannote models.

OWASP: No sensitive data logged, fail-closed on errors.
"""
import os
import logging
import tempfile
from typing import Dict, Any, List, Optional, cast

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Meeting, Participant, Transcript, MeetingStatus, SpeakerMappingSource
from app.services.identity_candidates import build_candidate_pool
from app.services.speaker_mapping import (
    extract_speaker_labels,
    refresh_speaker_mapping_diagnostics,
    upsert_speaker_mappings,
)
from app.services.storage import get_storage

logger = logging.getLogger(__name__)


def get_assemblyai_client():
    """Configure and return the AssemblyAI module.

    Lazy import to avoid loading assemblyai on module import.
    """
    import assemblyai as aai
    aai.settings.api_key = settings.assemblyai_api_key
    return aai


def download_audio(blob_path: str) -> str:
    """Download audio file from blob storage to local temp file.

    Args:
        blob_path: Path to the audio file in blob storage

    Returns:
        Path to the downloaded local file

    Raises:
        FileNotFoundError: If blob doesn't exist
    """
    storage = get_storage()

    # Create temp directory for downloads
    temp_dir = tempfile.mkdtemp(prefix="meeting_audio_")
    filename = os.path.basename(blob_path)
    local_path = os.path.join(temp_dir, filename)

    try:
        # Download from storage
        downloaded_path = storage.download_file(blob_path, local_path)
        logger.info(f"Downloaded audio to: {local_path}")
        return downloaded_path
    except Exception as e:
        logger.error(f"Failed to download audio: {type(e).__name__}")
        raise FileNotFoundError(f"Could not download audio: {blob_path}")


def transcribe_audio(
    audio_path: str,
    participant_names: Optional[List[str]] = None,
    speakers_expected: Optional[int] = None,
) -> Dict[str, Any]:
    """Transcribe audio file using AssemblyAI with speaker diarisation.

    Sends the audio to AssemblyAI's API which returns both the transcript
    and speaker labels in a single call. When participant names are provided,
    uses AssemblyAI's Speaker Identification to map voices to real names.

    Args:
        audio_path: Path to the local audio file
        participant_names: Optional list of attendee names for speaker identification
        speakers_expected: Optional exact number of speakers to hint to AssemblyAI.
            Only set when the actual speaker count is strongly expected.

    Returns:
        Dictionary with 'text', 'segments', and 'speaker_identified' keys.
        Each segment has: speaker, start, end, text

    Raises:
        FileNotFoundError: If audio file doesn't exist
        ValueError: If transcription fails
    """
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    aai = get_assemblyai_client()

    config_kwargs: Dict[str, Any] = {
        "speaker_labels": True,
        "language_code": "en",
        "speech_models": ["universal-2"],
    }

    if speakers_expected is not None:
        config_kwargs["speakers_expected"] = speakers_expected

    # When we know participant names, enable Speaker Identification
    # so AssemblyAI returns real names instead of generic A/B/C labels.
    # AssemblyAI limits known_values to 10 — filter noise (emails, "Everyone",
    # distribution lists) and cap before sending.
    _ASSEMBLYAI_MAX_KNOWN_VALUES = 10
    raw_names = [n.strip() for n in (participant_names or []) if n.strip()]
    names = [
        n for n in raw_names
        if "@" not in n and n.lower() != "everyone" and len(n) > 1
    ][:_ASSEMBLYAI_MAX_KNOWN_VALUES]
    speaker_identified = False

    if names:
        logger.info(f"Speaker identification enabled with {len(names)} names (filtered from {len(raw_names)}): {names}")
        config_kwargs["speech_understanding"] = aai.SpeechUnderstandingRequest(
            request=aai.SpeechUnderstandingFeatureRequests(
                speaker_identification=aai.SpeakerIdentificationRequest(
                    speaker_type="name",
                    known_values=names,
                )
            )
        )
        # Boost transcription accuracy for names spoken aloud
        config_kwargs["keyterms_prompt"] = names
        speaker_identified = True

    config = aai.TranscriptionConfig(**config_kwargs)
    transcriber = aai.Transcriber()

    logger.info(f"Starting AssemblyAI transcription: {audio_path}")
    transcript = transcriber.transcribe(audio_path, config=config)

    if transcript.status == aai.TranscriptStatus.error:
        raise ValueError(f"AssemblyAI transcription failed: {transcript.error}")

    # Build segments from utterances (speaker-labelled chunks)
    segments = []
    if transcript.utterances:
        for utterance in transcript.utterances:
            segments.append({
                "speaker": utterance.speaker,
                "start": utterance.start / 1000.0,  # ms -> seconds
                "end": utterance.end / 1000.0,
                "text": utterance.text.strip(),
            })

    logger.info(f"Transcription complete: {len(segments)} speaker segments")

    return {
        "text": transcript.text or "",
        "segments": segments,
        "speaker_identified": speaker_identified,
    }


def save_transcript(
    db: Session,
    meeting_id: int,
    transcription_result: Dict[str, Any],
) -> Transcript:
    """Save or update transcription result in database.

    Transcript.meeting_id is unique, so transcription retries/reruns must update
    the existing row instead of blindly inserting a duplicate.

    Args:
        db: Database session
        meeting_id: ID of the meeting
        transcription_result: Result from transcribe_audio()

    Returns:
        Created or updated Transcript object
    """
    transcript = (
        db.query(Transcript)
        .filter(Transcript.meeting_id == meeting_id)
        .one_or_none()
    )

    if transcript is None:
        transcript = Transcript(meeting_id=meeting_id)
        db.add(transcript)

    transcript.full_text = transcription_result["text"]
    transcript.segments = transcription_result["segments"]
    transcript.speaker_identified = transcription_result.get("speaker_identified", False)

    # Update meeting status
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if meeting:
        meeting.status = MeetingStatus.TRANSCRIBING

    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(transcript)

    logger.info(f"Saved transcript for meeting {meeting_id}")
    return transcript


def _add_detected_speaker_count(meeting: Meeting, detected_speaker_count: int) -> None:
    """Add transcription-time detected speaker count to meeting diagnostics."""
    diagnostics = dict(cast(Any, meeting).diarization_diagnostics or {})
    diagnostics["detected_speaker_count"] = detected_speaker_count
    cast(Any, meeting).diarization_diagnostics = diagnostics


def _detected_speaker_count(transcription_result: Dict[str, Any]) -> int:
    """Count distinct speaker labels returned by transcription, preserving safety for malformed data."""
    labels: list[str] = []
    for segment in transcription_result.get("segments") or []:
        if not isinstance(segment, dict):
            continue
        speaker = segment.get("speaker")
        if isinstance(speaker, str) and speaker.strip() and speaker not in labels:
            labels.append(speaker)
    return len(labels)


def _set_diarization_retry_diagnostics(
    meeting: Meeting,
    *,
    expected_speaker_count: int,
    retry_used: bool,
    reason: str,
) -> None:
    """Record why an AssemblyAI speaker-count retry did or did not replace the first result."""
    diagnostics = dict(cast(Any, meeting).diarization_diagnostics or {})
    diagnostics["expected_speaker_count"] = expected_speaker_count
    diagnostics["diarization_retry_used"] = retry_used
    diagnostics["diarization_retry_reason"] = reason
    cast(Any, meeting).diarization_diagnostics = diagnostics


def _retry_diagnostic_fields(meeting: Meeting) -> dict[str, Any]:
    """Return retry diagnostics that should survive speaker-mapping refreshes."""
    diagnostics = cast(Any, meeting).diarization_diagnostics or {}
    if not isinstance(diagnostics, dict):
        return {}
    keys = {
        "expected_speaker_count",
        "diarization_retry_used",
        "diarization_retry_reason",
    }
    return {key: diagnostics[key] for key in keys if key in diagnostics}


def _restore_retry_diagnostic_fields(meeting: Meeting, retry_fields: dict[str, Any]) -> None:
    if not retry_fields:
        return
    diagnostics = dict(cast(Any, meeting).diarization_diagnostics or {})
    diagnostics.update(retry_fields)
    cast(Any, meeting).diarization_diagnostics = diagnostics


def _maybe_retry_two_participant_under_detection(
    *,
    meeting: Meeting,
    local_audio_path: str,
    participant_names: List[str],
    participant_count: int,
    transcription_result: Dict[str, Any],
) -> Dict[str, Any]:
    """Retry AssemblyAI once when a 2-attendee meeting collapses into 1 speaker.

    AssemblyAI supports `speakers_expected`, but its docs warn to use exact counts
    only when confident. This guarded retry keeps the default open-ended diarization
    first, then applies the exact-count hint only for the common two-person
    under-detection case. The retry replaces the original only if it finds more
    speaker labels.
    """
    expected_speaker_count = 2
    detected = _detected_speaker_count(transcription_result)
    if participant_count != expected_speaker_count or detected != 1:
        return transcription_result

    logger.info(
        "Meeting %s: retrying AssemblyAI with speakers_expected=2 after detecting 1 speaker for 2 attendees",
        meeting.id,
    )
    try:
        retry_result = transcribe_audio(
            local_audio_path,
            participant_names=participant_names,
            speakers_expected=expected_speaker_count,
        )
    except Exception as exc:
        logger.warning(
            "Meeting %s: AssemblyAI speakers_expected retry failed; keeping original transcript: %s",
            meeting.id,
            exc,
        )
        _set_diarization_retry_diagnostics(
            meeting,
            expected_speaker_count=expected_speaker_count,
            retry_used=False,
            reason="retry_failed",
        )
        return transcription_result

    retry_detected = _detected_speaker_count(retry_result)
    if retry_detected > detected:
        _set_diarization_retry_diagnostics(
            meeting,
            expected_speaker_count=expected_speaker_count,
            retry_used=True,
            reason="two_participants_one_speaker_detected",
        )
        return retry_result

    logger.info(
        "Meeting %s: speakers_expected retry still detected %s speaker(s); keeping original transcript",
        meeting.id,
        retry_detected,
    )
    _set_diarization_retry_diagnostics(
        meeting,
        expected_speaker_count=expected_speaker_count,
        retry_used=False,
        reason="retry_did_not_improve_speaker_count",
    )
    return transcription_result


def _persist_initial_speaker_mapping_diagnostics(
    db: Session,
    meeting: Meeting,
    participants: List[Participant],
    transcript: Transcript,
) -> None:
    """Persist speaker mapping diagnostics immediately after transcription.

    AssemblyAI may return real participant names when speaker identification
    succeeds. Because the transcription payload does not distinguish named
    AssemblyAI speakers from generic diarization labels, only labels that
    exactly match a known candidate display name are persisted as AssemblyAI
    mappings. All other labels remain unmapped so the review diagnostics flag
    them for human review without rewriting transcript segments.
    """
    retry_fields = _retry_diagnostic_fields(meeting)
    labels = extract_speaker_labels(cast(Any, transcript).segments)
    detected_speaker_count = len(labels)

    candidates = build_candidate_pool(participants, cast(Any, meeting).identity_hints)
    candidates_by_display_name: dict[str, dict[str, Any] | None] = {}
    for candidate in candidates:
        display_name = candidate.get("display_name")
        if not isinstance(display_name, str):
            continue
        normalized_display_name = display_name.strip()
        if not normalized_display_name:
            continue
        if normalized_display_name in candidates_by_display_name:
            candidates_by_display_name[normalized_display_name] = None
        else:
            candidates_by_display_name[normalized_display_name] = candidate

    proposed_mappings = [
        {
            "speaker_label": label,
            "display_name": candidate["display_name"],
            "email": candidate.get("email"),
            "confidence": 1.0,
            "reason": "AssemblyAI speaker label exactly matched a unique candidate display name",
        }
        for label in labels
        if (candidate := candidates_by_display_name.get(label)) is not None
    ]

    if proposed_mappings:
        upsert_speaker_mappings(
            db=db,
            meeting=meeting,
            proposed=proposed_mappings,
            source=SpeakerMappingSource.ASSEMBLYAI,
        )
    else:
        refresh_speaker_mapping_diagnostics(db, meeting)

    _restore_retry_diagnostic_fields(meeting, retry_fields)
    _add_detected_speaker_count(meeting, detected_speaker_count)
    db.add(meeting)
    db.commit()
    db.refresh(meeting)


def process_transcription(db: Session, meeting_id: int) -> Transcript:
    """Run the full transcription pipeline for a meeting.

    Uses AssemblyAI to transcribe audio with speaker diarisation
    in a single API call. No local ML models needed.

    Pipeline steps:
    1. Get meeting from database
    2. Download audio from blob storage
    3. Send to AssemblyAI (transcription + diarisation)
    4. Save transcript with speaker labels to database
    5. Update meeting status

    Args:
        db: Database session
        meeting_id: ID of the meeting to process

    Returns:
        Created Transcript object

    Raises:
        Exception: On any failure (meeting status set to FAILED)
    """
    meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()

    if not meeting:
        raise ValueError(f"Meeting not found: {meeting_id}")

    local_audio_path = None

    try:
        # Update status
        meeting.status = MeetingStatus.TRANSCRIBING
        db.commit()

        # Collect participant names for speaker identification
        participants = db.query(Participant).filter(
            Participant.meeting_id == meeting_id
        ).all()
        participant_names = [p.name for p in participants if p.name]

        # Enrich name pool with organizer and current user from identity hints.
        # These may not be in the Participant table (e.g., admin-recorded meetings),
        # but giving AssemblyAI more candidate names increases speaker_identified hit rate
        # and may let us skip the LLM inference step entirely.
        # Best-effort: malformed identity_hints must NOT abort transcription, since
        # the JSON column has no internal schema and could store any shape.
        try:
            identity_hints = meeting.identity_hints or {}
            if isinstance(identity_hints, dict):
                organizer_name = (identity_hints.get("organizer") or {}).get("name")
                if organizer_name and organizer_name not in participant_names:
                    participant_names.append(organizer_name)

                current_user_name = (identity_hints.get("current_user") or {}).get("name")
                if current_user_name and current_user_name not in participant_names:
                    participant_names.append(current_user_name)
        except Exception as e:
            logger.warning(
                f"Meeting {meeting_id}: name pool enrichment skipped, "
                f"using participant names only: {e}"
            )

        if participant_names:
            logger.info(f"Meeting {meeting_id}: {len(participant_names)} participants for speaker ID")

        # Download audio
        logger.info(f"Downloading audio for meeting {meeting_id}")
        local_audio_path = download_audio(meeting.audio_blob_url)

        # Transcribe + diarise via AssemblyAI (with speaker identification if names available).
        # Run open-ended diarization first. If a simple two-attendee meeting collapses
        # into one speaker label, retry once with AssemblyAI's exact speaker-count hint.
        logger.info(f"Transcribing meeting {meeting_id} via AssemblyAI")
        transcription_result = transcribe_audio(local_audio_path, participant_names=participant_names)
        transcription_result = _maybe_retry_two_participant_under_detection(
            meeting=meeting,
            local_audio_path=local_audio_path,
            participant_names=participant_names,
            participant_count=len(participants),
            transcription_result=transcription_result,
        )

        # Save results
        transcript = save_transcript(db, meeting_id, transcription_result)

        # Persist initial speaker mapping diagnostics without modifying
        # transcript segments. Generic labels remain unmapped and require review;
        # labels exactly matching known candidates are trusted as AssemblyAI
        # speaker-identification mappings.
        _persist_initial_speaker_mapping_diagnostics(
            db=db,
            meeting=meeting,
            participants=participants,
            transcript=transcript,
        )

        logger.info(f"Transcription pipeline complete for meeting {meeting_id}")
        return transcript

    except Exception as e:
        # Fail-closed: Set status to FAILED. Roll back first so a previous flush
        # error does not leave the session in PendingRollback state.
        logger.error(f"Transcription pipeline failed for meeting {meeting_id}: {e}")
        db.rollback()
        failed_meeting = db.query(Meeting).filter(Meeting.id == meeting_id).first()
        if failed_meeting:
            cast(Any, failed_meeting).status = MeetingStatus.FAILED
            db.commit()
        raise

    finally:
        # Cleanup temp file
        if local_audio_path and os.path.exists(local_audio_path):
            try:
                os.unlink(local_audio_path)
                # Also try to remove parent temp directory
                parent_dir = os.path.dirname(local_audio_path)
                if parent_dir.startswith(tempfile.gettempdir()):
                    os.rmdir(parent_dir)
            except Exception:
                pass  # Best effort cleanup
