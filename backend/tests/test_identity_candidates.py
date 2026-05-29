"""Tests for reusable identity candidate pool builder."""
from types import SimpleNamespace

from app.services.identity_candidates import build_candidate_pool


def test_dedupes_participants_by_email_case_insensitively():
    participants = [
        SimpleNamespace(name="Alice Original", email="Alice@Example.com", is_organizer=False),
        SimpleNamespace(name="Alice Duplicate", email=" alice@example.com ", is_organizer=True),
        SimpleNamespace(name="Bob", email="bob@example.com", is_organizer=False),
    ]

    pool = build_candidate_pool(participants, identity_hints=None)

    assert [candidate["display_name"] for candidate in pool] == ["Alice Original", "Bob"]
    assert [candidate["email"] for candidate in pool] == ["Alice@Example.com", "bob@example.com"]


def test_merges_organizer_flag_when_duplicate_participant_email_seen_later():
    participants = [
        SimpleNamespace(name="Alice Original", email="Alice@Example.com", is_organizer=False),
        SimpleNamespace(name="Alice Organizer", email=" alice@example.com ", is_organizer=True),
    ]

    pool = build_candidate_pool(participants, identity_hints=None)

    assert len(pool) == 1
    assert pool[0]["display_name"] == "Alice Original"
    assert pool[0]["email"] == "Alice@Example.com"
    assert pool[0]["is_organizer"] is True


def test_marks_current_user_as_recorder_when_email_matches_existing_candidate():
    participants = [
        SimpleNamespace(name="Joseph Guerrero", email="joseph@example.com", is_organizer=False),
    ]
    hints = {
        "current_user": {
            "name": "Joseph Guerrero",
            "email": " JOSEPH@example.com ",
        }
    }

    pool = build_candidate_pool(participants, identity_hints=hints)

    assert len(pool) == 1
    assert pool[0]["is_recorder"] is True


def test_marks_existing_organizer_when_email_matches_existing_candidate():
    participants = [
        SimpleNamespace(name="Melissa Hall", email="melissa@example.com", is_organizer=False),
    ]
    hints = {
        "organizer": {
            "name": "Melissa Hall",
            "email": " MELISSA@example.com ",
        }
    }

    pool = build_candidate_pool(participants, identity_hints=hints)

    assert len(pool) == 1
    assert pool[0]["is_organizer"] is True


def test_ignores_malformed_identity_hints_without_raising():
    participants = [
        SimpleNamespace(name="Alice", email="alice@example.com", is_organizer=False),
    ]

    assert build_candidate_pool(participants, identity_hints=["not", "a", "dict"]) == [
        {
            "display_name": "Alice",
            "email": "alice@example.com",
            "is_organizer": False,
            "is_recorder": False,
        }
    ]

    pool = build_candidate_pool(
        participants,
        identity_hints={"current_user": "bad", "organizer": ["also", "bad"]},
    )
    assert pool == [
        {
            "display_name": "Alice",
            "email": "alice@example.com",
            "is_organizer": False,
            "is_recorder": False,
        }
    ]


def test_ignores_hint_with_non_string_name():
    pool = build_candidate_pool(
        [],
        identity_hints={
            "current_user": {"name": 123, "email": "recorder@example.com"},
            "organizer": {"name": {"bad": "shape"}, "email": "organizer@example.com"},
        },
    )

    assert pool == []


def test_ignores_hint_with_whitespace_only_name():
    pool = build_candidate_pool(
        [],
        identity_hints={
            "current_user": {"name": "   ", "email": "recorder@example.com"},
            "organizer": {"name": "\t\n", "email": "organizer@example.com"},
        },
    )

    assert pool == []


def test_non_string_hint_email_is_not_preserved():
    pool = build_candidate_pool(
        [],
        identity_hints={
            "current_user": {"name": "Recorder", "email": 123},
            "organizer": {"name": "Organizer", "email": {"bad": "shape"}},
        },
    )

    assert pool == [
        {
            "display_name": "Recorder",
            "email": None,
            "is_organizer": False,
            "is_recorder": True,
        },
        {
            "display_name": "Organizer",
            "email": None,
            "is_organizer": True,
            "is_recorder": False,
        },
    ]


def test_preserves_candidates_without_email():
    participants = [
        SimpleNamespace(name="External One", email=None, is_organizer=False),
        SimpleNamespace(name="External Two", email="", is_organizer=False),
    ]
    hints = {
        "current_user": {"name": "Recorder Without Email", "email": None},
        "organizer": {"name": "Organizer Without Email", "email": ""},
    }

    pool = build_candidate_pool(participants, identity_hints=hints)

    assert [candidate["display_name"] for candidate in pool] == [
        "External One",
        "External Two",
        "Recorder Without Email",
        "Organizer Without Email",
    ]
    assert [candidate["is_recorder"] for candidate in pool] == [False, False, True, False]
    assert [candidate["is_organizer"] for candidate in pool] == [False, False, False, True]
