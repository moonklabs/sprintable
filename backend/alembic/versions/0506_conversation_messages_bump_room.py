"""[SID:5053] a message that enters a room, by ANY road, lifts the room in the list — enforced by the database, once.

The conversation list is ordered by `conversations.updated_at`. Only some of the roads that put a message into a room raised it (the plain send does; the approval card, the activation / approval_target cards, the
agent-action reply, the system lines and the rest did not), so a room whose last word came by a card road stayed at its old place and the person never saw there was something new. Fixing the ~12 roads one by one would
leave the 13th; the guarantee is made where every road ends: an AFTER INSERT trigger on `conversation_messages` raises the room's `updated_at` to the message's `created_at` — only when the room is OLDER (it never lowers
a room); a time in the future counts as «now» (an imported or hand-stamped message cannot pin a room to the top); the bound is `clock_timestamp()` (the message default of 0448 is the statement clock too, so a
message put in late in a long transaction is not older than its room's time).

This migration is the TRIGGER only. The rooms already out of step are corrected by the job `scripts/jobs/backfill_conversation_updated_at.py` (idempotent, chunked, its own short transactions): done here it was one
UPDATE over every organization's rooms inside the migration's transaction — every changed room's row lock held until the migration committed, so a live send into such a room waited for it.

The function pins `search_path` and names `public.conversations` (a `SECURITY INVOKER` trigger function must not resolve names through the caller's path).

A running old revision lives with it: it never names the trigger; the room update it already does itself on some roads is the same row at the same or an earlier time (the trigger writes only when the room is OLDER than the message).
Downgrade drops the trigger and the function.

Revision ID: 0506
Revises: 0505
Create Date: 2026-11-27
"""
from alembic import op

revision = "0506"
down_revision = "0505"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # the statements are written HERE (not in a constant) so the cutover reading, which prints what upgrade() itself runs, lists every one of them
    op.execute(
        """
        CREATE OR REPLACE FUNCTION conversation_messages_bump_room() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
        BEGIN
            UPDATE public.conversations SET updated_at = LEAST(NEW.created_at, clock_timestamp()) WHERE id = NEW.conversation_id AND updated_at < LEAST(NEW.created_at, clock_timestamp());
            RETURN NULL;
        END
        $fn$
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_conversation_messages_bump_room ON conversation_messages")
    op.execute("CREATE TRIGGER trg_conversation_messages_bump_room AFTER INSERT ON conversation_messages FOR EACH ROW EXECUTE FUNCTION conversation_messages_bump_room()")


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_conversation_messages_bump_room ON conversation_messages")
    op.execute("DROP FUNCTION IF EXISTS conversation_messages_bump_room()")
