"""Tests for action item owner resolution."""

from app.models import (
    ActionItem,
    ActionOwnerSource,
    Meeting,
    Participant,
    SpeakerMapping,
    SpeakerMappingSource,
)
from app.services.action_owner_resolution import (
    resolve_action_item_owners_for_meeting,
    resolve_action_owner,
)


def test_speaker_mapping_owner_resolves_email_and_confidence():
    mapping = SpeakerMapping(
        speaker_label="Speaker A",
        display_name="Alice Nguyen",
        email="alice@example.com",
        confidence=0.92,
        source=SpeakerMappingSource.LLM_INFERENCE,
        reason="Voice matched Alice",
    )

    resolved = resolve_action_owner(
        extracted_owner="Alice",
        speaker_label="Speaker A",
        candidates=[],
        mappings_by_label={"Speaker A": mapping},
    )

    assert resolved == {
        "owner_name": "Alice Nguyen",
        "owner_email": "alice@example.com",
        "owner_confidence": 0.92,
        "owner_source": ActionOwnerSource.SPEAKER_MAPPING,
        "owner_reason": "Resolved from speaker mapping for Speaker A",
    }


def test_explicit_name_match_resolves_to_candidate_email():
    resolved = resolve_action_owner(
        extracted_owner="  melissa hall  ",
        speaker_label=None,
        candidates=[
            {"display_name": "Test User", "email": "test@example.com"},
            {"display_name": "Melissa Hall", "email": "melissa@example.com"},
        ],
        mappings_by_label={},
    )

    assert resolved["owner_name"] == "Melissa Hall"
    assert resolved["owner_email"] == "melissa@example.com"
    assert resolved["owner_confidence"] == 0.8
    assert resolved["owner_source"] == ActionOwnerSource.EXPLICIT_NAME_MATCH
    assert resolved["owner_reason"] == "Exact case-insensitive match to participant/candidate name"


def test_llm_owner_with_no_candidate_remains_name_only_medium_confidence():
    resolved = resolve_action_owner(
        extracted_owner="Jordan from Finance",
        speaker_label=None,
        candidates=[{"display_name": "Melissa Hall", "email": "melissa@example.com"}],
        mappings_by_label={},
    )

    assert resolved == {
        "owner_name": "Jordan from Finance",
        "owner_email": None,
        "owner_confidence": 0.5,
        "owner_source": ActionOwnerSource.LLM_EXTRACTION,
        "owner_reason": "Preserved owner text from LLM extraction; no matching candidate found",
    }


def test_empty_or_unknown_owner_becomes_unassigned():
    for extracted_owner in (None, "", "   ", "unknown", "Unassigned", "none", "N/A"):
        resolved = resolve_action_owner(
            extracted_owner=extracted_owner,
            speaker_label=None,
            candidates=[],
            mappings_by_label={},
        )

        assert resolved == {
            "owner_name": None,
            "owner_email": None,
            "owner_confidence": 0.0,
            "owner_source": ActionOwnerSource.UNASSIGNED,
            "owner_reason": "No actionable owner extracted",
        }


def test_user_corrected_owner_is_preserved(db_session, test_meeting: Meeting):
    action_item = ActionItem(
        meeting_id=test_meeting.id,
        description="Send the customer update",
        owner_name="Human Choice",
        owner_email="human@example.com",
        owner_confidence=1.0,
        owner_source=ActionOwnerSource.USER_CORRECTED,
        owner_reason="User corrected in UI",
    )
    mapping = SpeakerMapping(
        meeting_id=test_meeting.id,
        speaker_label="Human Choice",
        display_name="AI Choice",
        email="ai@example.com",
        confidence=0.95,
        source=SpeakerMappingSource.LLM_INFERENCE,
    )
    db_session.add_all([action_item, mapping])
    db_session.commit()

    resolved_items = resolve_action_item_owners_for_meeting(db_session, test_meeting.id)

    assert [item.id for item in resolved_items] == [action_item.id]
    db_session.refresh(action_item)
    assert action_item.owner_name == "Human Choice"
    assert action_item.owner_email == "human@example.com"
    assert action_item.owner_confidence == 1.0
    assert action_item.owner_source == ActionOwnerSource.USER_CORRECTED
    assert action_item.owner_reason == "User corrected in UI"


def test_resolves_action_item_owners_for_meeting_from_mappings_and_candidates(db_session, test_meeting: Meeting):
    db_session.add_all(
        [
            Participant(
                meeting_id=test_meeting.id,
                name="Melissa Hall",
                email="melissa@example.com",
                is_organizer=True,
            ),
            SpeakerMapping(
                meeting_id=test_meeting.id,
                speaker_label="Speaker A",
                display_name="Alice Nguyen",
                email="alice@example.com",
                confidence=0.91,
                source=SpeakerMappingSource.LLM_INFERENCE,
            ),
        ]
    )
    mapped_item = ActionItem(
        meeting_id=test_meeting.id,
        description="Draft the proposal",
        owner_name="Speaker A",
    )
    named_item = ActionItem(
        meeting_id=test_meeting.id,
        description="Schedule the review",
        owner_name="melissa hall",
    )
    unknown_item = ActionItem(
        meeting_id=test_meeting.id,
        description="Find a launch owner",
        owner_name="unknown",
    )
    db_session.add_all([mapped_item, named_item, unknown_item])
    db_session.commit()

    resolved_items = resolve_action_item_owners_for_meeting(db_session, test_meeting.id)

    assert [item.id for item in resolved_items] == [mapped_item.id, named_item.id, unknown_item.id]
    db_session.refresh(mapped_item)
    db_session.refresh(named_item)
    db_session.refresh(unknown_item)

    assert mapped_item.owner_name == "Alice Nguyen"
    assert mapped_item.owner_email == "alice@example.com"
    assert mapped_item.owner_confidence == 0.91
    assert mapped_item.owner_source == ActionOwnerSource.SPEAKER_MAPPING

    assert named_item.owner_name == "Melissa Hall"
    assert named_item.owner_email == "melissa@example.com"
    assert named_item.owner_confidence == 0.8
    assert named_item.owner_source == ActionOwnerSource.EXPLICIT_NAME_MATCH

    assert unknown_item.owner_name is None
    assert unknown_item.owner_email is None
    assert unknown_item.owner_confidence == 0.0
    assert unknown_item.owner_source == ActionOwnerSource.UNASSIGNED
