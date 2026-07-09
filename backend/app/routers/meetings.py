import base64
import binascii
import logging
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Header, HTTPException, status
from fastapi.responses import FileResponse

from app import store
from app.access import can_see, require
from app.config import get_settings
from app.paths import audio_dir
from app.services.audio_checks import find_ffmpeg

logger = logging.getLogger(__name__)
from app.schemas import (
    AccessRole,
    AuditEntry,
    DeliveryStatus,
    EditSegmentRequest,
    EmailRequest,
    EmailResult,
    GrantAccessRequest,
    Meeting,
    MeetingAccessEntry,
    MeetingCreate,
    MeetingReview,
    MeetingStatus,
    NameSpeakerRequest,
    PipelineStage,
    PipelineStatus,
    SharePointStatus,
    UploadAudioRequest,
)
from app.services.email import (
    build_meeting_notes_email_html,
    build_transcript_attachment,
    get_email_provider,
)
from app.services.sharepoint import get_sharepoint_provider, safe_transcript_filename
from app.services.pipeline import (
    audio_path_for,
    kick_pipeline,
    mic_track_path,
    set_delivery_state,
    set_pipeline_state,
)

Actor = Header("Unknown user", alias="X-MN-User")

router = APIRouter(prefix="/meetings", tags=["meetings"])


def _normalise_actor_id(actor: str) -> str:
    cleaned = actor.strip().lower()
    return cleaned or "unknown user"


@router.get("", response_model=list[Meeting])
async def list_meetings(
    status_filter: MeetingStatus | None = None, actor: str = Actor
) -> list[Meeting]:
    items = sorted(store.MEETINGS.values(), key=lambda m: m.created_at, reverse=True)
    items = [m for m in items if can_see(m.id, actor)]
    if status_filter is not None:
        items = [m for m in items if m.status == status_filter]
    return items


@router.get("/{meeting_id}", response_model=Meeting)
async def get_meeting(meeting_id: UUID, actor: str = Actor) -> Meeting:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.viewer)
    return meeting


@router.post("", response_model=Meeting, status_code=status.HTTP_201_CREATED)
async def create_meeting(body: MeetingCreate, actor: str = Actor) -> Meeting:
    meeting = Meeting(
        id=uuid4(),
        title=body.title,
        context=body.context,
        source=body.source,
        owner_id=_normalise_actor_id(actor),
        created_at=datetime.now(timezone.utc),
        graph_metadata=body.graph_metadata,
    )
    store.MEETINGS[meeting.id] = meeting
    # Creator owns the meeting (decision #7).
    store.ACCESS[meeting.id] = [MeetingAccessEntry(user=actor, role=AccessRole.owner)]
    return meeting


@router.get("/{meeting_id}/access", response_model=list[MeetingAccessEntry])
async def list_access(meeting_id: UUID, actor: str = Actor) -> list[MeetingAccessEntry]:
    if meeting_id not in store.MEETINGS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.viewer)
    return store.ACCESS.get(meeting_id, [])


@router.post("/{meeting_id}/access", response_model=list[MeetingAccessEntry])
async def grant_access(
    meeting_id: UUID, body: GrantAccessRequest, actor: str = Actor
) -> list[MeetingAccessEntry]:
    if meeting_id not in store.MEETINGS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.owner)
    entries = store.ACCESS.setdefault(meeting_id, [])
    existing = next((e for e in entries if e.user == body.user), None)
    if existing is None:
        entries.append(MeetingAccessEntry(user=body.user, role=body.role))
        store.add_audit(
            actor, "access.grant", body.user, after=body.role.value, meeting_id=meeting_id
        )
    elif existing.role != body.role:
        before = existing.role.value
        existing.role = body.role
        store.add_audit(
            actor, "access.change", body.user,
            before=before, after=body.role.value, meeting_id=meeting_id,
        )
    return entries


@router.delete("/{meeting_id}/access/{user}", response_model=list[MeetingAccessEntry])
async def revoke_access(
    meeting_id: UUID, user: str, actor: str = Actor
) -> list[MeetingAccessEntry]:
    if meeting_id not in store.MEETINGS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.owner)
    entries = store.ACCESS.get(meeting_id, [])
    target = next((e for e in entries if e.user == user), None)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No access entry for that user")
    if target.role is AccessRole.owner:
        raise HTTPException(status.HTTP_409_CONFLICT, "The owner cannot be removed")
    entries.remove(target)
    store.add_audit(
        actor, "access.revoke", user, before=target.role.value, meeting_id=meeting_id
    )
    return entries


def _decode_audio_b64(value: str, label: str) -> bytes:
    try:
        audio = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{label} is not valid base64")
    if len(audio) < 1_000:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{label} is too short")
    return audio


def _merge_mic_and_system_audio(meeting_id: UUID, mic_audio: bytes, system_audio: bytes) -> Path:
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "System audio was captured separately, but ffmpeg is not available to merge mic + system audio",
        )

    mic_path = mic_track_path(meeting_id)
    system_path = audio_dir() / f"{meeting_id}.system.webm"
    merged_path = audio_dir() / f"{meeting_id}.webm"
    mic_path.write_bytes(mic_audio)
    system_path.write_bytes(system_audio)

    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(mic_path),
        "-i",
        str(system_path),
        "-filter_complex",
        "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]",
        "-map",
        "[a]",
        "-c:a",
        "libopus",
        str(merged_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0 or not merged_path.exists() or merged_path.stat().st_size < 1_000:
        logger.error(
            "Failed to merge mic + system audio",
            extra={
                "meeting_id": str(meeting_id),
                "returncode": result.returncode,
                "stderr": result.stderr[-2000:],
            },
        )
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Captured mic and system audio, but failed to merge them for transcription",
        )

    logger.info(
        "Merged mic + system audio",
        extra={
            "meeting_id": str(meeting_id),
            "mic_bytes": len(mic_audio),
            "system_bytes": len(system_audio),
            "merged_bytes": merged_path.stat().st_size,
        },
    )
    return merged_path


@router.post("/{meeting_id}/audio", response_model=Meeting)
async def upload_audio(
    meeting_id: UUID, body: UploadAudioRequest, actor: str = Actor
) -> Meeting:
    """Store meeting audio (Blob stand-in) and queue the processing pipeline."""
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.editor)
    if meeting.status is MeetingStatus.finalized:
        raise HTTPException(status.HTTP_409_CONFLICT, "Finalized meetings cannot be modified")
    if meeting.pipeline_status in (PipelineStatus.queued, PipelineStatus.processing):
        raise HTTPException(status.HTTP_409_CONFLICT, "Audio is already being processed")

    audio = _decode_audio_b64(body.audio_b64, "Audio")
    system_audio = (
        _decode_audio_b64(body.system_audio_b64, "System audio")
        if body.system_audio_b64
        else None
    )

    audio_dir().mkdir(parents=True, exist_ok=True)
    if system_audio is not None:
        path = _merge_mic_and_system_audio(meeting_id, audio, system_audio)
    else:
        path = audio_path_for(meeting_id, body.mime_type)
        path.write_bytes(audio)

    # Fresh audio invalidates any earlier silence verdict; the pipeline
    # re-measures in the background (full-file decode is too slow for this
    # request path).
    updates: dict[str, object] = {"recorder_audio_missing": False}
    if body.duration_seconds:
        updates["duration_seconds"] = body.duration_seconds
    if body.graph_metadata:
        updates["graph_metadata"] = body.graph_metadata
    if updates:
        store.MEETINGS[meeting_id] = meeting.model_copy(update=updates)

    set_pipeline_state(
        meeting_id,
        PipelineStatus.queued,
        PipelineStage.audio_uploaded,
        "Recording uploaded. Preparing processing...",
    )
    kick_pipeline(meeting_id, path)
    return store.MEETINGS[meeting_id]


@router.post("/{meeting_id}/retry", response_model=Meeting)
async def retry_pipeline(meeting_id: UUID, actor: str = Actor) -> Meeting:
    """Re-queue a failed meeting (requirements §4.4: flag and retry)."""
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.editor)
    if meeting.pipeline_status is not PipelineStatus.failed:
        raise HTTPException(status.HTTP_409_CONFLICT, "Meeting is not in a failed state")
    path = audio_path_for(meeting_id, "audio/webm")
    if not path.exists():
        raise HTTPException(status.HTTP_409_CONFLICT, "No stored audio for this meeting")
    kick_pipeline(meeting_id, path)
    return store.MEETINGS[meeting_id]


def _delivery_artifacts(meeting_id: UUID) -> tuple[Meeting, list, list, str, list]:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    if meeting.pipeline_status is not PipelineStatus.ready:
        raise HTTPException(status.HTTP_409_CONFLICT, "Transcript is not ready yet")
    participants = store.PARTICIPANTS.get(meeting_id, [])
    segments = store.TRANSCRIPTS.get(meeting_id, [])
    if not segments:
        raise HTTPException(status.HTTP_409_CONFLICT, "No transcript is available to deliver")
    summary = store.SUMMARIES.get(meeting_id, "")
    action_items = [a for a in store.ACTION_ITEMS.values() if a.meeting_id == meeting_id]
    return meeting, participants, segments, summary, action_items


@router.post("/{meeting_id}/email", response_model=EmailResult)
async def email_notes(
    meeting_id: UUID,
    body: EmailRequest,
    actor: str = Actor,
    graph_token: str = Header("", alias="X-MN-Graph-Token"),
) -> EmailResult:
    """Email transcript after processing completes (Jira IN-93/IN-94).

    Slice 1 delivery is transcript-by-email using the signed-in user's Outlook:
    calendar recordings go to Graph attendees; manual/ad-hoc recordings go to
    the recorder. SharePoint and Teams delivery are later slices.
    """
    require(meeting_id, actor, AccessRole.editor)
    meeting, participants, segments, summary, action_items = _delivery_artifacts(meeting_id)

    recipients = _email_recipients(meeting, body.recorder_email)
    if not recipients:
        raise HTTPException(status.HTTP_409_CONFLICT, "No email recipients resolved")
    if not graph_token:
        set_delivery_state(
            meeting_id,
            DeliveryStatus.failed,
            "Outlook sign-in is required before transcript email can be sent",
        )
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Outlook sign-in is required before transcript email can be sent",
        )

    set_delivery_state(meeting_id, DeliveryStatus.emailing)
    email_body = build_meeting_notes_email_html(
        meeting_title=meeting.title,
        summary_html=store.SUMMARY_HTML.get(meeting_id),
        summary_text=summary,
        note=body.note,
        action_items=action_items,
    )

    transcript_text = _format_transcript(
        segments, meeting.title, participants,
        summary_text=summary,
        action_items=action_items,
        meeting=meeting,
    )
    attachments = [
        build_transcript_attachment(
            filename=f"transcript-{meeting.title[:40]}.txt",
            content=transcript_text,
        )
    ]

    try:
        await get_email_provider(graph_token or None).send_meeting_notes(
            recipients,
            f"Meeting notes: {meeting.title}",
            email_body,
            attachments=attachments,
            access_token=graph_token or None,
            content_type="HTML",
        )
    except Exception as exc:
        logger.exception("Email delivery failed for %s", meeting_id)
        set_delivery_state(meeting_id, DeliveryStatus.failed, f"Email delivery failed: {exc}")
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Email delivery failed: {exc}",
        )

    sent_at = datetime.now(timezone.utc)
    set_delivery_state(meeting_id, DeliveryStatus.emailed)
    store.add_audit(
        actor,
        "meeting.email",
        meeting.title,
        after=", ".join(recipients),
        meeting_id=meeting_id,
    )
    return EmailResult(recipients=recipients, sent_at=sent_at)


@router.post("/{meeting_id}/sharepoint", response_model=Meeting)
async def save_transcript_to_sharepoint(
    meeting_id: UUID,
    actor: str = Actor,
    graph_token: str = Header("", alias="X-MN-Graph-Token"),
) -> Meeting:
    """Save the generated transcript artifact to the configured SharePoint folder.

    The transcript/summary/action outputs are never modified or deleted by
    delivery failures; failures only update SharePoint status so the user can
    retry after credentials/folder configuration are corrected.
    """
    require(meeting_id, actor, AccessRole.owner)
    meeting, participants, segments, summary, action_items = _delivery_artifacts(meeting_id)
    filename = safe_transcript_filename(meeting.title, meeting.id)
    transcript_text = _format_transcript(
        segments,
        meeting.title,
        participants,
        summary_text=summary,
        action_items=action_items,
        meeting=meeting,
    )

    settings = get_settings()
    if settings.sharepoint_drive_id and not graph_token:
        store.MEETINGS[meeting_id] = meeting.model_copy(
            update={
                "sharepoint_status": SharePointStatus.failed,
                "sharepoint_error_message": "SharePoint sign-in is required before transcript can be saved",
            }
        )
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "SharePoint sign-in is required before transcript can be saved",
        )

    store.MEETINGS[meeting_id] = meeting.model_copy(
        update={
            "sharepoint_status": SharePointStatus.saving,
            "sharepoint_error_message": None,
        }
    )
    try:
        web_url = await get_sharepoint_provider(graph_token or None).save_transcript(
            meeting=meeting,
            filename=filename,
            content=transcript_text,
            access_token=graph_token or None,
        )
    except Exception as exc:
        logger.exception("SharePoint transcript save failed for %s", meeting_id)
        current = store.MEETINGS[meeting_id]
        store.MEETINGS[meeting_id] = current.model_copy(
            update={
                "sharepoint_status": SharePointStatus.failed,
                "sharepoint_error_message": f"SharePoint save failed: {exc}",
            }
        )
        store.save_snapshot()
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"SharePoint save failed: {exc}",
        )

    current = store.MEETINGS[meeting_id]
    updated = current.model_copy(
        update={
            "sharepoint_status": SharePointStatus.saved,
            "sharepoint_error_message": None,
            "sharepoint_web_url": web_url,
        }
    )
    store.MEETINGS[meeting_id] = updated
    store.add_audit(
        actor,
        "meeting.sharepoint_save",
        meeting.title,
        after=web_url,
        meeting_id=meeting_id,
    )
    store.save_snapshot()
    return updated


def _normalise_email(email: str | None) -> str | None:
    if not email:
        return None
    cleaned = email.strip().lower()
    if not cleaned or "@" not in cleaned:
        return None
    return cleaned


def _email_recipients(meeting: Meeting, recorder_email: str | None) -> list[str]:
    """Resolve Jira IN-93/IN-94 recipients.

    Calendar-linked recordings use Graph attendee emails. Manual/ad-hoc/upload
    recordings fall back to the signed-in recorder email supplied by the app.
    Preserve first-seen order while deduping case-insensitively.
    """
    recipients: list[str] = []

    if meeting.graph_metadata and meeting.graph_metadata.attendees:
        for attendee in meeting.graph_metadata.attendees:
            email = _normalise_email(attendee.email)
            if email and email not in recipients:
                recipients.append(email)

    if not recipients:
        email = _normalise_email(recorder_email)
        if email:
            recipients.append(email)

    return recipients


def _build_review(meeting: Meeting) -> MeetingReview:
    items = [
        a.model_copy(update={"meeting_title": meeting.title})
        for a in store.ACTION_ITEMS.values()
        if a.meeting_id == meeting.id
    ]
    return MeetingReview(
        meeting=meeting,
        summary_text=store.SUMMARIES.get(meeting.id),
        participants=store.PARTICIPANTS.get(meeting.id, []),
        segments=store.TRANSCRIPTS.get(meeting.id, []),
        action_items=items,
    )


@router.get("/{meeting_id}/review", response_model=MeetingReview)
async def get_review(meeting_id: UUID, actor: str = Actor) -> MeetingReview:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.viewer)
    return _build_review(meeting)


@router.get("/{meeting_id}/audio")
async def get_audio(meeting_id: UUID) -> FileResponse:
    """Stream the stored meeting audio (Blob stand-in; 30-day lifecycle there).

    No role check here: the renderer audio element cannot send the actor
    header. Real deployment serves audio via short-lived Blob SAS URLs.
    """
    if meeting_id not in store.MEETINGS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    path = audio_path_for(meeting_id, "audio/webm")
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No stored audio for this meeting")
    return FileResponse(path, media_type="audio/webm")


@router.get("/{meeting_id}/audit", response_model=list[AuditEntry])
async def get_audit(meeting_id: UUID, actor: str = Actor) -> list[AuditEntry]:
    if meeting_id not in store.MEETINGS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.viewer)
    return [e for e in store.AUDIT_LOG if e.meeting_id == meeting_id][::-1]


@router.patch("/{meeting_id}/segments/{index}", response_model=MeetingReview)
async def edit_segment(
    meeting_id: UUID, index: int, body: EditSegmentRequest, actor: str = Actor
) -> MeetingReview:
    """Edit transcript text; the change is audit-logged (requirements §4.6)."""
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.editor)
    if meeting.status is MeetingStatus.finalized:
        raise HTTPException(status.HTTP_409_CONFLICT, "Finalized meetings cannot be modified")
    segments = store.TRANSCRIPTS.get(meeting_id, [])
    if not 0 <= index < len(segments):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Segment not found")

    before = segments[index].text
    segments[index].text = body.text
    store.add_audit(
        actor,
        "transcript.edit",
        f"segment {index + 1} ({segments[index].speaker})",
        before=before,
        after=body.text,
        meeting_id=meeting_id,
    )
    return _build_review(meeting)


@router.post("/{meeting_id}/name-speaker", response_model=MeetingReview)
async def name_speaker(
    meeting_id: UUID, body: NameSpeakerRequest, actor: str = Actor
) -> MeetingReview:
    """Manually name an unknown diarized speaker (requirements §4.4).

    Renames the speaker across transcript and participants and decrements the
    meeting's unknown count, and logs the change.
    """
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.editor)
    if meeting.status is MeetingStatus.finalized:
        raise HTTPException(status.HTTP_409_CONFLICT, "Finalized meetings cannot be modified")

    participants = store.PARTICIPANTS.get(meeting_id, [])
    target = next((p for p in participants if p.name == body.label and not p.known), None)
    if target is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"No unknown speaker labelled '{body.label}'"
        )

    target.name = body.name
    target.known = True
    for seg in store.TRANSCRIPTS.get(meeting_id, []):
        if seg.speaker == body.label:
            seg.speaker = body.name
            seg.speaker_known = True

    updated = meeting.model_copy(
        update={"unknown_speaker_count": max(0, meeting.unknown_speaker_count - 1)}
    )
    store.MEETINGS[meeting_id] = updated
    store.add_audit(
        actor,
        "speaker.name",
        f"speaker '{body.label}'",
        before=body.label,
        after=body.name,
        meeting_id=meeting_id,
    )
    return _build_review(updated)


def _format_transcript(
    segments,
    title: str,
    participants,
    *,
    summary_text: str | None = None,
    action_items: list | None = None,
    meeting: Meeting | None = None,
) -> str:
    """Format the meeting output as structured minutes per the Factor1 template.

    The AI Summary Instructions document defines the output structure. Known
    fields (title, date, attendees, organiser) are populated from the Meeting
    model and Graph metadata. The LLM supplies summary text, decisions, and
    action items. Unknown fields use 'TBC' rather than being omitted.
    """
    now_utc = datetime.now(timezone.utc)
    date_str = now_utc.strftime('%d %B %Y')
    attendees = _attendee_list(meeting, participants)
    chair = _chair_name(meeting)
    location = _location_label(meeting)

    lines = [
        'MEETING MINUTES — DRAFT',
        '',
        f'Meeting: {title}',
        f'Date: {date_str}',
        f'Location / Platform: {location}',
        f'Chair: {chair}',
        f'Attendees: {attendees}',
        f'Objective: {summary_text.split(chr(10))[0] if summary_text else "TBC"}',
    ]
    if meeting is not None and meeting.recorder_audio_missing:
        lines.append(
            'Note: The recorder\'s microphone was silent during this recording — '
            'the recorder\'s own speech is not included in this transcript.'
        )
    lines += [
        '',
        '---',
        '',
    ]

    # Decisions
    lines.append('Decisions Made')
    decisions = _extract_decisions_from_summary(summary_text)
    if decisions:
        for i, d in enumerate(decisions, 1):
            lines.append(f'{i}. {d}')
    else:
        lines.append('No formal decisions recorded in notes provided.')
    lines.append('')

    # Action Items
    lines.append('Action Items')
    if action_items:
        lines.append('| # | Action | Owner | Due Date | Notes |')
        lines.append('|---|--------|-------|----------|-------|')
        for i, item in enumerate(action_items, 1):
            owner = item.owner or 'TBC'
            deadline = item.deadline.strftime('%d %b %Y') if item.deadline else 'TBC'
            lines.append(f'| {i} | {item.description} | {owner} | {deadline} |  |')
    else:
        lines.append('None recorded.')
    lines.append('')

    # Open Questions
    lines.append('Open Questions')
    questions = _extract_questions_from_summary(summary_text)
    if questions:
        for q in questions:
            lines.append(f'- {q}')
    else:
        lines.append('None recorded.')
    lines.append('')

    # Next Meeting
    lines.append('Next Meeting')
    lines.append('Date: TBC')
    lines.append('Agenda items flagged for next meeting: None noted')
    lines.append('')

    lines.append('---')
    lines.append('Minutes prepared by: Notetaker')
    lines.append('')

    # Full transcript
    lines.append('--- TRANSCRIPT ---')
    current_speaker = None
    for seg in segments:
        if seg.speaker != current_speaker:
            current_speaker = seg.speaker
            known = '\u2713' if seg.speaker_known else '?'
            lines.append(f'\n[{known}] {seg.speaker}:')
        lines.append(f'  {seg.text}')
    return '\n'.join(lines)


def _attendee_list(meeting: Meeting | None, participants: list) -> str:
    names: list[str] = []
    if meeting and meeting.graph_metadata:
        for a in meeting.graph_metadata.attendees:
            if a.name and a.name not in names:
                names.append(a.name)
    if not names:
        for p in participants:
            if p.known and p.name not in names:
                names.append(p.name)
    return ', '.join(names) if names else 'TBC — please add attendee list'


def _chair_name(meeting: Meeting | None) -> str:
    if meeting and meeting.graph_metadata and meeting.graph_metadata.organizer_email:
        return meeting.graph_metadata.organizer_email
    return 'TBC'


def _location_label(meeting: Meeting | None) -> str:
    if meeting is None:
        return 'TBC'
    if meeting.source.value == 'online':
        return 'Microsoft Teams'
    if meeting.source.value == 'in_person':
        return 'In person'
    return 'Uploaded recording'


def _bullets_under_heading(
    summary_text: str | None, heading_markers: tuple[str, ...]
) -> list[str]:
    """Collect bullet lines that sit under a matching section heading.

    The structured summary uses 'Key discussion' / 'Decisions' / 'Open questions'
    headings (see llm.SUMMARY_SECTIONS). A non-bullet line acts as a section
    boundary: it starts collecting when it matches one of the markers and stops
    collecting otherwise, so bullets from other sections are never mixed in.
    """
    if not summary_text:
        return []
    results: list[str] = []
    in_section = False
    for line in summary_text.split('\n'):
        stripped = line.strip()
        is_bullet = stripped.startswith('- ') or stripped.startswith('* ')
        if not is_bullet and stripped:
            lower = stripped.lower()
            in_section = any(marker in lower for marker in heading_markers)
            continue
        if in_section and is_bullet:
            results.append(stripped[2:])
    return results


def _extract_decisions_from_summary(summary_text: str | None) -> list[str]:
    return _bullets_under_heading(summary_text, ('decision',))


def _extract_questions_from_summary(summary_text: str | None) -> list[str]:
    return _bullets_under_heading(summary_text, ('open question', 'unresolved'))


@router.post("/{meeting_id}/finalize", response_model=Meeting)
async def finalize_meeting(meeting_id: UUID, actor: str = Actor) -> Meeting:
    meeting = store.MEETINGS.get(meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Meeting not found")
    require(meeting_id, actor, AccessRole.owner)
    if meeting.status is MeetingStatus.finalized:
        raise HTTPException(status.HTTP_409_CONFLICT, "Meeting is already finalized")
    if meeting.pipeline_status is not PipelineStatus.ready:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "The recording must finish processing first"
        )
    if meeting.unknown_speaker_count > 0:
        # Product rule: unknown speakers must be named before finalisation.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{meeting.unknown_speaker_count} unknown speaker(s) must be named first",
        )
    updated = meeting.model_copy(update={"status": MeetingStatus.finalized})
    store.MEETINGS[meeting_id] = updated
    store.add_audit(
        actor,
        "meeting.finalize",
        meeting.title,
        before="draft",
        after="finalized",
        meeting_id=meeting_id,
    )
    return updated
