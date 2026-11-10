"""[SID:4888] the system workflow trigger «kickoff» says «goal», not «epic», in its description (`workflow_trigger_types.description`).

«Goal» and «epic» are the same thing (the server serves one router under /api/v2/goals and /api/v2/epics — the hierarchy rename, story 1925), and the person sees one name: «목표».
The seed text of the system trigger types (`SYSTEM_TRIGGER_TYPES` in `app/repositories/workflow_trigger_type.py`) still said «스프린트 또는 에픽 킥오프»; the seed inserts with
`ON CONFLICT DO NOTHING`, so every organization that already has its rows keeps the old text. This revision corrects exactly those rows and nothing else:

- only a **system** row (`is_system`) whose description is **exactly** the old seed text is changed — a description a person edited is never touched, and a custom (non-system) row
  that happens to carry the same words is left as it is;
- no other column, no `slug` (the stored key stays `kickoff`), no row count change.

A data-only change of one text column: no lock beyond the row locks of the rows it updates, nothing the old release (which reads the description as a label) could not live with.
Every statement is written in `upgrade()` itself so the promotion's migration reading lists it.

Downgrade puts the old text back on the system rows that carry exactly the new text.
"""
from alembic import op

revision = "0473"
down_revision = "0472"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE workflow_trigger_types SET description = '스프린트 또는 목표 킥오프' WHERE is_system = true AND description = '스프린트 또는 에픽 킥오프'")


def downgrade() -> None:
    op.execute("UPDATE workflow_trigger_types SET description = '스프린트 또는 에픽 킥오프' WHERE is_system = true AND description = '스프린트 또는 목표 킥오프'")
