"""Tests for speaker mapping schemas."""
from datetime import datetime

import pytest
from pydantic import ValidationError

from app.schemas import (
    ActionItemCreate,
    ActionItemResponse,
    MeetingDetailResponse,
    SpeakerMappingListResponse,
    SpeakerMappingUpdate,
)


def test_speaker_mapping_update_request_validates_confidence_range():
    SpeakerMappingUpdate(speaker_label="Speaker A", confidence=0.0)
    SpeakerMappingUpdate(speaker_label="Speaker A", confidence=1.0)
    with pytest.raises(ValidationError):
        SpeakerMappingUpdate(speaker_label="Speaker A", confidence=-0.1)
    with pytest.raises(ValidationError):
        SpeakerMappingUpdate(speaker_label="Speaker A", confidence=1.1)


def test_speaker_mapping_update_source_must_be_user_corrected():
    update = SpeakerMappingUpdate(speaker_label="Speaker A", source="user_corrected")
    assert update.source == "user_corrected"

    with pytest.raises(ValidationError):
        SpeakerMappingUpdate(speaker_label="Speaker A", source="auto")


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


def test_action_item_create_does_not_expose_owner_confidence_fields():
    assert "owner_confidence" not in ActionItemCreate.model_fields
    assert "owner_source" not in ActionItemCreate.model_fields
    assert "owner_reason" not in ActionItemCreate.model_fields

    item = ActionItemCreate(
        meeting_id=10,
        description="Send the draft report",
        owner_name="Joseph Guerrero",
        owner_email="joseph@example.com",
        owner_confidence=0.91,
        owner_source="speaker_mapping",
        owner_reason="Speaker mapping matched Joseph",
    )
    dumped = item.model_dump()
    assert "owner_confidence" not in dumped
    assert "owner_source" not in dumped
    assert "owner_reason" not in dumped


def test_action_item_response_validates_owner_confidence_range():
    with pytest.raises(ValidationError):
        ActionItemResponse(
            id=1,
            meeting_id=10,
            description="Send the draft report",
            owner_confidence=1.1,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )


def test_speaker_mapping_list_response_validates_mapping_quality_range():
    SpeakerMappingListResponse(
        items=[],
        needs_speaker_review=False,
        speaker_mapping_quality=1.0,
    )

    with pytest.raises(ValidationError):
        SpeakerMappingListResponse(
            items=[],
            needs_speaker_review=False,
            speaker_mapping_quality=1.1,
        )


def test_meeting_detail_response_validates_mapping_quality_range():
    with pytest.raises(ValidationError):
        MeetingDetailResponse(
            id=1,
            title="Weekly sync",
            status="completed",
            created_at=datetime.utcnow(),
            speaker_mapping_quality=1.1,
        )
