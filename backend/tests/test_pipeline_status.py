"""Pipeline status regression tests."""

from typing import Any, cast

from sqlalchemy.orm import sessionmaker

from app.models import Meeting, MeetingStatus
from app.services.pipeline import update_meeting_status


def test_update_meeting_status_persists_processing_error(db_engine, test_meeting, monkeypatch):
    """Failed pipeline stages should expose a readable failure reason to the UI."""

    monkeypatch.setattr(
        "app.services.pipeline._SyncSessionLocal",
        sessionmaker(bind=db_engine),
    )

    update_meeting_status(
        test_meeting.id,
        MeetingStatus.FAILED,
        "AssemblyAI API key is missing",
    )

    with sessionmaker(bind=db_engine)() as session:
        refreshed = cast(Any, session.query(Meeting).filter(Meeting.id == test_meeting.id).one())
        assert refreshed.status == MeetingStatus.FAILED
        assert refreshed.processing_error == "AssemblyAI API key is missing"


def test_update_meeting_status_clears_processing_error_on_retry(db_engine, db_session, test_meeting, monkeypatch):
    """A new processing attempt should clear stale failure text."""

    test_meeting.status = MeetingStatus.FAILED
    test_meeting.processing_error = "previous failure"
    db_session.commit()

    monkeypatch.setattr(
        "app.services.pipeline._SyncSessionLocal",
        sessionmaker(bind=db_engine),
    )

    update_meeting_status(test_meeting.id, MeetingStatus.PROCESSING)

    with sessionmaker(bind=db_engine)() as session:
        refreshed = cast(Any, session.query(Meeting).filter(Meeting.id == test_meeting.id).one())
        assert refreshed.status == MeetingStatus.PROCESSING
        assert refreshed.processing_error is None
