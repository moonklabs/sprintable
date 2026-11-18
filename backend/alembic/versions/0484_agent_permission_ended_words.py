"""story 4972 — a plain card's words (tool · summary · workdir) go when its question ends.

0479 / 0480 already made a SEALED card hold no word as text, and every path that ends a request empties its envelope · preview · hash in the same statement. The plaintext words of a plain card stayed
on the row for ever (카디르's 5848 lens · 선생님 11-16: the automatic deletion is for the delivery copy only, once the question is over). This migration finishes it:

- the CHECK `ck_agent_permission_requests_terminal_only_fields`: an answerable plain row's words (`tool` AND `summary`) are required only while it is PENDING (`... OR sealed OR state <> 'pending'`). Everything else is as 0480 left it.
  Added NOT VALID, then validated (the old rule is dropped first, so the table is never without a rule; one transaction for the whole run — the VALIDATE scan holds the lock to the commit, the table is small).
- ONE data change, once (the code that ends a question now does the same in the same statement, so it never has to run again): every row that is OVER keeps no plain word —
  (a) a PENDING row whose window passed and that still holds words ends as `expired` (what the minute job does for it from now on: its envelope · preview · sealed hash go too),
  (b) every other ended row (answered · rejected · expired · withdrawn) loses `tool · summary · workdir`.
  Open cards are not touched. The one exception by shape: the network question's FIXED vocabulary (`runtime = claude AND tool = SandboxNetwork`, and its `summary`): no word of the person's, and the same row is opened
  again for its second (confirm) stage, which the card draws from it. `host` is not in this change.
Downgrade restores 0480's rule. The words cannot come back: an ended plain row whose words are gone becomes a terminal-only history row (no hash — the only shape the old rule lets lack tool · summary); its state · decision ·
who answered it are kept.
"""
from alembic import op

revision = "0484"
down_revision = "0483"
branch_labels = None
depends_on = None

_CHECK = "ck_agent_permission_requests_terminal_only_fields"
_ROW_WORDS = (
    "(envelope IS NULL OR (sealed AND jsonb_typeof(envelope) = 'object')) AND "
    "(NOT sealed OR (tool IS NULL AND summary IS NULL AND workdir IS NULL AND host IS NULL AND (preview IS NULL OR preview = 'null'::jsonb) AND stage = 'ask')) AND "
)
_NEW_RULE = _ROW_WORDS + (
    "((terminal_only AND input_hash IS NULL) OR "
    "(NOT terminal_only AND (input_hash IS NOT NULL OR (sealed AND state <> 'pending')) AND ((tool IS NOT NULL AND summary IS NOT NULL) OR sealed OR state <> 'pending'))) AND "
    "(state = 'pending' OR envelope IS NULL) AND (NOT sealed OR state <> 'pending' OR envelope IS NOT NULL)"
)
_OLD_RULE = _ROW_WORDS + (
    "((terminal_only AND input_hash IS NULL) OR "
    "(NOT terminal_only AND (input_hash IS NOT NULL OR (sealed AND state <> 'pending')) AND ((tool IS NOT NULL AND summary IS NOT NULL) OR sealed))) AND "
    "(state = 'pending' OR envelope IS NULL) AND (NOT sealed OR state <> 'pending' OR envelope IS NOT NULL)"
)

_NET = "(runtime = 'claude' AND tool = 'SandboxNetwork')"
# a row that still holds a plain word that is not the network question's fixed vocabulary
_HOLDS_PLAIN = f"(workdir IS NOT NULL OR (NOT {_NET} AND (tool IS NOT NULL OR summary IS NOT NULL)))"
_KEEP_NET = f"CASE WHEN {_NET} THEN tool END"
_KEEP_NET_SUMMARY = f"CASE WHEN {_NET} THEN summary END"

# (a) a window that passed without an answer: the row ends here as the minute job ends it from now on
_END_PENDING = f"""
UPDATE agent_permission_requests
   SET state = 'expired', result_code = 'expired', envelope = NULL, preview = NULL,
       input_hash = CASE WHEN sealed THEN NULL ELSE input_hash END,
       tool = {_KEEP_NET}, summary = {_KEEP_NET_SUMMARY}, workdir = NULL
 WHERE state = 'pending' AND expires_at <= now()
   AND (envelope IS NOT NULL OR jsonb_typeof(preview) = 'object' OR {_HOLDS_PLAIN})
"""
# (b) every other ended row
_CLEAR_ENDED = f"""
UPDATE agent_permission_requests
   SET tool = {_KEEP_NET}, summary = {_KEEP_NET_SUMMARY}, workdir = NULL
 WHERE state <> 'pending' AND {_HOLDS_PLAIN}
"""
# the words cannot come back: an ended plain row without them is kept as a terminal-only history row (the old rule's one shape that may lack tool · summary — and then it has no hash)
_DOWNGRADE_SQL = """
UPDATE agent_permission_requests SET terminal_only = true, input_hash = NULL
 WHERE NOT terminal_only AND NOT sealed AND state <> 'pending' AND (tool IS NULL OR summary IS NULL)
"""


def upgrade() -> None:
    op.drop_constraint(_CHECK, "agent_permission_requests", type_="check")
    op.execute(f"ALTER TABLE agent_permission_requests ADD CONSTRAINT {_CHECK} CHECK ({_NEW_RULE}) NOT VALID")
    op.execute(_END_PENDING)
    op.execute(_CLEAR_ENDED)
    op.execute(f"ALTER TABLE agent_permission_requests VALIDATE CONSTRAINT {_CHECK}")


def downgrade() -> None:
    op.drop_constraint(_CHECK, "agent_permission_requests", type_="check")
    op.execute(_DOWNGRADE_SQL)
    op.execute(f"ALTER TABLE agent_permission_requests ADD CONSTRAINT {_CHECK} CHECK ({_OLD_RULE}) NOT VALID")
    op.execute(f"ALTER TABLE agent_permission_requests VALIDATE CONSTRAINT {_CHECK}")
