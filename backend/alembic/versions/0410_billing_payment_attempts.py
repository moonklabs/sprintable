"""story #4335 — 결제 시도(checkout · change-tier) 한 번 = 행 하나. 요청은 시도를 만들고 곧바로 돌려주고, 결과는 이 행으로 확정한다.

- `id`: 브라우저가 만든 UUID(멱등 키) — 같은 id로 다시 오면 새 작업 없이 이 행의 상태를 돌려준다(새로고침 · 끊긴 뒤 재요청).
- `order_id`: 시도에서 정한 Toss orderId(행을 만들 때 적음) — 같은 시도 = 같은 orderId라 Toss 멱등 · `billing_orders` claim 둘 다로 청구 1.
- `stage`: received → key_issued(checkout만) → charge_started → charged. `charge_started`는 Toss 청구 호출 **직전**에 커밋하는
  영속 표식(0408 `provider_call_started_at`과 같은 규율) — 이 단계 전에 멈춘 시도는 «청구 0»이 행으로 증명된다.
- `lease_token` · `lease_expires_at`: 이 시도를 지금 모는 쪽(응답 뒤 작업 · 조회 대사). 청구 직전 울타리와 확정 전이가 이 토큰을 확인한다.
- `claim_value`: 이 시도가 쥔 `org_subscriptions.checkout_claimed_at` 값(org당 결제 작업 슬롯 하나 — 해제는 이 값 CAS).
- change-tier 재료 `new_offering_id` · `refund_target_order_id`: 요청 시점에 고정(나중에 누가 확정해도 같은 값으로).

부분 인덱스 `ix_billing_payment_attempts_processing` — 조회 대사 · 쓸기가 진행 중 행만 본다.

번호: 착지 순 사다리 — develop 머리 0409 위. 열린 PR 중 마이그 있는 것 0(2026-09-26 01:3xZ 전수 확인).

Revision ID: 0410
Revises: 0409
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0410"
down_revision = "0409"
branch_labels = None
depends_on = None

_TABLE = "billing_payment_attempts"
_PROCESSING_INDEX = "ix_billing_payment_attempts_processing"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("requested_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("tier", sa.Text(), nullable=False),
        sa.Column("billing_cycle", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="processing"),
        sa.Column("stage", sa.Text(), nullable=False, server_default="received"),
        sa.Column("order_id", sa.Text(), nullable=False),
        sa.Column("lease_token", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("charge_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claim_value", sa.DateTime(timezone=True), nullable=True),
        sa.Column("new_offering_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("refund_target_order_id", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("reauth_required", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        # change-tier 옛 결제 부분 환불 — 확정 커밋 **전에** 의도를 적는다(pending · 금액). 확정 뒤 환불 전에 죽어도 쓸기가 이어서
        # 같은 멱등키(시도 id)로 보낸다(까디르 ⑤).
        sa.Column("refund_status", sa.Text(), nullable=True),
        sa.Column("refund_amount_minor", sa.BigInteger(), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        # PO 04:08Z «Toss 결과 모름 = 비종결»:
        # - 시작 때 구독의 요금제 판(늦은 성공이 지금 상태를 덮어쓰지 않게 — 그 사이 바뀌었으면 권리 대신 환불).
        sa.Column("base_offering_version_id", postgresql.UUID(as_uuid=True), nullable=True),
        # - 종결된 뒤에도 청구 시작 흔적이 있으면 이 시각까지 다시 조회(Toss가 뒤늦게 DONE이면 늦은 성공 길).
        sa.Column("next_check_at", sa.DateTime(timezone=True), nullable=True),
        # - 환불 한 건 한 몰이꾼: 쓸기가 행 잠금으로 집으면서 적는 기한(환불 호출 중 커밋이 있어 잠금만으로는 못 지킨다).
        sa.Column("refund_lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("kind IN ('checkout', 'change_tier')", name="ck_billing_payment_attempts_kind"),
        sa.CheckConstraint(
            "status IN ('processing', 'succeeded', 'declined', 'failed', 'voided')", name="ck_billing_payment_attempts_status",
        ),
        sa.CheckConstraint(
            "stage IN ('received', 'key_issued', 'charge_started', 'charged')", name="ck_billing_payment_attempts_stage",
        ),
        sa.CheckConstraint(
            "refund_status IS NULL OR refund_status IN ('pending', 'confirmed', 'failed')",
            name="ck_billing_payment_attempts_refund_status",
        ),
        sa.UniqueConstraint("order_id", name="uq_billing_payment_attempts_order_id"),
    )
    op.create_index("ix_billing_payment_attempts_org_id", _TABLE, ["org_id"])
    op.create_index(
        _PROCESSING_INDEX, _TABLE, ["org_id", "lease_expires_at"], unique=False,
        postgresql_where=sa.text("status = 'processing'"),
    )
    # 까디르 P1 · PO 05:05Z «돈 기록 하나에 주인 하나» — 결제 시도가 만든 주문의 주인 표지. 시도 쓸기만 이 주문을 판정하고, 옛
    # dunning · stale-order 쓸기는 이 칸이 있는 주문을 건너뛴다(주문 id 접두 추측 금지). FK는 ON DELETE RESTRICT — SET NULL이면
    # 시도가 지워질 때 주인 없는 주문으로 보여 dunning이 다시 청구하는 길이 생긴다. 지금 코드에 시도 · 주문 행을 지우는 길은 없다
    # (org 삭제도 이 두 표를 안 건드림) — RESTRICT는 그 사실을 DB가 지키게 한다(생기면 조용히 주인이 사라지는 대신 실패).
    op.add_column(
        "billing_orders",
        sa.Column(
            "payment_attempt_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey(f"{_TABLE}.id", name="fk_billing_orders_payment_attempt_id", ondelete="RESTRICT"),
            nullable=True,
        ),
    )
    op.create_index("ix_billing_orders_payment_attempt_id", "billing_orders", ["payment_attempt_id"])


def downgrade() -> None:
    op.drop_index("ix_billing_orders_payment_attempt_id", table_name="billing_orders")
    op.drop_constraint("fk_billing_orders_payment_attempt_id", "billing_orders", type_="foreignkey")
    op.drop_column("billing_orders", "payment_attempt_id")
    op.drop_index(_PROCESSING_INDEX, table_name=_TABLE)
    op.drop_index("ix_billing_payment_attempts_org_id", table_name=_TABLE)
    op.drop_table(_TABLE)
