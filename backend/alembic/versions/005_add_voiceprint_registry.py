"""Add central voiceprint registry

Revision ID: 005_add_voiceprint_registry
Revises: 004_add_speaker_mappings_and_owner_confidence
Create Date: 2026-06-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "005_add_voiceprint_registry"
down_revision: Union[str, None] = "004_add_speaker_mappings_and_owner_confidence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "voiceprints",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "provider",
            sa.String(),
            nullable=False,
            server_default="pyannote",
        ),
        sa.Column("provider_voiceprint_id", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("email", sa.String(), nullable=True),
        sa.Column(
            "status",
            sa.String(),
            nullable=False,
            server_default="active",
        ),
        sa.Column("consent_recorded_at", sa.DateTime(), nullable=True),
        sa.Column("raw_sample_path", sa.String(), nullable=True),
        sa.Column("sample_duration_seconds", sa.Float(), nullable=True),
        sa.Column("sample_source", sa.String(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=True),
        sa.Column("disabled_reason", sa.Text(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider",
            "provider_voiceprint_id",
            name="uq_voiceprints_provider_voiceprint_id",
        ),
    )
    op.create_index(op.f("ix_voiceprints_id"), "voiceprints", ["id"], unique=False)
    op.create_index(
        op.f("ix_voiceprints_user_id"), "voiceprints", ["user_id"], unique=False
    )
    op.create_index(
        op.f("ix_voiceprints_email"), "voiceprints", ["email"], unique=False
    )
    op.create_index(
        op.f("ix_voiceprints_status"), "voiceprints", ["status"], unique=False
    )
    op.create_index(
        op.f("ix_voiceprints_provider_voiceprint_id"),
        "voiceprints",
        ["provider_voiceprint_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_voiceprints_provider_voiceprint_id"), table_name="voiceprints")
    op.drop_index(op.f("ix_voiceprints_status"), table_name="voiceprints")
    op.drop_index(op.f("ix_voiceprints_email"), table_name="voiceprints")
    op.drop_index(op.f("ix_voiceprints_user_id"), table_name="voiceprints")
    op.drop_index(op.f("ix_voiceprints_id"), table_name="voiceprints")
    op.drop_table("voiceprints")
