"""#2493(C2) — billing_orders: charge 시도의 orderId-먼저-기록 pending/confirmed/failed 상태.

설계문서 toss-adapter-c-plan-v0-1 §4 ⓐ(PO 확定). billing_ledger_entries(A2)는 append-only라
"승인 대기 중" 상태를 담을 수 없다 — 이 테이블이 그 자리. 결제 성공 확定 시점에만
billing_ledger_entries에 charge entry가 append된다(원장은 여전히 「정본」, 이 테이블은
Toss 호출의 진행상태 기록일 뿐).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0231"
down_revision = "0230"
branch_labels = None
depends_on = None

_STATUSES = ["pending", "confirmed", "failed"]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("billing_orders"):
        op.create_table(
            "billing_orders",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
            # Toss 요구: 영문 대소문자·숫자·-·_ 6~64자.
            sa.Column("order_id", sa.Text(), nullable=False),
            sa.Column("amount_minor", sa.BigInteger(), nullable=False),
            sa.Column("currency", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
            # confirmed 시에만 채워짐 — billing_ledger_entries.provider_ref로 그대로 쓰인다.
            sa.Column("payment_key", sa.Text(), nullable=True),
            sa.Column("failure_reason", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.CheckConstraint(
                f"status IN ({','.join(repr(s) for s in _STATUSES)})",
                name="billing_orders_status_check",
            ),
            sa.CheckConstraint("currency IN ('usd','krw')", name="billing_orders_currency_check"),
            sa.CheckConstraint("amount_minor > 0", name="billing_orders_amount_positive_check"),
            sa.UniqueConstraint("order_id", name="uq_billing_orders_order_id"),
        )
        op.create_index("ix_billing_orders_org_id", "billing_orders", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_billing_orders_org_id", table_name="billing_orders")
    op.drop_table("billing_orders")
