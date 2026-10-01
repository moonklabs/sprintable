"""story #4460 — a person can cancel a boost; the next request for the same post starts a new cycle with a new campaign.

A post has one ads_boost gate (0328 unique slot) and a gate one run (uq_ads_boost_runs_gate_id), so a cancel resets them in place:
the cycle that ended is kept as a row, the run is cleared for the next cycle.

- `gate.requested_by_member_id`: who asked for the boost (stamped again on every request) — a cancel is the requester's or an
  owner's/admin's. Null on gates made before this column: owner/admin only.
- `ads_boost_runs.cycle_started_at`: when the current cycle began (null = the run's first cycle) — the card's and the cap's spend
  count only this cycle's captures (the org ledger keeps every capture).
- `ads_boost_runs.cancel_requested_at · cancel_requested_by · cancel_reason`: a cancel asked for and not finished yet («취소 중»):
  the campaign ids are kept until the provider confirmed the pause.
- `ads_boost_run_cycles`: one row per ended cycle — the campaign it made, what it was created with, when it ran, why it ended,
  and what it spent — so a past cycle's campaign and spend do not disappear when the run is cleared.

Additive only (new nullable columns · a new table).

Revision ID: 0426
Revises: 0425
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0426"
down_revision = "0425"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("requested_by_member_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("cycle_started_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("cancel_requested_by", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("cancel_reason", sa.Text(), nullable=True))
    op.create_table(
        "ads_boost_run_cycles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("gate_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("campaign_id", sa.Text(), nullable=True),
        sa.Column("adset_id", sa.Text(), nullable=True),
        sa.Column("ad_id", sa.Text(), nullable=True),
        sa.Column("created_budget_minor", sa.Integer(), nullable=True),
        sa.Column("created_for_version_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_connection_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("currency", sa.Text(), nullable=True),
        sa.Column("spend_minor", sa.Integer(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_reason", sa.Text(), nullable=False),
        sa.Column("ended_by_member_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_ads_boost_run_cycles_org_id", "ads_boost_run_cycles", ["org_id"])
    op.create_index("ix_ads_boost_run_cycles_gate_id", "ads_boost_run_cycles", ["gate_id"])


def downgrade() -> None:
    op.drop_index("ix_ads_boost_run_cycles_gate_id", table_name="ads_boost_run_cycles")
    op.drop_index("ix_ads_boost_run_cycles_org_id", table_name="ads_boost_run_cycles")
    op.drop_table("ads_boost_run_cycles")
    op.drop_column("ads_boost_runs", "cancel_reason")
    op.drop_column("ads_boost_runs", "cancel_requested_by")
    op.drop_column("ads_boost_runs", "cancel_requested_at")
    op.drop_column("ads_boost_runs", "cycle_started_at")
    op.drop_column("gate", "requested_by_member_id")
