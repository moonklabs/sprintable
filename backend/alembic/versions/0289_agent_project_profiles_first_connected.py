"""story #3197(연결·판별자) — agent_project_profiles에 durable "최초 연결 완료" 마커 신설.

doc 배경: `get_verified_map`(agent_verify.py)의 stdio 레일(`acked_seq >= verify_seq`)은
durable이지만, http-transport(온보딩 권장 탭·주 경로)는 heartbeat freshness(TTL 만료 시
소멸)뿐이라 "한 번이라도 연결 완료"의 durable 기록이 없었다(#2751 당시 스코프 밖).

`first_connected_at`은 그 org의 이 에이전트가 처음 online으로 관측된 시각 — 한 번 채워지면
지우지 않는다(last_seen_at은 disconnect 시 None으로 되돌지만 이 컬럼은 그대로 둔다,
`sync_agent_profile_presence` 참고). transport 무관 공용 컬럼(stdio도 같은 경로로 채워짐 —
새 판별자를 transport별로 쪼개지 않는다, PO "판별 로직 한 곳 유지" 지시).

Revision ID: 0289
Revises: 0288
Create Date: 2026-08-29

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0289"
down_revision = "0288"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_project_profiles",
        sa.Column("first_connected_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_project_profiles", "first_connected_at")
