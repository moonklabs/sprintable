"""backfill trigger_type_slugs in agent_routing_rules conditions

Revision ID: 0014
Revises: 0013
Create Date: 2026-05-09

Maps existing memo_type values to trigger_type_slugs:
  review               → qa_request
  requirement, user_story, task, dev_task → kickoff
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # review → qa_request (must run before kickoff to avoid overlap on mixed lists)
    conn.execute(sa.text("""
        UPDATE agent_routing_rules
        SET conditions = conditions || '{"trigger_type_slugs": ["qa_request"]}'::jsonb
        WHERE deleted_at IS NULL
          AND NOT (conditions ? 'trigger_type_slugs')
          AND conditions->'memo_type' @> '["review"]'::jsonb
    """))

    # requirement / user_story / task / dev_task → kickoff
    conn.execute(sa.text("""
        UPDATE agent_routing_rules
        SET conditions = conditions || '{"trigger_type_slugs": ["kickoff"]}'::jsonb
        WHERE deleted_at IS NULL
          AND NOT (conditions ? 'trigger_type_slugs')
          AND (
            conditions->'memo_type' @> '["requirement"]'::jsonb
            OR conditions->'memo_type' @> '["user_story"]'::jsonb
            OR conditions->'memo_type' @> '["task"]'::jsonb
            OR conditions->'memo_type' @> '["dev_task"]'::jsonb
          )
    """))


def downgrade() -> None:
    op.execute(sa.text("""
        UPDATE agent_routing_rules
        SET conditions = conditions - 'trigger_type_slugs'
        WHERE conditions ? 'trigger_type_slugs'
    """))
