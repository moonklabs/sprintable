"""story #4458 (PO 08:13Z ②) — a boost's campaign records what it was created with.

- `created_budget_minor`: the budget sent to the provider when the campaign was created.
- `created_for_version_id`: the seal (sealed_ads_boost_version_id) of the command that created it.
- `created_connection_id`: the ad connection the campaign was created under (story #4461 binds pause · resume · spend reads to
  it: a re-seal can move the boost to another ad account while the campaign lives in the first one).

A re-seal can land while a create call is in flight; the campaign is then made on the older seal's values. The new seal's start
(or a resume) must not switch on a campaign whose budget is not the current seal's — it stops for a person instead. Both
nullable: null = created before this column existed (no check — those campaigns were made on their own seal).

Revision ID: 0425
Revises: 0424
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0425"
down_revision = "0424"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ads_boost_runs", sa.Column("created_budget_minor", sa.Integer(), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("created_for_version_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("created_connection_id", postgresql.UUID(as_uuid=True), nullable=True))


def downgrade() -> None:
    op.drop_column("ads_boost_runs", "created_connection_id")
    op.drop_column("ads_boost_runs", "created_for_version_id")
    op.drop_column("ads_boost_runs", "created_budget_minor")
