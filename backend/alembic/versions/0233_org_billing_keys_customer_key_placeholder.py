"""#2512(결제②-D선행) — org_billing_keys에 "customer_key만 있고 billing key는 아직
없는" placeholder 상태를 허용.

미르코 FE 연동 중 발견(2026-08-07): Toss `payment({customerKey})` 위젯은 시작 前에
customerKey가 필요한데, 기존 issue_billing_key()는 authKey를 받은 "뒤"에야 customerKey
를 생성했다 — FE가 위젯을 열 때 쓸 customerKey를 미리 받을 방법이 없었다(자체 UUID
생성은 C1 규율 위반). 이 마이그가 그 전제를 채운다 — encrypted_billing_key/issued_at을
nullable화해 "customer_key는 발급됐지만 아직 실 빌링키는 없는" 행을 허용하고, status
CHECK에 'awaiting_auth'를 추가한다. 이 상태 행은 charge_org의 `status == 'active'`
필터에 안 걸려 청구에 쓰이지 않는다(안전 — 실 빌링키 없이 청구를 시도할 수 없음)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0233"
down_revision = "0232"
branch_labels = None
depends_on = None

_STATUSES = ["active", "deleted", "awaiting_auth"]


def upgrade() -> None:
    op.alter_column("org_billing_keys", "encrypted_billing_key", existing_type=sa.Text(), nullable=True)
    op.alter_column("org_billing_keys", "issued_at", existing_type=sa.DateTime(timezone=True), nullable=True)
    op.drop_constraint("org_billing_keys_status_check", "org_billing_keys", type_="check")
    op.create_check_constraint(
        "org_billing_keys_status_check", "org_billing_keys",
        f"status IN ({','.join(repr(s) for s in _STATUSES)})",
    )


def downgrade() -> None:
    op.drop_constraint("org_billing_keys_status_check", "org_billing_keys", type_="check")
    op.create_check_constraint(
        "org_billing_keys_status_check", "org_billing_keys",
        "status IN ('active','deleted')",
    )
    op.alter_column("org_billing_keys", "issued_at", existing_type=sa.DateTime(timezone=True), nullable=False)
    op.alter_column("org_billing_keys", "encrypted_billing_key", existing_type=sa.Text(), nullable=False)
