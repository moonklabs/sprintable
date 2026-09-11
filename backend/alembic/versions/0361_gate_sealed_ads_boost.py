"""story #3806(Phase3·3-2 PR2, 페드루 PO 確定 2026-09-11) — `gate.sealed_ads_budget_minor`
+`sealed_ads_currency`+`sealed_ads_starts_at`+`sealed_ads_ends_at`+`sealed_ads_objective`
신설(additive, nullable). `ads_boost` 전용 봉인 축(0345 `sealed_doc_id`/concept_approval
과 동형 관례) — 그 gate_type이 아니면 항상 null. `ads_boost`는 새 gate_type이라 CHECK
제약 갱신 불요(gate_type 컬럼은 free-form Text, story #3806 PR2 그라운딩 확認)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0361"
down_revision = "0360"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("sealed_ads_budget_minor", sa.Integer(), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_currency", sa.Text(), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_starts_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_ends_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("gate", sa.Column("sealed_ads_objective", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("gate", "sealed_ads_objective")
    op.drop_column("gate", "sealed_ads_ends_at")
    op.drop_column("gate", "sealed_ads_starts_at")
    op.drop_column("gate", "sealed_ads_currency")
    op.drop_column("gate", "sealed_ads_budget_minor")
