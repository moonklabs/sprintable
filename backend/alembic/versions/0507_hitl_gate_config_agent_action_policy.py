"""[SID:5041 ②] the user's «always allow · block» settings for an agent's actions — `hitl_gate_config` learns an agent and an action key.

The table (0123) keeps (work_type × actor_type) → level (auto · ask · block), an organisation default and a project override. It is widened, not replaced (PO 11-27, seq 20579):
  · `agent_id` (null = every agent) — the settings can be made for ONE agent in ONE project;
  · `work_type` may now also be `action:<key>` (the key of an action of `services/agent_action.py`, e.g. `action:story.delete`) next to `done` / `merge`.
The old rows are untouched (agent_id is NULL for all of them) and keep their meaning.

Indexes: the two unique indexes (org default · project override) now say `agent_id IS NULL`, and two new ones carry the agent-specific rows — one row per (org · [project] · work_type · actor_type · agent).
`set_gate_level`'s upsert names the old predicate in its ON CONFLICT, so it is changed with this revision (services/gate_config.py).

Table is small (one row per setting): the indexes are replaced in a transaction, no CONCURRENTLY.

Revision ID: 0507
Revises: 0506
Create Date: 2026-11-27
"""
from alembic import op

revision = "0507"
down_revision = "0506"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE hitl_gate_config ADD COLUMN IF NOT EXISTS agent_id uuid NULL")
    op.execute("ALTER TABLE hitl_gate_config DROP CONSTRAINT IF EXISTS ck_hitl_gate_work_type")
    op.execute(
        "ALTER TABLE hitl_gate_config ADD CONSTRAINT ck_hitl_gate_work_type "
        "CHECK (work_type IN ('done', 'merge') OR work_type LIKE 'action:%') NOT VALID"
    )
    op.execute("ALTER TABLE hitl_gate_config VALIDATE CONSTRAINT ck_hitl_gate_work_type")
    op.execute("DROP INDEX IF EXISTS uq_hitl_gate_org_default")
    op.execute("DROP INDEX IF EXISTS uq_hitl_gate_project_override")
    op.execute(
        "CREATE UNIQUE INDEX uq_hitl_gate_org_default "
        "ON hitl_gate_config (org_id, work_type, actor_type) WHERE project_id IS NULL AND agent_id IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_hitl_gate_project_override "
        "ON hitl_gate_config (org_id, project_id, work_type, actor_type) WHERE project_id IS NOT NULL AND agent_id IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_hitl_gate_org_agent "
        "ON hitl_gate_config (org_id, agent_id, work_type, actor_type) WHERE project_id IS NULL AND agent_id IS NOT NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_hitl_gate_project_agent "
        "ON hitl_gate_config (org_id, project_id, agent_id, work_type, actor_type) WHERE project_id IS NOT NULL AND agent_id IS NOT NULL"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_hitl_gate_config_agent_id ON hitl_gate_config (agent_id) WHERE agent_id IS NOT NULL")


def downgrade() -> None:
    # the agent-specific and action rows would break the old shape: they go with the downgrade
    op.execute("DELETE FROM hitl_gate_config WHERE agent_id IS NOT NULL OR work_type LIKE 'action:%'")
    op.execute("DROP INDEX IF EXISTS ix_hitl_gate_config_agent_id")
    op.execute("DROP INDEX IF EXISTS uq_hitl_gate_project_agent")
    op.execute("DROP INDEX IF EXISTS uq_hitl_gate_org_agent")
    op.execute("DROP INDEX IF EXISTS uq_hitl_gate_project_override")
    op.execute("DROP INDEX IF EXISTS uq_hitl_gate_org_default")
    op.execute("ALTER TABLE hitl_gate_config DROP CONSTRAINT IF EXISTS ck_hitl_gate_work_type")
    op.execute("ALTER TABLE hitl_gate_config ADD CONSTRAINT ck_hitl_gate_work_type CHECK (work_type IN ('done', 'merge'))")
    op.execute("ALTER TABLE hitl_gate_config DROP COLUMN IF EXISTS agent_id")
    op.execute(
        "CREATE UNIQUE INDEX uq_hitl_gate_org_default ON hitl_gate_config (org_id, work_type, actor_type) WHERE project_id IS NULL"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_hitl_gate_project_override "
        "ON hitl_gate_config (org_id, project_id, work_type, actor_type) WHERE project_id IS NOT NULL"
    )
