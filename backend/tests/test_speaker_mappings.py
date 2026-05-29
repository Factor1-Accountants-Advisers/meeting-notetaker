"""Tests for speaker mapping schemas."""
from datetime import datetime

import pytest
from pydantic import ValidationError

from app.schemas import ActionItemResponse, SpeakerMappingUpdate


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
