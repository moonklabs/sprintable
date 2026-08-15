"""#2492(C1) — org_billing_keys: org당 Toss 빌링키 1건(카드 교체 = 재발급으로 대체).

설계문서 toss-adapter-c-plan-v0-1 §4. `encrypted_billing_key`는 애플리케이션 레이어
(app/services/billing_key_crypto.py, Fernet)로만 암복호화 — DB는 암호문만 본다. 원본
카드번호는 저장하지 않는다(card_number_masked는 Toss 응답 그대로의 마스킹 값).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0230"
down_revision = "0229"
branch_labels = None
depends_on = None

_STATUSES = ["active", "deleted"]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("org_billing_keys"):
        op.create_table(
            "org_billing_keys",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("customer_key", sa.Text(), nullable=False),
            sa.Column("encrypted_billing_key", sa.Text(), nullable=False),
            sa.Column("card_issuer_code", sa.Text(), nullable=True),
            sa.Column("card_acquirer_code", sa.Text(), nullable=True),
            sa.Column("card_number_masked", sa.Text(), nullable=True),
            sa.Column("card_type", sa.Text(), nullable=True),
            sa.Column("card_owner_type", sa.Text(), nullable=True),
            sa.Column("status", sa.Text(), nullable=False, server_default="active"),
            sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.CheckConstraint(
                f"status IN ({','.join(repr(s) for s in _STATUSES)})",
                name="org_billing_keys_status_check",
            ),
            sa.UniqueConstraint("org_id", name="uq_org_billing_keys_org_id"),
            sa.UniqueConstraint("customer_key", name="uq_org_billing_keys_customer_key"),
        )
        # org_id/customer_key 조회는 위 UniqueConstraint 2개가 이미 각자 unique btree 인덱스를
        # 만든다 — 별도 non-unique 인덱스 불필요(billing_ledger_entries의 org_id+ts 복합 인덱스와
        # 달리 여긴 단일 컬럼 unique라 중복이 된다).


def downgrade() -> None:
    op.drop_table("org_billing_keys")
