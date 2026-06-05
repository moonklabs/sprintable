"""baseline squash — dev 0096 end-state schema + global system seed as a single fresh-runnable root.

WHY: the historical 0000→0096 incremental chain is NOT fresh-runnable (migration 0004 references
`team_members` before any migration creates it; the table predates the alembic chain — it came from
the original Supabase/create_all era). Running `alembic upgrade head` on an EMPTY DB therefore
failed at 0004, which the OSS `create_all` shortcut had been silently masking. That shortcut built
the schema from the SQLAlchemy *models*, which have drifted from the migration end-state
(`team_members` is a VIEW since 0088; `project_access.org_member_id` NOT NULL was dropped in 0075),
so a freshly-provisioned SaaS DB diverged from dev and broke onboarding (project_access NOT NULL 500).

FIX (baseline squash, no historical replay): capture dev's verified current schema (the 0096
end-state) as one baseline migration so the chain is fresh-runnable again. The old 0000→0096 files
are moved to `alembic/_archive/` (out of the scanned versions dir); this file is the sole root+head.

revision id is intentionally **"0096"** (same as the prior head): existing DBs already stamped at
"0096" (dev) are therefore already at head — `alembic upgrade head` is a pure no-op, no stamp and
no re-run needed. A FRESH/empty DB runs this baseline (schema.sql + seed.sql) and is stamped to head.

SCOPE of the baseline:
- schema.sql  : pg_dump --schema-only of dev (tables/views/constraints/indexes/extensions). Exact
                parity with dev verified (column + index fingerprints identical on temp-DB replay).
- seed.sql    : global system reference data ONLY — workflow_templates (is_system) + plan_features.
                EXCLUDED: workflow_trigger_types (org-scoped, app self-seeds per org) and all
                org/user/content data (a fresh install must start empty).

Future migrations chain from this baseline (down_revision = "0096").
"""
from __future__ import annotations

import os

from alembic import op

# revision identifiers, used by Alembic.
revision = "0096"
down_revision = None
branch_labels = None
depends_on = None

_BASELINE_DIR = os.path.join(os.path.dirname(__file__), os.pardir, "baseline")


def _run_sql_file(filename: str) -> None:
    path = os.path.join(_BASELINE_DIR, filename)
    with open(path, "r", encoding="utf-8") as fh:
        sql = fh.read()
    if sql.strip():
        # Multi-statement DDL/DML batch — execute via the raw driver connection.
        op.get_bind().exec_driver_sql(sql)


def upgrade() -> None:
    # Ensure the version table exists before the schema batch. On a brand-new DB driven through
    # the from-base incremental path, the alembic_version row is inserted right after this
    # migration's upgrade() returns; guarantee the table is present (idempotent — a no-op if
    # Alembic already created it). The schema dump excludes alembic_version (Alembic owns it).
    op.execute(
        "CREATE TABLE IF NOT EXISTS alembic_version ("
        "version_num VARCHAR(32) NOT NULL, "
        "CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))"
    )
    _run_sql_file("schema.sql")
    _run_sql_file("seed.sql")


def downgrade() -> None:
    # A squashed baseline is not reversibly downgradable — there is no prior schema to return to.
    raise NotImplementedError("baseline squash (0096) cannot be downgraded")
