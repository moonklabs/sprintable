"""story 4976 (A5) — the computer's «sealed instructions» mark: its app has said it opens a sealed instruction.

One nullable column on `desktop_setups`: `sealed_prompts_at` — the server's own now() of the FIRST time the computer's app said `sealed_prompt` with its startable list. One way: never cleared, never moved
(a trigger says so in the database — an ORM that writes the whole row, or a hand-typed UPDATE, cannot undo it; the same shape as 0483's `sealed_cards_at`). A computer with the mark (or a sibling setup of the same Mac in
the same organization — read by `org_id + machine_key`) no longer takes a PLAINTEXT instruction into a running turn (422 `sealed_required`): the words only ever pass the server as an envelope.

Backfill: a computer whose list ALREADY says `sealed_prompt` (the word exists since the app that opens a sealed instruction — a few days) gets the mark now, so deploy closes the plaintext road for it at once; a computer that
never said it (an older app) has NULL, so what it does today is untouched.
Downgrade drops the trigger, the function and the column (an operations rollback: protection is gone until the migration comes back; code rolled back alone leaves the column and an older code does not read it).
"""
import sqlalchemy as sa
from alembic import op

revision = "0489"
down_revision = "0488"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("desktop_setups", sa.Column("sealed_prompts_at", sa.DateTime(timezone=True), nullable=True))
    op.execute("UPDATE desktop_setups SET sealed_prompts_at = now() WHERE capabilities @> '[\"sealed_prompt\"]'::jsonb")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION desktop_setups_sealed_prompts_one_way()
        RETURNS trigger AS $$
        BEGIN
            IF OLD.sealed_prompts_at IS NOT NULL AND NEW.sealed_prompts_at IS DISTINCT FROM OLD.sealed_prompts_at THEN
                RAISE EXCEPTION 'desktop_setups.sealed_prompts_at is one-way — it is never cleared or changed'
                    USING ERRCODE = 'raise_exception';
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_desktop_setups_sealed_prompts_one_way ON desktop_setups")
    op.execute(
        """
        CREATE TRIGGER trg_desktop_setups_sealed_prompts_one_way
        BEFORE UPDATE ON desktop_setups
        FOR EACH ROW EXECUTE FUNCTION desktop_setups_sealed_prompts_one_way();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_desktop_setups_sealed_prompts_one_way ON desktop_setups")
    op.execute("DROP FUNCTION IF EXISTS desktop_setups_sealed_prompts_one_way()")
    op.drop_column("desktop_setups", "sealed_prompts_at")
