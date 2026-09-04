"""story 46da6450(Phase1·BE·소형, 페드루 PO 確定 2026-09-04) — organizations.timezone.

캘린더(#3422)·예약 시각 표기(§11-2 「조직 타임존으로 MM-DD HH:mm」)의 tz 정본. 서버
시각 처리는 그대로 UTC-explicit ISO(scheduled_at 검증기·next_retry_at 무변경) — 이
컬럼은 표시·그룹핑 기준을 위한 값 저장소일 뿐, 저장 로직 자체를 바꾸지 않는다(그라운딩
결론: 서버는 지금 org tz를 어디서도 안 읽는다).

nullable, 기본 null(백필 불요) — 미설정 조직은 FE가 계속 브라우저 tz로 폴백(기존
동작 그대로).

Revision ID: 0320
Revises: 0319
Create Date: 2026-09-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0320"
down_revision = "0319"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "organizations",
        sa.Column("timezone", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("organizations", "timezone")
