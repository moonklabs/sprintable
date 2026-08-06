"""#2472(A2) — billing_ledger_entries: append-only 결제 원장 + 잔액 파생 뷰.

설계문서 billing-arch-modular-pg-ledger-v0-1 §3. PG 웹훅 「수신」·한도 「집행」은 범위 밖
(A3/B/C) — 이 마이그는 원장 스키마 + 불변성 가드 + 파생 뷰만.

## 불변성 강제 방식
UPDATE/DELETE를 애플리케이션 관례로만 막지 않는다 — `billing_ledger_entries_block_mutation()`
트리거 함수가 BEFORE UPDATE OR DELETE에서 예외를 던진다. 이 코드베이스에 선례가 없는 첫
DB-트리거 불변성 가드라 pytest(양성대조: 실제 UPDATE/DELETE가 거부되는지)로 직접 증명한다
(app/services/billing_ledger.py의 멱등 기입 헬퍼는 ON CONFLICT DO NOTHING만 쓰고 DO UPDATE는
쓰지 않는다 — 그 자체가 이 트리거에 걸리기 때문).

## 멱등
provider_ref UNIQUE(nullable) — 내부전용 엔트리(provider 없음)는 유일성 제약 밖. 웹훅발
엔트리끼리만 충돌 → 기입 API가 ON CONFLICT DO NOTHING 후 재조회로 기존 행을 반환(no-op).

## 잔액/사용량 파생
org_ledger_balances 뷰 — direction에 따라 credit(+)/debit(-)로 합산해 (org_id, currency)별
순잔액을 원장에서 파생한다. 별도 잔액 컬럼을 어디에도 두지 않는다(원장이 정본).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0229"
down_revision = "0228"
branch_labels = None
depends_on = None

_ENTRY_TYPES = ["charge", "refund", "pack_purchase", "credit_grant", "credit_consume", "adjustment"]
_DIRECTIONS = ["debit", "credit"]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("billing_ledger_entries"):
        op.create_table(
            "billing_ledger_entries",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("ts", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.Column("entry_type", sa.Text(), nullable=False),
            sa.Column("amount_minor", sa.BigInteger(), nullable=False),
            sa.Column("currency", sa.Text(), nullable=False),
            sa.Column("direction", sa.Text(), nullable=False),
            sa.Column("provider", sa.Text(), nullable=True),
            sa.Column("provider_ref", sa.Text(), nullable=True),
            sa.Column("subscription_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("org_subscriptions.id"), nullable=True),
            sa.Column("metadata", postgresql.JSONB(), nullable=True),
            sa.CheckConstraint(
                f"entry_type IN ({','.join(repr(t) for t in _ENTRY_TYPES)})",
                name="billing_ledger_entries_entry_type_check",
            ),
            sa.CheckConstraint(
                f"direction IN ({','.join(repr(d) for d in _DIRECTIONS)})",
                name="billing_ledger_entries_direction_check",
            ),
            sa.CheckConstraint("currency IN ('usd','krw')", name="billing_ledger_entries_currency_check"),
            sa.CheckConstraint("provider IS NULL OR provider IN ('toss','polar')", name="billing_ledger_entries_provider_check"),
            sa.CheckConstraint("amount_minor > 0", name="billing_ledger_entries_amount_positive_check"),
            sa.UniqueConstraint("provider_ref", name="uq_billing_ledger_entries_provider_ref"),
        )
        op.create_index("ix_billing_ledger_entries_org_id_ts", "billing_ledger_entries", ["org_id", "ts"])
        op.create_index("ix_billing_ledger_entries_subscription_id", "billing_ledger_entries", ["subscription_id"])

    # ---------------------------------------------------------------
    # 불변성 트리거 — UPDATE/DELETE 예외로 거부
    # ---------------------------------------------------------------
    op.execute(
        """
        CREATE OR REPLACE FUNCTION billing_ledger_entries_block_mutation()
        RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'billing_ledger_entries is append-only — % not allowed (id=%)',
                TG_OP, COALESCE(OLD.id, NULL)
                USING ERRCODE = 'raise_exception';
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_billing_ledger_entries_block_mutation ON billing_ledger_entries")
    op.execute(
        """
        CREATE TRIGGER trg_billing_ledger_entries_block_mutation
        BEFORE UPDATE OR DELETE ON billing_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION billing_ledger_entries_block_mutation();
        """
    )

    # ---------------------------------------------------------------
    # 잔액 파생 뷰
    # ---------------------------------------------------------------
    op.execute("DROP VIEW IF EXISTS org_ledger_balances")
    op.execute(
        """
        CREATE VIEW org_ledger_balances AS
        SELECT
            org_id,
            currency,
            SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END) AS balance_minor,
            COUNT(*) AS entry_count,
            MAX(ts) AS last_entry_at
        FROM billing_ledger_entries
        GROUP BY org_id, currency;
        """
    )


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS org_ledger_balances")
    op.execute("DROP TRIGGER IF EXISTS trg_billing_ledger_entries_block_mutation ON billing_ledger_entries")
    op.execute("DROP FUNCTION IF EXISTS billing_ledger_entries_block_mutation()")
    op.drop_index("ix_billing_ledger_entries_subscription_id", table_name="billing_ledger_entries")
    op.drop_index("ix_billing_ledger_entries_org_id_ts", table_name="billing_ledger_entries")
    op.drop_table("billing_ledger_entries")
