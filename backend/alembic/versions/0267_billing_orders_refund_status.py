"""story #2880(결제 트랙 갭①, 선생님 확定 2026-08-21) — billing_orders.refund_status.

상향 티어 전환 산식이 확定됐다: 신 offering 전액 charge(confirmed 後) → tier/period
즉시 전이 → 직전 confirmed 결제 건에 잔여기간 일할 부분취소(Toss cancel). 부분취소가
실패해도 이미 confirmed된 charge는 되돌리지 않는다(선생님 지시) — 그 실패를 `billing_
orders`에 명시로 남겨야 향후 재시도/스윕이 찾을 수 있다. NULL=이 order에 환불 시도
자체가 없었음(기존 행 전부의 기본 상태, 배타적이지 않음 — 한 order가 부분취소를 여러 번
받을 수도 있으나 이 스토리는 "마지막 시도 결과"만 기록한다).

Revision ID: 0267
Revises: 0266
Create Date: 2026-08-21
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0267"
down_revision = "0266"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("billing_orders", sa.Column("refund_status", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_billing_orders_refund_status",
        "billing_orders",
        "refund_status IS NULL OR refund_status IN ('confirmed', 'failed')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_billing_orders_refund_status", "billing_orders", type_="check")
    op.drop_column("billing_orders", "refund_status")
