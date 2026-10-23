"""[SID:4755] billing_payment_attempts.kind gains 'renewal': the owner row of a refund for a renewal charge that settled on a closed organization

«돈 기록 하나에 주인 하나» (story 4335/4344): a refund goes out only through a payment attempt row (refund lease · one idempotency key · operator alerts · the sweep that retries it). A renewal charge made by the
scheduler has no attempt; when its organization is closed by the time it settles, a VOIDED attempt of kind `renewal` is written for it (`billing_payment_attempt.void_confirmed_order_of_closed_org`) and the existing refund road
takes over. Additive: the CHECK is widened, no data changes.
"""
from alembic import op

revision = "0462"
down_revision = "0461"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_billing_payment_attempts_kind", "billing_payment_attempts", type_="check")
    op.create_check_constraint("ck_billing_payment_attempts_kind", "billing_payment_attempts", "kind IN ('checkout', 'change_tier', 'renewal')")


def downgrade() -> None:
    op.drop_constraint("ck_billing_payment_attempts_kind", "billing_payment_attempts", type_="check")
    op.create_check_constraint("ck_billing_payment_attempts_kind", "billing_payment_attempts", "kind IN ('checkout', 'change_tier')")
