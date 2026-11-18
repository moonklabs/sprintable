"""story 4972 (AC3 ①) — the computer's «sealed cards» mark: it has sent a card sealed.

One nullable column on `desktop_setups`: `sealed_cards_at` — the server's own now() of the FIRST committed sealed card whose receivers all were pinned phones of that computer. One way: never cleared, never moved
earlier (a trigger says so in the database — an ORM that writes the whole row, or a hand-typed UPDATE, cannot undo it). A computer with the mark (or a sibling setup of the same Mac in the same organization — read by
`org_id + machine_key`) no longer takes a PLAINTEXT card (422 `sealed_required`; the network question's fixed first stage is the one exception).

Additive and inert until the code reads it: no backfill — a computer that never sealed has NULL, so today's plaintext cards (and the computers that send them) are untouched at deploy.
Downgrade drops the trigger, the function and the column (an operations rollback: protection is gone until the migration comes back; code rolled back alone leaves the column and an older code does not read it).
"""
import sqlalchemy as sa
from alembic import op

revision = "0483"
down_revision = "0482"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_setups", sa.Column("sealed_cards_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(
        """
        CREATE OR REPLACE FUNCTION desktop_setups_sealed_cards_one_way()
        RETURNS trigger AS $$
        BEGIN
            IF OLD.sealed_cards_at IS NOT NULL AND NEW.sealed_cards_at IS DISTINCT FROM OLD.sealed_cards_at THEN
                RAISE EXCEPTION 'desktop_setups.sealed_cards_at is one-way — it is never cleared or changed'
                    USING ERRCODE = 'raise_exception';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_desktop_setups_sealed_cards_one_way ON desktop_setups")
    op.execute(
        """
        CREATE TRIGGER trg_desktop_setups_sealed_cards_one_way
        BEFORE UPDATE ON desktop_setups
        FOR EACH ROW EXECUTE FUNCTION desktop_setups_sealed_cards_one_way();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_desktop_setups_sealed_cards_one_way ON desktop_setups")
    op.execute("DROP FUNCTION IF EXISTS desktop_setups_sealed_cards_one_way()")
    op.drop_column("desktop_setups", "sealed_cards_at")
