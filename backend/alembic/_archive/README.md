# Archived migrations (pre-baseline-squash)

These are the historical `0000`→`0096` incremental migrations, retained for reference only.
They are intentionally OUTSIDE `alembic/versions/` so Alembic does NOT scan them.

The active chain was squashed into a single fresh-runnable baseline at
`alembic/versions/0096_baseline_squash.py` (revision `0096`, `down_revision = None`) because the
historical chain was not fresh-runnable (0004 referenced `team_members` before it was created).

Do not move these back into `versions/` — doing so reintroduces multiple heads and the broken
fresh-install path. See the baseline migration's docstring for the full rationale.
