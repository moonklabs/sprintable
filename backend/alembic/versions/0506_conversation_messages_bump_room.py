"""[SID:5053] a message that enters a room, by ANY road, lifts the room in the list — enforced by the database, once.

The conversation list is ordered by `conversations.updated_at`. Only some of the roads that put a message into a room raised it (the plain send does; the approval card, the activation / approval_target cards, the agent-action
reply, the system lines and the rest did not), so a room whose last word came by a card road stayed at its old place and the person never saw there was something new. Fixing the ~12 roads one by one would
leave the 13th; the guarantee is made where every road ends: an AFTER INSERT trigger on `conversation_messages` raises the room's `updated_at` to the message's `created_at` (never lowers it: only when the room is older; a time in the future counts as «now», so an
imported or hand-stamped message cannot pin a room to the top).

Also corrects the rooms already out of step: `updated_at` becomes the time of the room's last message where that is later (one UPDATE, run after the trigger exists so no message slips between).

A running old revision lives with it: it never names the trigger; the room update it already does itself is a no-op next to the trigger's (same row, the same or a later time); the trigger writes only when the room is OLDER than the message.
Downgrade drops the trigger and the function (the corrected times stay).

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
        CREATE OR REPLACE FUNCTION conversation_messages_bump_room() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
            UPDATE conversations SET updated_at = LEAST(NEW.created_at, now()) WHERE id = NEW.conversation_id AND updated_at < LEAST(NEW.created_at, now());
            RETURN NULL;
        END
        $fn$
        """
    )
    op.execute("DROP TRIGGER IF EXISTS trg_conversation_messages_bump_room ON conversation_messages")
    op.execute("CREATE TRIGGER trg_conversation_messages_bump_room AFTER INSERT ON conversation_messages FOR EACH ROW EXECUTE FUNCTION conversation_messages_bump_room()")
    # after the trigger exists, so no message slips between: the rooms already out of step get the time of their last word
    op.execute(
        """
        UPDATE conversations c SET updated_at = LEAST(m.last_at, now())
        FROM (SELECT conversation_id, max(created_at) AS last_at FROM conversation_messages GROUP BY conversation_id) m
        WHERE m.conversation_id = c.id AND LEAST(m.last_at, now()) > c.updated_at
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_conversation_messages_bump_room ON conversation_messages")
    op.execute("DROP FUNCTION IF EXISTS conversation_messages_bump_room()")
