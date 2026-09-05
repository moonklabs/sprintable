"""story #3498(Phase2·마케팅운영, 페드루 PO 決定 2026-09-05) — `gate.sealed_estimated_
cost_minor` 신설(additive, nullable). 블루프린트 v3 §2 「생성 비용 한도(크레딧 게이트)」·
§1 구조적 차단 3(승인 시 예산 봉인) — gate.py 자신이 이미 예고해 둔 「목적지·버전·예약·
예산」 4축 봉인 중 "예산" 축의 실제 구현.

`org_content_rules.rules.generation_budget`·evidence.payload.cost_minor 쪽은 신규 컬럼이
필요 없다(기존 JSONB 슬롯 확장 — additive, 별도 마이그 불요). 이 컬럼 하나가 이 스토리의
유일한 스키마 변경.

down_revision=0332는 story #3497(#3844)의 마이그 — 이 스토리 착수 시점에 develop 미착지
였다(gh pr list로 실물 확인, 스택 관례 그대로)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0333"
down_revision = "0332"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("sealed_estimated_cost_minor", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("gate", "sealed_estimated_cost_minor")
