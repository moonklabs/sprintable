"""story #4489 — an attempt that ended without a proof (unresolved) can be resolved, and records how «nothing was charged» was proven.

- `no_charge_proof`: what proved it — `record` (the attempt ended before any charge was started · `_finish`), `provider` (a
  definite «no payment» from Toss · the recheck window's last answer or an operator's «ask the provider again»), `operator` (an
  operator marked it by hand · only with who · why · evidence, enforced below).
- `provider_rechecked_at`: the last time an operator asked Toss again (also when the answer was still not definite).

The checks spell out `IS NOT NULL`: a CHECK whose expression is NULL passes (`proof IN (...)` with a NULL proof is NULL).

Backfill: proven rows that never started a charge are `record` (0427's rule); the other proven rows came from the recheck window
(`provider`).

Revision ID: 0428
Revises: 0427
"""
import sqlalchemy as sa

from alembic import op

revision = "0428"
down_revision = "0427"
branch_labels = None
depends_on = None

_T = "billing_payment_attempts"


def upgrade() -> None:
    op.add_column(_T, sa.Column("no_charge_proof", sa.Text(), nullable=True))
    op.add_column(_T, sa.Column("no_charge_marked_by", sa.Text(), nullable=True))
    op.add_column(_T, sa.Column("no_charge_mark_reason", sa.Text(), nullable=True))
    op.add_column(_T, sa.Column("no_charge_mark_evidence", sa.Text(), nullable=True))
    op.add_column(_T, sa.Column("provider_rechecked_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(
        f"UPDATE {_T} SET no_charge_proof = CASE WHEN charge_started_at IS NULL THEN 'record' ELSE 'provider' END "
        "WHERE no_charge_proven_at IS NOT NULL"
    )
    op.create_check_constraint(
        "ck_billing_payment_attempts_no_charge_proof", _T,
        "(no_charge_proven_at IS NULL AND no_charge_proof IS NULL) OR "
        "(no_charge_proven_at IS NOT NULL AND no_charge_proof IS NOT NULL AND no_charge_proof IN ('record', 'provider', 'operator'))",
    )
    op.create_check_constraint(
        "ck_billing_payment_attempts_operator_mark", _T,
        "no_charge_proof IS DISTINCT FROM 'operator' OR (no_charge_marked_by IS NOT NULL AND no_charge_mark_reason IS NOT NULL "
        "AND no_charge_mark_evidence IS NOT NULL AND length(btrim(no_charge_mark_reason)) > 0 "
        "AND length(btrim(no_charge_mark_evidence)) > 0)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_billing_payment_attempts_operator_mark", _T, type_="check")
    op.drop_constraint("ck_billing_payment_attempts_no_charge_proof", _T, type_="check")
    for c in ("provider_rechecked_at", "no_charge_mark_evidence", "no_charge_mark_reason", "no_charge_marked_by", "no_charge_proof"):
        op.drop_column(_T, c)
