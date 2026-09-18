"""story #3806(Phase3·3-2 PR 11, 페드루 PO 確定 2026-09-11 16:20Z) — 「상한 내 실행」
실물 처방(§7 실측 열 「상한 초과 0건」의 장치). `ads_boost_runs.cap_reached_at`:
캡처된 paid 지출 합이 `gate.sealed_ads_budget_minor`에 도달/초과한 순간을 1회
기록(nullable — 미도달이면 null, 지어내지 않는다). 이 시각을 찍은 뒤에만
자동 중지(scheduler pause)를 시도해 같은 게이트를 매 tick 재-중지 요청하지
않는다(멱등 게이트 역할)."""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0368"
down_revision = "0367"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ads_boost_runs",
        sa.Column("cap_reached_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ads_boost_runs", "cap_reached_at")
