"""add memo_entity_links table and migrate memo_doc_links data

Revision ID: 0011
Revises: 0010
Create Date: 2026-05-05
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'memo_entity_links',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('memo_id', UUID(as_uuid=True), sa.ForeignKey('memos.id', ondelete='CASCADE'), nullable=False),
        sa.Column('entity_type', sa.String(32), nullable=False),
        sa.Column('entity_id', UUID(as_uuid=True), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('memo_id', 'entity_type', 'entity_id', name='uq_memo_entity_links'),
        sa.CheckConstraint("entity_type IN ('story','doc','epic','task')", name='ck_mel_entity_type'),
    )
    op.create_index('ix_memo_entity_links_memo_id', 'memo_entity_links', ['memo_id'])

    # Migrate existing memo_doc_links data as entity_type='doc'
    op.execute("""
        INSERT INTO memo_entity_links (id, memo_id, entity_type, entity_id, position, created_at)
        SELECT gen_random_uuid(), memo_id, 'doc', doc_id, 0, created_at
        FROM memo_doc_links
        ON CONFLICT ON CONSTRAINT uq_memo_entity_links DO NOTHING
    """)


def downgrade() -> None:
    op.drop_index('ix_memo_entity_links_memo_id', 'memo_entity_links')
    op.drop_table('memo_entity_links')
