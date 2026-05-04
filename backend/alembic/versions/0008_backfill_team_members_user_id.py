"""backfill team_members.user_id from users and invitations

Revision ID: 0008
Revises: 0007
Create Date: 2026-05-04

Supabase→Cloud SQL 마이그레이션 시 team_members.user_id FK가 전량 NULL.
두 경로로 백필:
  1. team_members.id == users.id (Supabase에서 PK 동일 패턴)
  2. invitations.email → users.email 매핑 (초대 기반 교차 프로젝트 멤버십)
"""
from __future__ import annotations

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Step 1: team_members.id == users.id 케이스 (Supabase PK 동일 패턴)
    op.execute("""
        UPDATE team_members
        SET user_id = id
        WHERE user_id IS NULL
          AND type = 'human'
          AND id IN (SELECT id FROM users)
    """)

    # Step 2: invitations 테이블 경유 email 매핑
    # invitations.team_member_id → invitations.email → users.id
    op.execute("""
        UPDATE team_members tm
        SET user_id = u.id
        FROM invitations inv
        JOIN users u ON u.email = inv.email
        WHERE tm.user_id IS NULL
          AND tm.type = 'human'
          AND inv.team_member_id = tm.id
    """)


def downgrade() -> None:
    # 백필된 user_id를 NULL로 되돌리는 것은 데이터 손실 위험이 있어 no-op
    pass
