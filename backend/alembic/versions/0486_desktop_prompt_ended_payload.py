"""story 4976 — a phone's instruction (send_prompt) keeps no word once it is over.

`desktop_commands.payload` of a `send_prompt` held the instruction's TEXT (and the phone's plain signature, which carries an unsalted sha256 of that text) for ever — also after the press ended
(done · failed · rejected). The payload is the delivery copy for the computer; 선생님 11-16: the automatic deletion is for the delivery copy only, once the press is over. The code that ends a press now
empties it in the same statement (`ended_prompt_payload`), and a sealed instruction (envelope) is emptied the same way. This migration finishes the old rows, ONCE:

- every `send_prompt` command that is OVER (`done` · `failed` · `rejected`) keeps `{session_key, conversation_id}` and nothing else (no `text` · `signed` · `envelope`);
- a `send_prompt` that is still OPEN (`queued` · `delivered` · `acked`) is not touched — the computer may still be sent or may still be reading it.

The conversation line the server wrote for a done instruction (a message in the person's own conversation — the user's record, not the delivery copy) is not touched; story 4977 replaces the record.

No schema change (no CHECK on `payload`). One UPDATE, row locks only; dev measured by the PO before the run: 9 rows (done 6 · rejected 3), none open. Downgrade is a no-op: the words cannot come back.

Kadir lens 5850 (low): the minute sweep (`purge_stale_prompts`) reads two sets of `send_prompt` rows by time — the OPEN ones older than ten minutes, and the FINISHED ones of the last day that still hold words — and
`desktop_commands` had no index to start from `created_at`, so each read walked the whole table every minute (measured 77 ms and 85 ms on a million rows). Two partial indexes, one per set, serve them as range reads
(each holds only that state group of instruction rows; the open set is a handful of rows at any time). Two plain CREATE INDEX statements: a brief write lock on a table of recent commands, nothing rewritten.
"""
from alembic import op
import sqlalchemy as sa

revision = "0486"
down_revision = "0485"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE desktop_commands
           SET payload = jsonb_build_object('session_key', payload -> 'session_key', 'conversation_id', payload -> 'conversation_id')
         WHERE kind = 'send_prompt'
           AND state IN ('done', 'failed', 'rejected')
           AND (payload ? 'text' OR payload ? 'signed' OR payload ? 'envelope')
        """
    )
    op.create_index(
        "ix_desktop_commands_prompt_open_created", "desktop_commands", ["created_at"],
        postgresql_where=sa.text("kind = 'send_prompt' AND state IN ('queued', 'delivered', 'acked')"),
    )
    op.create_index(
        "ix_desktop_commands_prompt_ended_created", "desktop_commands", ["created_at"],
        postgresql_where=sa.text("kind = 'send_prompt' AND state IN ('done', 'failed', 'rejected')"),
    )


def downgrade() -> None:
    # the scrub above cannot be undone (the words are gone); only the two indexes go
    op.drop_index("ix_desktop_commands_prompt_ended_created", table_name="desktop_commands")
    op.drop_index("ix_desktop_commands_prompt_open_created", table_name="desktop_commands")
