"""story #4404 — create-once claims for the publication worker: an ads boost run's campaign and a channel publication's container.

Two boost_start commands for the same gate can be in flight together (a re-approval gives a new approved_version, and
commands are unique per version, not per gate), and the run row is one per gate. Before, the only guard was the first
attempt's uncommitted run INSERT — a second start queued on the unique index until the first committed; a run already
committed without ids had no guard at all. The worker now ends its transaction before provider calls (story #4404), so the
guard is explicit:

- `create_claimed_at` — a conditional UPDATE claims the creation; only the winner calls Meta, the loser retries later.
- `create_call_started_at` — committed right before the create call. A claim that has expired **with** this marker and no
  campaign ids means the outcome is unknown (Meta may have created it) → needs_check, never an automatic re-create. Only a
  claim that expired **without** it (the worker died before calling) is claimed again.

The same for a channel publication's container (`channel_publications.container_claimed_at`): the row used to stay
uncommitted during the upload (up to 900 s for YouTube), which is what kept a second publisher of the same gate/version out.
It is now committed as the claim before the call; a second publisher that finds a live claim on a row without a container
gets «publish in progress» at once instead of creating a second container.

Additive only (nullable columns): code running before this deploy never reads them.

Revision ID: 0419
Revises: 0418
"""
import sqlalchemy as sa

from alembic import op

revision = "0419"
down_revision = "0418"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ads_boost_runs", sa.Column("create_claimed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("ads_boost_runs", sa.Column("create_call_started_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("channel_publications", sa.Column("container_claimed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("channel_publications", "container_claimed_at")
    op.drop_column("ads_boost_runs", "create_call_started_at")
    op.drop_column("ads_boost_runs", "create_claimed_at")
