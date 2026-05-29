"""Add speaker mappings and owner confidence

Revision ID: 004_add_speaker_mappings_and_owner_confidence
Revises: 003
Create Date: 2026-05-29

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "004_add_speaker_mappings_and_owner_confidence"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "meetings",
        sa.Column(
            "needs_speaker_review",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "meetings",
        sa.Column("speaker_review_completed_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "meetings",
        sa.Column("speaker_mapping_quality", sa.Float(), nullable=True),
    )
    op.add_column(
        "meetings",
        sa.Column("diarization_diagnostics", sa.JSON(), nullable=True),
    )

    op.add_column(
        "action_items",
        sa.Column("owner_confidence", sa.Float(), nullable=True),
    )
    op.add_column(
        "action_items",
        sa.Column("owner_source", sa.String(), nullable=True),
    )
    op.add_column(
        "action_items",
        sa.Column("owner_reason", sa.Text(), nullable=True),
    )

    op.create_table(
        "speaker_mappings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("meeting_id", sa.Integer(), nullable=False),
        sa.Column("speaker_label", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=True),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column(
            "confidence",
            sa.Float(),
            nullable=False,
            server_default=sa.text("0.0"),
        ),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "meeting_id",
            "speaker_label",
            name="uq_speaker_mappings_meeting_label",
        ),
    )
    op.create_index(
        op.f("ix_speaker_mappings_id"),
        "speaker_mappings",
        ["id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_speaker_mappings_meeting_id"),
        "speaker_mappings",
        ["meeting_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_speaker_mappings_source"),
        "speaker_mappings",
        ["source"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_speaker_mappings_source"), table_name="speaker_mappings")
    op.drop_index(op.f("ix_speaker_mappings_meeting_id"), table_name="speaker_mappings")
    op.drop_index(op.f("ix_speaker_mappings_id"), table_name="speaker_mappings")
    op.drop_table("speaker_mappings")

    op.drop_column("action_items", "owner_reason")
    op.drop_column("action_items", "owner_source")
    op.drop_column("action_items", "owner_confidence")

    op.drop_column("meetings", "diarization_diagnostics")
    op.drop_column("meetings", "speaker_mapping_quality")
    op.drop_column("meetings", "speaker_review_completed_at")
    op.drop_column("meetings", "needs_speaker_review")
