"""Tests for LLM-based speaker inference service."""
import json
import pytest
from types import SimpleNamespace
from unittest.mock import Mock, patch, MagicMock


class TestBuildCandidatePool:
    """Tests for building the candidate identity pool."""

    def test_builds_pool_from_participants(self):
        from app.services.speaker_inference import build_candidate_pool

        participants = [
            SimpleNamespace(name="Alice Smith", email="alice@example.com", is_organizer=False),
            SimpleNamespace(name="Bob Jones", email="bob@example.com", is_organizer=True),
        ]

        pool = build_candidate_pool(participants, identity_hints=None)

        assert len(pool) == 2
        assert pool[0]["display_name"] == "Alice Smith"
        assert pool[1]["is_organizer"] is True

    def test_adds_current_user_from_hints(self):
        from app.services.speaker_inference import build_candidate_pool

        participants = [
            SimpleNamespace(name="Alice Smith", email="alice@example.com", is_organizer=False),
        ]
        hints = {
            "current_user": {
                "name": "Joseph Guerrero",
                "email": "joseph@example.com",
                "is_current_user": True,
            },
        }

        pool = build_candidate_pool(participants, identity_hints=hints)

        assert len(pool) == 2
        recorder = [c for c in pool if c.get("is_recorder")]
        assert len(recorder) == 1
        assert recorder[0]["display_name"] == "Joseph Guerrero"

    def test_marks_existing_participant_as_recorder(self):
        from app.services.speaker_inference import build_candidate_pool

        participants = [
            SimpleNamespace(name="Joseph Guerrero", email="joseph@example.com", is_organizer=False),
        ]
        hints = {
            "current_user": {
                "name": "Joseph Guerrero",
                "email": "joseph@example.com",
                "is_current_user": True,
            },
        }

        pool = build_candidate_pool(participants, identity_hints=hints)

        assert len(pool) == 1
        assert pool[0]["is_recorder"] is True

    def test_adds_organizer_from_hints_if_missing(self):
        from app.services.speaker_inference import build_candidate_pool

        participants = [
            SimpleNamespace(name="Alice Smith", email="alice@example.com", is_organizer=False),
        ]
        hints = {
            "organizer": {
                "name": "Melissa Hall",
                "email": "melissa@example.com",
                "is_organizer": True,
            },
        }

        pool = build_candidate_pool(participants, identity_hints=hints)

        assert len(pool) == 2
        org = [c for c in pool if c.get("is_organizer")]
        assert org[0]["display_name"] == "Melissa Hall"

    def test_returns_empty_pool_for_empty_inputs(self):
        from app.services.speaker_inference import build_candidate_pool

        pool = build_candidate_pool(participants=[], identity_hints=None)

        assert pool == []


class TestInferSpeakerIdentities:
    """Tests for the LLM speaker inference call."""

    def test_returns_mapping_for_confident_matches(self):
        from app.services.speaker_inference import infer_speaker_identities

        segments = [
            {"speaker": "Speaker 1", "start": 0.0, "end": 5.0, "text": "Thanks Melissa, I agree."},
            {"speaker": "Speaker 2", "start": 5.0, "end": 10.0, "text": "No worries Joseph."},
        ]
        candidates = [
            {"display_name": "Joseph Guerrero", "email": "joseph@example.com", "is_organizer": False, "is_recorder": True},
            {"display_name": "Melissa Hall", "email": "melissa@example.com", "is_organizer": True, "is_recorder": False},
        ]

        mock_response_content = json.dumps({
            "mappings": [
                {"speaker_label": "Speaker 1", "assigned_name": "Joseph Guerrero", "assigned_email": "joseph@example.com", "confidence": 0.95, "reasoning": "Speaker 2 addresses them as Joseph"},
                {"speaker_label": "Speaker 2", "assigned_name": "Melissa Hall", "assigned_email": "melissa@example.com", "confidence": 0.9, "reasoning": "Speaker 1 addresses them as Melissa"},
            ]
        })

        mock_client = Mock()
        mock_choice = Mock()
        mock_choice.message.content = mock_response_content
        mock_client.chat.completions.create.return_value = Mock(choices=[mock_choice])

        with patch("app.services.speaker_inference.get_openai_client", return_value=mock_client):
            mapping = infer_speaker_identities(segments, candidates)

        assert "Speaker 1" in mapping
        assert mapping["Speaker 1"]["display_name"] == "Joseph Guerrero"
        assert "Speaker 2" in mapping
        assert mapping["Speaker 2"]["display_name"] == "Melissa Hall"

    def test_excludes_low_confidence_matches(self):
        from app.services.speaker_inference import infer_speaker_identities

        segments = [
            {"speaker": "Speaker 1", "start": 0.0, "end": 5.0, "text": "Let's begin."},
            {"speaker": "Speaker 2", "start": 5.0, "end": 10.0, "text": "Sure."},
        ]
        candidates = [
            {"display_name": "Alice", "email": "alice@example.com", "is_organizer": False, "is_recorder": False},
            {"display_name": "Bob", "email": "bob@example.com", "is_organizer": False, "is_recorder": False},
        ]

        mock_response_content = json.dumps({
            "mappings": [
                {"speaker_label": "Speaker 1", "assigned_name": "Alice", "assigned_email": "alice@example.com", "confidence": 0.4, "reasoning": "Weak guess"},
                {"speaker_label": "Speaker 2", "assigned_name": None, "assigned_email": None, "confidence": 0.0, "reasoning": "No evidence"},
            ]
        })

        mock_client = Mock()
        mock_choice = Mock()
        mock_choice.message.content = mock_response_content
        mock_client.chat.completions.create.return_value = Mock(choices=[mock_choice])

        with patch("app.services.speaker_inference.get_openai_client", return_value=mock_client):
            mapping = infer_speaker_identities(segments, candidates)

        assert len(mapping) == 0

    def test_returns_empty_mapping_on_empty_inputs(self):
        from app.services.speaker_inference import infer_speaker_identities

        assert infer_speaker_identities([], []) == {}
        assert infer_speaker_identities([{"speaker": "A", "text": "Hi"}], []) == {}

    def test_returns_empty_mapping_on_api_error(self):
        from app.services.speaker_inference import infer_speaker_identities

        segments = [{"speaker": "Speaker 1", "start": 0.0, "end": 1.0, "text": "Hello"}]
        candidates = [{"display_name": "Alice", "email": "a@b.com", "is_organizer": False, "is_recorder": False}]

        with patch("app.services.speaker_inference.get_openai_client") as mock_get:
            mock_get.return_value.chat.completions.create.side_effect = Exception("API down")

            mapping = infer_speaker_identities(segments, candidates)

        assert mapping == {}

    def test_returns_empty_mapping_on_invalid_json(self):
        from app.services.speaker_inference import infer_speaker_identities

        segments = [{"speaker": "Speaker 1", "start": 0.0, "end": 1.0, "text": "Hello"}]
        candidates = [{"display_name": "Alice", "email": "a@b.com", "is_organizer": False, "is_recorder": False}]

        mock_client = Mock()
        mock_choice = Mock()
        mock_choice.message.content = "not json"
        mock_client.chat.completions.create.return_value = Mock(choices=[mock_choice])

        with patch("app.services.speaker_inference.get_openai_client", return_value=mock_client):
            mapping = infer_speaker_identities(segments, candidates)

        assert mapping == {}
