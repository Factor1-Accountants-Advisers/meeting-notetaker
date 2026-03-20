"""Initial schema

Revision ID: 001
Revises:
Create Date: 2026-03-19

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create enum types (IF NOT EXISTS for idempotency)
    op.execute("DO $$ BEGIN CREATE TYPE meetingstatus AS ENUM ('processing', 'transcribing', 'diarising', 'summarising', 'complete', 'failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;")
    op.execute("DO $$ BEGIN CREATE TYPE actionitemstatus AS ENUM ('open', 'complete'); EXCEPTION WHEN duplicate_object THEN null; END $$;")

    # Create users table
    op.create_table(
        'users',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('email', sa.String(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('azure_ad_id', sa.String(), nullable=False),
        sa.Column('role', sa.String(), nullable=False, server_default='user'),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_users_id'), 'users', ['id'], unique=False)
    op.create_index(op.f('ix_users_email'), 'users', ['email'], unique=True)
    op.create_index(op.f('ix_users_azure_ad_id'), 'users', ['azure_ad_id'], unique=True)

    # Create meetings table
    op.create_table(
        'meetings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.String(), nullable=False),
        sa.Column('scheduled_time', sa.DateTime(), nullable=True),
        sa.Column('duration_seconds', sa.Integer(), nullable=True),
        sa.Column('status', postgresql.ENUM('processing', 'transcribing', 'diarising', 'summarising', 'complete', 'failed', name='meetingstatus', create_type=False), nullable=False, server_default='processing'),
        sa.Column('audio_blob_url', sa.String(), nullable=True),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_meetings_id'), 'meetings', ['id'], unique=False)
    op.create_index(op.f('ix_meetings_user_id'), 'meetings', ['user_id'], unique=False)
    op.create_index(op.f('ix_meetings_status'), 'meetings', ['status'], unique=False)
    op.create_index(op.f('ix_meetings_created_at'), 'meetings', ['created_at'], unique=False)

    # Create participants table
    op.create_table(
        'participants',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('meeting_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('email', sa.String(), nullable=True),
        sa.ForeignKeyConstraint(['meeting_id'], ['meetings.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_participants_id'), 'participants', ['id'], unique=False)
    op.create_index(op.f('ix_participants_meeting_id'), 'participants', ['meeting_id'], unique=False)

    # Create transcripts table
    op.create_table(
        'transcripts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('meeting_id', sa.Integer(), nullable=False),
        sa.Column('full_text', sa.Text(), nullable=True),
        sa.Column('segments', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(['meeting_id'], ['meetings.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('meeting_id')
    )
    op.create_index(op.f('ix_transcripts_id'), 'transcripts', ['id'], unique=False)
    op.create_index(op.f('ix_transcripts_meeting_id'), 'transcripts', ['meeting_id'], unique=True)

    # Create summaries table
    op.create_table(
        'summaries',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('meeting_id', sa.Integer(), nullable=False),
        sa.Column('summary_text', sa.Text(), nullable=True),
        sa.Column('key_points', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('follow_ups', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(['meeting_id'], ['meetings.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('meeting_id')
    )
    op.create_index(op.f('ix_summaries_id'), 'summaries', ['id'], unique=False)
    op.create_index(op.f('ix_summaries_meeting_id'), 'summaries', ['meeting_id'], unique=True)

    # Create action_items table
    op.create_table(
        'action_items',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('meeting_id', sa.Integer(), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('owner_name', sa.String(), nullable=True),
        sa.Column('owner_email', sa.String(), nullable=True),
        sa.Column('due_date', sa.Date(), nullable=True),
        sa.Column('status', postgresql.ENUM('open', 'complete', name='actionitemstatus', create_type=False), nullable=False, server_default='open'),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
        sa.ForeignKeyConstraint(['meeting_id'], ['meetings.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_action_items_id'), 'action_items', ['id'], unique=False)
    op.create_index(op.f('ix_action_items_meeting_id'), 'action_items', ['meeting_id'], unique=False)
    op.create_index(op.f('ix_action_items_status'), 'action_items', ['status'], unique=False)


def downgrade() -> None:
    # Drop tables
    op.drop_index(op.f('ix_action_items_status'), table_name='action_items')
    op.drop_index(op.f('ix_action_items_meeting_id'), table_name='action_items')
    op.drop_index(op.f('ix_action_items_id'), table_name='action_items')
    op.drop_table('action_items')

    op.drop_index(op.f('ix_summaries_meeting_id'), table_name='summaries')
    op.drop_index(op.f('ix_summaries_id'), table_name='summaries')
    op.drop_table('summaries')

    op.drop_index(op.f('ix_transcripts_meeting_id'), table_name='transcripts')
    op.drop_index(op.f('ix_transcripts_id'), table_name='transcripts')
    op.drop_table('transcripts')

    op.drop_index(op.f('ix_participants_meeting_id'), table_name='participants')
    op.drop_index(op.f('ix_participants_id'), table_name='participants')
    op.drop_table('participants')

    op.drop_index(op.f('ix_meetings_created_at'), table_name='meetings')
    op.drop_index(op.f('ix_meetings_status'), table_name='meetings')
    op.drop_index(op.f('ix_meetings_user_id'), table_name='meetings')
    op.drop_index(op.f('ix_meetings_id'), table_name='meetings')
    op.drop_table('meetings')

    op.drop_index(op.f('ix_users_azure_ad_id'), table_name='users')
    op.drop_index(op.f('ix_users_email'), table_name='users')
    op.drop_index(op.f('ix_users_id'), table_name='users')
    op.drop_table('users')

    # Drop enum types
    op.execute("DROP TYPE actionitemstatus")
    op.execute("DROP TYPE meetingstatus")
