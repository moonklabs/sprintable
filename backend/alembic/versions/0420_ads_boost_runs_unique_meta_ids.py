"""story #4412 (Qadir 01a0eada ① · PO 01:59Z) — a Meta campaign · ad set · ad is linked to at most one ads boost run.

Before 4412 every run created its own Meta objects, so their ids could not repeat across runs. «Link existing campaign»
adopts an object found by name: two runs of the same post, both stopped as «outcome unknown» while only one campaign was
made, could each read «not recorded on another run» before either wrote, then each lock only its own row — and both adopt it
(one campaign carrying two approvals). A check in the application cannot close that race; the invariant belongs to the DB:
partial unique indexes on the three ids (NULL = not created yet, many allowed).

Before creating them the migration counts rows that already share an id and stops with the counts if any exist (dev: 3 rows, 0
shared, counted 2026-09-29 02:05Z through the pgstat-probe-dev job) — a unique index cannot be created over duplicates, and a
clear message beats the index error.

Revision ID: 0420
Revises: 0419
"""
import sqlalchemy as sa

from alembic import op

revision = "0420"
down_revision = "0419"
branch_labels = None
depends_on = None

_COLUMNS = ("campaign_id", "adset_id", "ad_id")


def upgrade() -> None:
    bind = op.get_bind()
    shared = {
        col: bind.execute(sa.text(
            f"SELECT count(*) FROM (SELECT {col} FROM ads_boost_runs WHERE {col} IS NOT NULL "
            f"GROUP BY {col} HAVING count(*) > 1) d"
        )).scalar_one()
        for col in _COLUMNS
    }
    if any(shared.values()):
        raise RuntimeError(
            f"0420: ads_boost_runs already has Meta ids shared by several runs {shared} — resolve them before the unique indexes"
        )
    for col in _COLUMNS:
        op.create_index(
            f"uq_ads_boost_runs_{col}", "ads_boost_runs", [col], unique=True,
            postgresql_where=sa.text(f"{col} IS NOT NULL"),
        )


def downgrade() -> None:
    for col in reversed(_COLUMNS):
        op.drop_index(f"uq_ads_boost_runs_{col}", table_name="ads_boost_runs")
