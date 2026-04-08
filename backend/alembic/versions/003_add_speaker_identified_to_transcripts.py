"""Add speaker_identified to transcripts

Revision ID: 003
Revises: 002
Create Date: 2026-04-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '003'
down_revision: Union[str, None] = '002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'transcripts',
        sa.Column('speaker_identified', sa.Boolean(), nullable=False, server_default=sa.false())
    )


def downgrade() -> None:
    op.drop_column('transcripts', 'speaker_identified')
