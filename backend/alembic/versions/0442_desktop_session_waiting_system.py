"""story #4599 (E-DESKTOP-2 · relay contract v1.13 · PO 2026-10-07 12:27Z) — a turn held by a macOS window reaches the phone and the web.

- desktop_sessions.state takes one more word: `waiting_system` — the agent's turn is held by a macOS «Files and Folders» window on
  that computer (a question only the person at the Mac can answer: Claude sits in `openat`, CPU 0, output 0, no hook). Before, the
  daemon could only say `working` — 42 minutes of «작업 중» on 10-07 (Kadir's app session) with nothing to see anywhere.
- a reader from before sees it as `working` (services.desktop_relay.legacy_state); the word itself goes in `activity`.
- `system_folder` (Kadir lens ③ · Yuna's phone/web line «{folder} 폴더를 쓸지»): the folder the window asks about, a closed list
  (documents · desktop · downloads · network_volume · icloud) the daemon read from tccd's service name — carried with
  `waiting_system` only (the service refuses it on any other word); null when the window was seen by its owner alone. Never a path.
The CHECK is dropped and made again with the nine words (the code side is app/models/desktop_relay.SESSION_STATES — a test holds
them together). No row changes: every stored value is one of the eight, all still allowed.
"""
import sqlalchemy as sa

from alembic import op

revision = "0442"
down_revision = "0441"
branch_labels = None
depends_on = None

_OLD = ("starting", "working", "idle", "waiting_permission", "waiting_input", "error", "paused_limit", "stopped")
_NEW = ("starting", "working", "idle", "waiting_permission", "waiting_input", "error", "paused_limit", "waiting_system", "stopped")
_FOLDERS = ("documents", "desktop", "downloads", "network_volume", "icloud")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.drop_constraint("ck_desktop_sessions_state", "desktop_sessions", type_="check")
    op.create_check_constraint("ck_desktop_sessions_state", "desktop_sessions", _in("state", _NEW))
    op.add_column("desktop_sessions", sa.Column("system_folder", sa.Text(), nullable=True))
    op.create_check_constraint("ck_desktop_sessions_system_folder", "desktop_sessions", f"system_folder IS NULL OR {_in('system_folder', _FOLDERS)}")


def downgrade() -> None:
    op.drop_constraint("ck_desktop_sessions_system_folder", "desktop_sessions", type_="check")
    op.drop_column("desktop_sessions", "system_folder")
    # a row in the new word cannot stay under the old CHECK: it reads as working again (what the daemon sent before)
    op.execute("UPDATE desktop_sessions SET state = 'working' WHERE state = 'waiting_system'")
    op.drop_constraint("ck_desktop_sessions_state", "desktop_sessions", type_="check")
    op.create_check_constraint("ck_desktop_sessions_state", "desktop_sessions", _in("state", _OLD))
