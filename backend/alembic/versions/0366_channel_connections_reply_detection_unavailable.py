"""story #3805(Phase3·3-1·PR 4 후속, 페드루 PO 確定 2026-09-11 12:29Z) — 「조용히 0」
클래스 처방. parent 필드가 응답에 «없음»(null 아님·키 자체 부재 — 권한·API 버전·
필드 미지원)이면 지금 코드는 조용히 kind=comment로 떨어져 "답글이 진짜 0건"과
"구분을 못 한 것"이 같은 얼굴이 된다.

`reply_detection_unavailable_at`: null=이 연결의 최근 수집에서 parent 필드 키가
관측됐다(구분 가능) — 값 有=마지막으로 그 키가 «부재»로 관측된 시각(연결 단위 집계,
그라운딩 §9 FK 없음 관례와 무관하게 이건 그냥 상태 컬럼).

Revision ID: 0366
Revises: 0365
Create Date: 2026-09-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0366"
down_revision = "0365"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_connections",
        sa.Column("reply_detection_unavailable_at", postgresql.TIMESTAMP(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("channel_connections", "reply_detection_unavailable_at")
