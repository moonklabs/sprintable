"""story 5025 (B1) — the computer's «seal_to_v1» mark: it has said it asks who may read a card before it seals one.

One nullable column on `desktop_setups`: `seal_to_v1_at` — the server's own now() of the FIRST pin report of that setup that carried `capabilities: ["seal_to_v1"]` (a host that asks `seal-targets` before it seals
says so there, after the server has answered it once). One way: never cleared, never moved earlier (a trigger says so in the database — an ORM that writes the whole row, or a hand-typed UPDATE, cannot undo it): a setup
that declared once is checked on EVERY sealed card from then on (`to` must be a subset of the receiver's phones), even when an older build of the host later joins the same setup without the declaration.

Additive and inert until the code reads it: no backfill — a setup that never declared has NULL, so today's hosts (and every card they seal) are untouched at deploy. A running old revision never reads or writes it,
so the migration is safe to run before the code that uses it. Downgrade drops the trigger, the function and the column.

Revision ID: 0499
Revises: 0498
"""
import sqlalchemy as sa
from alembic import op

revision = "0499"
down_revision = "0498"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_setups", sa.Column("seal_to_v1_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(
        """
        CREATE OR REPLACE FUNCTION desktop_setups_seal_to_v1_one_way()
        RETURNS trigger AS $$
        BEGIN
            IF OLD.seal_to_v1_at IS NOT NULL AND NEW.seal_to_v1_at IS DISTINCT FROM OLD.seal_to_v1_at THEN
                RAISE EXCEPTION 'desktop_setups.seal_to_v1_at is one-way — it is never cleared or changed'
                    USING ERRCODE = 'raise_exception';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_desktop_setups_seal_to_v1_one_way ON desktop_setups")
    op.execute(
        """
        CREATE TRIGGER trg_desktop_setups_seal_to_v1_one_way
        BEFORE UPDATE ON desktop_setups
        FOR EACH ROW EXECUTE FUNCTION desktop_setups_seal_to_v1_one_way();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_desktop_setups_seal_to_v1_one_way ON desktop_setups")
    op.execute("DROP FUNCTION IF EXISTS desktop_setups_seal_to_v1_one_way()")
    op.drop_column("desktop_setups", "seal_to_v1_at")
