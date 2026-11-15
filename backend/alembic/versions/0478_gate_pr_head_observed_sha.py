"""story 4955 — a late CI webhook of an OLD commit must not rebind a pending merge gate (nor set its approval anchor).

`gate.pr_head_observed_sha`: the PR's current head commit as the pull_request lifecycle webhooks (opened · reopened · ready_for_review · synchronize) last announced it. It is
written in the same atomic statement as the existing watermark `pr_head_observed_at` (0273) and only when that delivery is not older than the watermark, so a late old lifecycle
webhook cannot turn it back either. The CI / check webhooks (`workflow_run` · `check_suite` · `status`) carry the commit THEY ran on: when that is not this value they are the news of an
old commit and the merge gate ignores them. NULL (a gate whose lifecycle webhook was not seen yet) = no rule, as before.

Additive only: no backfill (a gate learns it from its next lifecycle webhook). Downgrade drops the column.

Revision ID: 0478
Revises: 0477
Create Date: 2026-11-15
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0478"
down_revision = "0477"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("pr_head_observed_sha", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("gate", "pr_head_observed_sha")
