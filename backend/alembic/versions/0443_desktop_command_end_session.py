"""story #4599 (E-DESKTOP-2 · relay contract v1.13.2 · PO 2026-10-07 14:08Z) — a person's signed end of the whole session.

- desktop_commands.kind takes one more word: `end_session` — from the phone's [세션 끝내기], the one handle on a turn a macOS
  «Files and Folders» window holds (a stop cannot reach a process sitting in `openat`; the daemon never turns a stop into an end
  behind the person's back — PO 12:40Z ④ · 14:18Z). The phone signs this kind, so what was signed is what happens; the daemon ends
  the session (SIGHUP → 3 s → SIGKILL, Mirko 385) and reports `stopped`.
The CHECK is dropped and made again with the five kinds (the code side is app/models/desktop_relay.COMMAND_KINDS — a test holds
them together). No row changes: every stored value is one of the four, all still allowed.
"""
from alembic import op

revision = "0443"
down_revision = "0442"
branch_labels = None
depends_on = None

_OLD = ("start_session", "send_prompt", "answer_approval", "stop_session")
_NEW = ("start_session", "send_prompt", "answer_approval", "stop_session", "end_session")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _NEW))


def downgrade() -> None:
    # a row of the new kind cannot stay under the old CHECK, and a server from before has no command it could stand for (a stop is
    # weaker — it would not be what the phone signed): the rows go. Open ones were never delivered by that server anyway.
    op.execute("DELETE FROM desktop_commands WHERE kind = 'end_session'")
    op.drop_constraint("ck_desktop_commands_kind", "desktop_commands", type_="check")
    op.create_check_constraint("ck_desktop_commands_kind", "desktop_commands", _in("kind", _OLD))
