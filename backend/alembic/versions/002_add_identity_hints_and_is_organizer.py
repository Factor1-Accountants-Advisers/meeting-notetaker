"""Add identity_hints to meetings and is_organizer to participants

Revision ID: 002
Revises: 001
Create Date: 2026-04-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '002'
down_revision: Union[str, None] = '001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('meetings', sa.Column('identity_hints', sa.Text(), nullable=True))
    op.add_column('participants', sa.Column('is_organizer', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column('participants', 'is_organizer')
    op.drop_column('meetings', 'identity_hints')
