"""story 5008 (A1): the runtime names the three desktop relay tables allow — `claude · codex` → `claude · codex · opencode · gemini · cursor`

WIDENS three CHECK constraints and nothing else (`desktop_sessions.runtime` · `agent_permission_requests.runtime` · `desktop_usage.runtime`): every row that exists
still passes, so a running old revision (which only ever writes `claude` · `codex`) is not affected, and nothing is added or removed in the data. The new names
only open the door: which runtime an app is OFFERED is the registry's `enabled` mark (`agent_runtime.DESKTOP_RUNTIME_REGISTRY`), so adding an agent later needs no migration.

Downgrade puts the old constraint back and STOPS (raises, changes nothing) if any row of the three tables already names a runtime the old constraint does not know — it never
deletes a person's rows to make a downgrade pass.

Revision ID: 0497
Revises: 0496
"""
from alembic import op

revision = "0497"
down_revision = "0496"
branch_labels = None
depends_on = None

_OLD = ("claude", "codex")
_NEW = ("claude", "codex", "opencode", "gemini", "cursor")
_CHECKS = (
    ("desktop_sessions", "ck_desktop_sessions_runtime"),
    ("agent_permission_requests", "ck_agent_permission_requests_runtime"),
    ("desktop_usage", "ck_desktop_usage_runtime"),
)


def _in(values: tuple[str, ...]) -> str:
    return f"runtime IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    for table, name in _CHECKS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, _in(_NEW))


def downgrade() -> None:
    bind = op.get_bind()
    for table, _name in _CHECKS:
        used = bind.exec_driver_sql(f"SELECT count(*) FROM {table} WHERE runtime NOT IN ({', '.join(repr(v) for v in _OLD)})").scalar()
        if used:
            raise RuntimeError(
                f"0497 downgrade stopped: {used} row(s) of {table} name a runtime ({', '.join(_NEW[len(_OLD):])}) the older constraint does not allow — "
                "nothing was changed. Remove or move those rows on purpose, then downgrade again."
            )
    for table, name in _CHECKS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, _in(_OLD))
