"""migrate webhook_url to webhook_configs

Revision ID: 0023
Revises: 0022
Create Date: 2026-05-12
"""
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text("""
            INSERT INTO webhook_configs (id, org_id, member_id, project_id, url, channel, is_active)
            SELECT
                gen_random_uuid(),
                tm.org_id,
                tm.id,
                NULL,
                tm.webhook_url,
                'discord',
                true
            FROM team_members tm
            WHERE tm.webhook_url IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM webhook_configs wc
                  WHERE wc.member_id = tm.id AND wc.project_id IS NULL
              )
        """)
    )
    conn.execute(
        sa.text("UPDATE team_members SET webhook_url = NULL WHERE webhook_url IS NOT NULL")
    )


def downgrade() -> None:
    # 복구 불가 (원본 URL이 webhook_configs에 있으나 member당 여러 개일 수 있음)
    pass
