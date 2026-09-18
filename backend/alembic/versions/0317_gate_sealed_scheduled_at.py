"""story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — Gate.sealed_scheduled_at.

블루프린트 v3 §3 원문 재독(정정 2): external_publish 게이트가 봉인하는 것은 본문
해시뿐 아니라 "예약 시각"도 포함한다("목적지·불변 버전·예약 시각·예산을 참조 — 승인 후
변경 시 무효화"). site_posts 등 다른 gate_type은 예약 개념이 없어 이 컬럼을 영원히
null로 둔다 — 기존 sealed_content_version/sha256/body와 같은 공유-nullable 관례
그대로(신규 테이블을 안 판다, gate 하나가 이미 이 "봉인" 역할을 도맡고 있음).

Revision ID: 0317
Revises: 0316
Create Date: 2026-09-04
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0317"
down_revision = "0316"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "gate",
        sa.Column("sealed_scheduled_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("gate", "sealed_scheduled_at")
