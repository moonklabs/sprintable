"""[SID:4846] deleting a project keeps the chat event rows of its rooms (`events.project_id` FK `ON DELETE CASCADE` → `SET NULL`).

A room outlives its project (0471: `conversations.project_id` is `SET NULL`), and the chat events of that room (the delivery rows of its messages and mentions) belong to
the room, so they must outlive the project too — with `CASCADE` a project's deletion deleted the delivery history of rooms that stay. The column has been nullable since 0471.

`events` is a large table, so the new constraint is added `NOT VALID`: no scan of the table, so the lock of the swap is momentary. `NOT VALID` only skips checking the rows that
exist when the constraint is added — every row already satisfied the old (validated) constraint, and the rule itself (`ON DELETE SET NULL`) and the check of every new row
are in force at once. (`autocommit_block()` is not available to a revision of this project — see `alembic/env.py` — so the validation is not done here; it is a read-only scan
that an operator may run online at any quiet time: `ALTER TABLE events VALIDATE CONSTRAINT events_project_id_fkey` takes `SHARE UPDATE EXCLUSIVE`, readers and writers go on.)

Every statement is written in `upgrade()` itself so the promotion's migration reading (CUTOVER-prod G1a, which reads only `upgrade()` and shows one line per statement) lists it. Safe with the old revision
serving: the old code never reads the rule, and a delete of a project by the old code finds the rows kept instead of deleted.

Downgrade puts `CASCADE` back (rows whose project is already NULL stay as they are — a NULL references nothing).
"""
from alembic import op

revision = "0472"
down_revision = "0471"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE events DROP CONSTRAINT IF EXISTS events_project_id_fkey")
    op.execute("ALTER TABLE events ADD CONSTRAINT events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL NOT VALID")


def downgrade() -> None:
    op.execute("ALTER TABLE events DROP CONSTRAINT IF EXISTS events_project_id_fkey")
    op.execute("ALTER TABLE events ADD CONSTRAINT events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE NOT VALID")
