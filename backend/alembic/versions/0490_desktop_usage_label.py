"""story 4986 (P7 AC3 server side + AC4) — `desktop_usage.label`: the name a person gave the account on the computer.

The host (desktop-electron `claude-account-labels.ts`) keeps a short, plain display name for each Claude settings folder; it now says it with the usage report so the phone's «사용량» sheet can tell two accounts
of one CLI apart by name instead of by a number. Additive and nullable: nothing is backfilled, an old host sends none, and a report WITHOUT a label clears the stored one (the host is the one who speaks for the entry).
Only the length is held in the table; the rest of the rule (no slash, no control or direction character, no space at an end) is the door's (`desktop_usage.label_problem`) and is applied again when a row is read.
"""
import sqlalchemy as sa

from alembic import op

revision = "0490"
down_revision = "0489"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_usage", sa.Column("label", sa.Text(), nullable=True))
    op.create_check_constraint("ck_desktop_usage_label", "desktop_usage", "label IS NULL OR char_length(label) BETWEEN 1 AND 40")


def downgrade() -> None:
    op.drop_constraint("ck_desktop_usage_label", "desktop_usage", type_="check")
    op.drop_column("desktop_usage", "label")
