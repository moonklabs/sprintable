"""drop all RLS policies (final cleanup after 0002 DISABLE)

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-30

C-S9: 0002에서 DISABLE만 했던 RLS 정책을 완전히 DROP.
FastAPI org_id/role 검증 레이어가 보안을 전담하므로
Supabase 자동 생성 RLS 정책 객체 자체를 제거한다.

실행 조건: Cloud SQL 인스턴스 복원 완료 후 (C-S9 스크립트 실행 후)
"""
from __future__ import annotations

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # public 스키마의 모든 RLS 정책을 동적으로 DROP
    op.execute("""
        DO $$
        DECLARE
            r RECORD;
        BEGIN
            FOR r IN
                SELECT schemaname, tablename, policyname
                FROM pg_policies
                WHERE schemaname = 'public'
                ORDER BY tablename, policyname
            LOOP
                EXECUTE format(
                    'DROP POLICY IF EXISTS %I ON %I.%I',
                    r.policyname, r.schemaname, r.tablename
                );
            END LOOP;
        END $$;
    """)


def downgrade() -> None:
    # RLS 정책은 Supabase 자동 생성이었으므로 복원 불가 — no-op
    pass
