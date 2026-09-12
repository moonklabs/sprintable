"""story #3815(배포 82 라이브 회차 실 결함, 페드루 PO 確定 2026-09-12) —
`publication_commands.reason_reset_at`. `YOUTUBE_QUOTA_EXCEEDED`처럼 "언제
풀리는지"가 확定적으로 알려진 실패 사유의 그 시각을 못박는다 — `reason_code`
(이미 있음)만으로는 "재시도해도 되는지"를 화면이 못 판단한다(BE는 안다,
행엔 안 남는다 — 4231 privacy_locked와 같은 클래스의 갭). 지금은
YOUTUBE_QUOTA_EXCEEDED만 채우고 그 외 reason_code는 계속 null(다른 사유는
아직 "언제 풀리는지"를 계산할 근거가 없다 — 지어내지 않는다).

server_default 0(nullable, 기존 행은 전부 null) — additive, 회귀 0.

Revision ID: 0373
Revises: 0372
Create Date: 2026-09-12
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0373"
down_revision = "0372"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "publication_commands",
        sa.Column("reason_reset_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("publication_commands", "reason_reset_at")
