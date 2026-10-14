"""[SID:4686] (PO 10-14 01:06Z · Yuna run-info-1014.md) — a session says what it really runs on: the model, the thinking depth, the account.

10-13: eight sessions started with `model: null` (the profile named no model) — the CLI's own default ran, and nothing on the board, the
phone or the web said which; five lanes stood at that model's usage limit and nobody could tell why the PO's session (another model) kept
working. desktop_sessions gets four nullable columns, all set by the report that carries `run` (a report without it clears them, like
`instruct_now`):

- run_model      TEXT     — the model that ran: the last real assistant line of the transcript, else the profile's value
- run_model_set  BOOLEAN  — whether the profile NAMED a model (false = the runtime's default ran)
- run_effort     TEXT     — the thinking depth the profile gave (a closed word) — NULL = the default
- run_account    TEXT     — the account's display label (Claude only), already masked by the daemon: «{orgName or yo***@host} ({Plan})»

Additive only: no backfill (existing rows read as «not said»), no index. Length caps in the DB too (the API check alone is not the last word).
"""
import sqlalchemy as sa

from alembic import op

revision = "0453"
down_revision = "0452"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_sessions", sa.Column("run_model", sa.Text(), nullable=True))
    op.add_column("desktop_sessions", sa.Column("run_model_set", sa.Boolean(), nullable=True))
    op.add_column("desktop_sessions", sa.Column("run_effort", sa.Text(), nullable=True))
    op.add_column("desktop_sessions", sa.Column("run_account", sa.Text(), nullable=True))
    op.create_check_constraint("ck_desktop_sessions_run_model_len", "desktop_sessions", "run_model IS NULL OR char_length(run_model) <= 70")
    op.create_check_constraint("ck_desktop_sessions_run_account_len", "desktop_sessions", "run_account IS NULL OR char_length(run_account) <= 80")
    op.create_check_constraint(
        "ck_desktop_sessions_run_effort", "desktop_sessions",
        "run_effort IS NULL OR run_effort IN ('low','medium','high','xhigh','max','ultra')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_desktop_sessions_run_effort", "desktop_sessions", type_="check")
    op.drop_constraint("ck_desktop_sessions_run_account_len", "desktop_sessions", type_="check")
    op.drop_constraint("ck_desktop_sessions_run_model_len", "desktop_sessions", type_="check")
    op.drop_column("desktop_sessions", "run_account")
    op.drop_column("desktop_sessions", "run_effort")
    op.drop_column("desktop_sessions", "run_model_set")
    op.drop_column("desktop_sessions", "run_model")
