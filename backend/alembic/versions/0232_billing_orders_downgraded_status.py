"""#2494(C3) — billing_orders.status에 'downgraded' 종결 상태 추가.

PO 리뷰 블로커(2026-08-07, #2884) — "상태 자가회수 부재": +8일 Free 강제전환 후에도 그
failed order를 닫지 않으면 (a) 매 스윕마다 재처리되고 (b) 그 org가 나중에 재구독(유료
전환)해도 이 옛 failed order(age≫8)가 다음 스윕에서 다시 골라져 «새 유료 구독을
clobber»한다. 'failed'를 재사용하지 않고 별도 종결 상태를 두는 이유 — 'confirmed'로
쓰면 "charge 성공"이라는 원장 의미와 충돌(실제로는 Toss 승인 없이 강제 강등된 것이라
감사·재무 관점에서 구분돼야 한다).
"""
from __future__ import annotations

from alembic import op

revision = "0232"
down_revision = "0231"
branch_labels = None
depends_on = None

_STATUSES = ["pending", "confirmed", "failed", "downgraded"]


def upgrade() -> None:
    op.drop_constraint("billing_orders_status_check", "billing_orders", type_="check")
    op.create_check_constraint(
        "billing_orders_status_check", "billing_orders",
        f"status IN ({','.join(repr(s) for s in _STATUSES)})",
    )


def downgrade() -> None:
    op.drop_constraint("billing_orders_status_check", "billing_orders", type_="check")
    op.create_check_constraint(
        "billing_orders_status_check", "billing_orders",
        "status IN ('pending','confirmed','failed')",
    )
