"""story 4976 — a phone's instruction (send_prompt) keeps no word once it is over.

`desktop_commands.payload` of a `send_prompt` held the instruction's TEXT (and the phone's plain signature, which carries an unsalted sha256 of that text) for ever — also after the press ended
(done · failed · rejected). The payload is the delivery copy for the computer; 선생님 11-16: the automatic deletion is for the delivery copy only, once the press is over. The code that ends a press now
empties it in the same statement (`ended_prompt_payload`), and a sealed instruction (envelope) is emptied the same way. This migration finishes the old rows, ONCE:

- every `send_prompt` command that is OVER (`done` · `failed` · `rejected`) keeps `{session_key, conversation_id}` and nothing else (no `text` · `signed` · `envelope`);
- a `send_prompt` that is still OPEN (`queued` · `delivered` · `acked`) is not touched — the computer may still be sent or may still be reading it.

The conversation line the server wrote for a done instruction (a message in the person's own conversation — the user's record, not the delivery copy) is not touched; story 4977 replaces the record.

No schema change (no CHECK on `payload`). One UPDATE, row locks only; dev measured by the PO before the run: 9 rows (done 6 · rejected 3), none open. Downgrade is a no-op: the words cannot come back.
"""
from alembic import op

revision = "0485"
down_revision = "0484"
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


def downgrade() -> None:
    pass
