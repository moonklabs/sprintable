"""story #3209(PR-1) — billing_orders에 Toss receipt_url 저장.

Toss 결제 승인 응답(payment 객체)의 `receipt.url`(공식 문서 확認, 2026-08-29 —
docs.tosspayments.com/reference §Payment — "구매자에게 제공할 수 있는 결제수단별
영수증", 카드=매출전표·가상계좌=무통장 거래명세서 등)을 confirmed 시점에 정본으로
저장한다. 신규 발급/렌더 없이 Toss 호스팅 URL을 그대로 링크(PO 안 §1). nullable —
과거(이 컬럼 신설 前) confirmed order는 소급 채움 없이 NULL로 남는다(신규 컬럼 add만,
기존 행 UPDATE 없음 — 이번 PR 스코프 밖).

Revision ID: 0291
Revises: 0290
Create Date: 2026-08-29

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0291"
down_revision = "0290"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "billing_orders",
        sa.Column("receipt_url", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("billing_orders", "receipt_url")
