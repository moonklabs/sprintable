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
    # invitations 테이블에 team_member_id 컬럼 없어 email 경유 교차 프로젝트 매핑 불가.
    # 잔여 NULL 레코드는 _build_app_metadata() Step 2 로그인 시 자동 백필.
    op.execute("""
        UPDATE team_members
        SET user_id = id
        WHERE user_id IS NULL
          AND type = 'human'
          AND id IN (SELECT id FROM users)
    """)


def downgrade() -> None:
    # 백필된 user_id를 NULL로 되돌리는 것은 데이터 손실 위험이 있어 no-op
    pass
