"""Seed the database with test data for manual integration testing.

Usage:
    docker compose exec api python seed_test_data.py

This inserts a user, two meetings (one complete, one processing),
participants, transcript, summary, and action items — everything
needed to exercise the Step 7 read endpoints.
"""
import sys
from datetime import datetime, date

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base
from app.models import (
    User, Meeting, Participant, Transcript, Summary, ActionItem,
    MeetingStatus, ActionItemStatus,
)

SYNC_URL = settings.database_url.replace("+asyncpg", "")
engine = create_engine(SYNC_URL)
Session = sessionmaker(bind=engine)


def seed():
    with Session() as db:
        # Use the same dev bypass user so data is accessible without Azure AD
        DEV_AZURE_ID = "dev-bypass-00000"

        # Check if already seeded
        if db.query(Meeting).first():
            print("Database already seeded. Skipping.")
            return

        # --- User (matches dev bypass in dependencies.py) ---
        user = db.query(User).filter_by(azure_ad_id=DEV_AZURE_ID).first()
        if not user:
            user = User(
                email="dev@localhost",
                name="Dev User",
                azure_ad_id=DEV_AZURE_ID,
                role="user",
            )
        db.add(user)
        db.flush()
        print(f"Created user: {user.email} (id={user.id})")

        # --- Meeting 1: Complete ---
        m1 = Meeting(
            title="Q1 Planning Session",
            scheduled_time=datetime(2026, 3, 19, 9, 0),
            duration_seconds=1800,
            status="complete",
            audio_blob_url="audio/2026/03/19/seed_q1_planning.wav",
            user_id=user.id,
        )
        db.add(m1)
        db.flush()

        db.add_all([
            Participant(meeting_id=m1.id, name="Alice Chen", email="alice@firm.com.au"),
            Participant(meeting_id=m1.id, name="Bob Smith", email="bob@firm.com.au"),
            Participant(meeting_id=m1.id, name="Carol Davis", email="carol@firm.com.au"),
        ])

        db.add(Transcript(
            meeting_id=m1.id,
            full_text=(
                "Alice: Good morning everyone. Let's discuss Q1 targets.\n"
                "Bob: Sure. I think we should focus on the new audit clients.\n"
                "Carol: Agreed. I'll prepare the budget by next Friday.\n"
                "Alice: Great. Bob, can you handle the XPM migration?\n"
                "Bob: Will do. I'll have a plan by end of month."
            ),
            segments=[
                {"speaker": "Alice Chen", "start": 0.0, "end": 4.2, "text": "Good morning everyone. Let's discuss Q1 targets."},
                {"speaker": "Bob Smith", "start": 4.5, "end": 8.1, "text": "Sure. I think we should focus on the new audit clients."},
                {"speaker": "Carol Davis", "start": 8.5, "end": 12.0, "text": "Agreed. I'll prepare the budget by next Friday."},
                {"speaker": "Alice Chen", "start": 12.3, "end": 15.5, "text": "Great. Bob, can you handle the XPM migration?"},
                {"speaker": "Bob Smith", "start": 15.8, "end": 19.0, "text": "Will do. I'll have a plan by end of month."},
            ],
        ))

        db.add(Summary(
            meeting_id=m1.id,
            summary_text=(
                "The team discussed Q1 targets with a focus on new audit clients. "
                "Carol will prepare the budget by next Friday. Bob will handle the "
                "XPM migration with a plan by end of month."
            ),
            key_points=[
                "Focus on new audit clients for Q1",
                "Budget preparation needed by next Friday",
                "XPM migration to be planned this month",
            ],
            follow_ups=[
                "Review budget draft at next meeting",
                "Check XPM migration dependencies",
            ],
        ))

        db.add_all([
            ActionItem(
                meeting_id=m1.id,
                description="Prepare Q1 budget report",
                owner_name="Carol Davis",
                owner_email="carol@firm.com.au",
                due_date=date(2026, 3, 28),
                status="open",
            ),
            ActionItem(
                meeting_id=m1.id,
                description="Create XPM migration plan",
                owner_name="Bob Smith",
                owner_email="bob@firm.com.au",
                due_date=date(2026, 3, 31),
                status="open",
            ),
            ActionItem(
                meeting_id=m1.id,
                description="Send audit client list to team",
                owner_name="Alice Chen",
                owner_email="alice@firm.com.au",
                due_date=date(2026, 3, 21),
                status="complete",
            ),
        ])
        print(f"Created meeting: '{m1.title}' (id={m1.id}) with transcript, summary, 3 action items")

        # --- Meeting 2: Still processing ---
        m2 = Meeting(
            title="Client Onboarding Standup",
            scheduled_time=datetime(2026, 3, 19, 14, 0),
            status="processing",
            audio_blob_url="audio/2026/03/19/seed_standup.wav",
            user_id=user.id,
        )
        db.add(m2)
        db.flush()

        db.add(Participant(meeting_id=m2.id, name="Alice Chen", email="alice@firm.com.au"))
        print(f"Created meeting: '{m2.title}' (id={m2.id}) in processing status")

        db.commit()
        print("\nSeed complete! You can now test the read endpoints.")


if __name__ == "__main__":
    seed()
