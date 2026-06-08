"""backfill team_member.webhook_url to webhook_configs (canonical) — 1bc9fbae S2

0023이 초기 backfill 후 webhook_url=NULL 했으나, 이후 PATCH /api/v2/team-members 로
재축적된 webhook_url이 webhook_configs 와 disconnected(발송 read는 webhook_configs만).
이를 canonicalize(member_identity_aliases)하여 webhook_configs 로 backfill 한다.

- additive: team_members.webhook_url 컬럼/값 유지(non-breaking). ③ dual-write 후 ⑤ cutover서 DROP.
- canonicalize: COALESCE(alias.member_id, tm.id) — 레거시 휴먼 tm.id→canonical, 에이전트 그대로.
  (0023은 canonicalize 이전이라 tm.id 직삽입했음 — 발송 매칭 정합 위해 본 backfill은 정규화.)
- channel: url 패턴으로 discord/generic 판별(dispatch_router 의 is_discord_url 과 정합).
- 멱등: 동일 canonical member_id 의 활성 webhook_config 없을 때만 INSERT.

Revision ID: 0101
Revises: 0100
Create Date: 2026-06-08
"""
import sqlalchemy as sa
from alembic import op

revision = "0101"
down_revision = "0100"
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
                COALESCE(mia.member_id, tm.id),
                NULL,
                tm.webhook_url,
                CASE
                    WHEN tm.webhook_url LIKE '%discord.com/api/webhooks%'
                      OR tm.webhook_url LIKE '%discordapp.com/api/webhooks%' THEN 'discord'
                    ELSE 'generic'
                END,
                true
            FROM team_members tm
            LEFT JOIN member_identity_aliases mia ON mia.alias_id = tm.id
            WHERE tm.webhook_url IS NOT NULL AND tm.webhook_url <> ''
              AND NOT EXISTS (
                  SELECT 1 FROM webhook_configs wc
                  WHERE wc.member_id = COALESCE(mia.member_id, tm.id)
                    AND wc.is_active = true
              )
        """)
    )


def downgrade() -> None:
    # additive backfill — 원본(team_members.webhook_url)이 보존되므로 rollback 시 손실 없음.
    # backfill된 row를 기존 webhook_configs 와 구별 불가하므로 no-op(데이터 안전).
    pass
