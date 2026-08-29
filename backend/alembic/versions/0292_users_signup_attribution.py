"""story #3204(acquisition 계측) — users에 가입 출처 귀속 컬럼 4종 신설.

proxy.ts의 first-touch 쿠키(첫 랜딩의 utm_source/medium/campaign·referrer, 재방문
덮어쓰기 안 함)를 register()/oauth_callback() 신규 유저 생성 시점에 1회 포착한다
(locale 컬럼과 동형 패턴). 전부 nullable — 기존 행/캠페인 링크 없는 direct 가입은
NULL로 남는다(소급 채움 없음).

Revision ID: 0292
Revises: 0291
Create Date: 2026-08-29

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0292"
down_revision = "0291"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("signup_utm_source", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("signup_utm_medium", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("signup_utm_campaign", sa.Text(), nullable=True))
    op.add_column("users", sa.Column("signup_referrer", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "signup_referrer")
    op.drop_column("users", "signup_utm_campaign")
    op.drop_column("users", "signup_utm_medium")
    op.drop_column("users", "signup_utm_source")
