"""story 4972 — a terminal-only question can be sealed too (the card of «answer it at that computer's terminal» keeps its words off the server as well).

0479 let a request carry its words as one sealed envelope the server cannot open, and kept «a terminal-only row is never sealed» — so the masked summary of a terminal-only question
stayed on the server as text. The person's decision is that what a sealed card says is not readable by the server: a terminal-only card is sealed like the others (it has no buttons
and no hash — nothing is signed — only words to read).

- the CHECK of 0479: the terminal-only branch no longer says `NOT sealed`. Everything else is as it was: a sealed row carries no word as text, is at stage «ask», has its envelope only as a JSON object;
  a terminal-only row never has a hash (sealed or not); an answerable row keeps its hash and needs tool AND summary as text, or to be sealed.
- A new coupling in the same CHECK: a request holds its envelope exactly while it is pending (`state = 'pending' OR envelope IS NULL` — an ended row has let it go — and a pending sealed row has it).
  Every path that ends a request already empties the envelope in the same statement; the database now says so (before, only the code did, and a terminal-only row could newly hold one).
- No row changes on upgrade; for what the old revision writes the rule only gets looser or already holds (a sealed row is pending with its envelope, an ended one without — the code of 0479 does exactly that).
  The new CHECK is added NOT VALID and then validated (the old rule is dropped first, so the table is never without a rule). NOTE: every migration of one run shares ONE transaction here (`env.py` — no `transaction_per_migration`),
  so the lock the DROP / ADD takes is held through the VALIDATE scan to the commit: writes to this table wait for as long as the scan runs. The table is small, so that is short; the VALIDATE would fail the whole run (and roll it back)
  if a row broke the rule.
Downgrade keeps every sealed terminal-only row as a plain terminal-only card with no words (its state, decision and who answered it are kept; its envelope and sealed mark go), then restores 0479's rule.
"""
from alembic import op

revision = "0480"
down_revision = "0479"
branch_labels = None
depends_on = None

_CHECK = "ck_agent_permission_requests_terminal_only_fields"
_ROW_WORDS = (
    "(envelope IS NULL OR (sealed AND jsonb_typeof(envelope) = 'object')) AND "
    "(NOT sealed OR (tool IS NULL AND summary IS NULL AND workdir IS NULL AND host IS NULL AND (preview IS NULL OR preview = 'null'::jsonb) AND stage = 'ask')) AND "
)
_NEW_RULE = _ROW_WORDS + (
    "((terminal_only AND input_hash IS NULL) OR "
    "(NOT terminal_only AND (input_hash IS NOT NULL OR (sealed AND state <> 'pending')) AND ((tool IS NOT NULL AND summary IS NOT NULL) OR sealed))) AND "
    "(state = 'pending' OR envelope IS NULL) AND (NOT sealed OR state <> 'pending' OR envelope IS NOT NULL)"
)
_OLD_RULE = _ROW_WORDS + (
    "((terminal_only AND input_hash IS NULL AND NOT sealed) OR "
    "(NOT terminal_only AND (input_hash IS NOT NULL OR (sealed AND state <> 'pending')) AND ((tool IS NOT NULL AND summary IS NOT NULL) OR sealed)))"
)


# a sealed terminal-only row cannot keep its shape under 0479's rule: it stays as a terminal-only card without words
_DOWNGRADE_SQL = "UPDATE agent_permission_requests SET envelope = NULL, sealed = false WHERE sealed AND terminal_only"


def upgrade() -> None:
    op.drop_constraint(_CHECK, "agent_permission_requests", type_="check")
    op.execute(f"ALTER TABLE agent_permission_requests ADD CONSTRAINT {_CHECK} CHECK ({_NEW_RULE}) NOT VALID")
    op.execute(f"ALTER TABLE agent_permission_requests VALIDATE CONSTRAINT {_CHECK}")


def downgrade() -> None:
    op.drop_constraint(_CHECK, "agent_permission_requests", type_="check")
    op.execute(_DOWNGRADE_SQL)
    op.execute(f"ALTER TABLE agent_permission_requests ADD CONSTRAINT {_CHECK} CHECK ({_OLD_RULE}) NOT VALID")
    op.execute(f"ALTER TABLE agent_permission_requests VALIDATE CONSTRAINT {_CHECK}")
