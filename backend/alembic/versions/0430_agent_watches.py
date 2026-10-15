"""story #4536 (E-DESKTOP-2 C-2) — watches an agent sets that live on the server, past its session.

- agent_watches: an agent's watch (condition CHECK · target JSONB · status CHECK · expiry) — fired once, delivered to that
  agent's stream as a `watch.fired` Event.
- github_pull_requests: what the GitHub webhooks have told an org about a PR (open/closed · merged · merge commit · base) —
  the server's own record (no GitHub API polling), kept per org (the org the webhook resolved to — PO 06:51Z: an org sees
  only its own repos' PRs); a watch on a PR its org has never seen is refused at set time.
- deploy_servings: a backend revision's own report of the commit it serves, made on its first outside request (no new public
  path · no secret · a 0%-traffic revision gets none) — UNIQUE per revision.
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0430"
down_revision = "0429"
branch_labels = None
depends_on = None

_CONDITIONS = ("github.pr_merged", "github.pr_checks_completed", "deploy.serving")
_STATUSES = ("active", "fired", "cancelled")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def upgrade() -> None:
    op.create_table(
        "agent_watches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("condition", sa.Text(), nullable=False),
        sa.Column("target", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("fired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fired_fact", postgresql.JSONB(), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(_in("condition", _CONDITIONS), name="ck_agent_watches_condition"),
        sa.CheckConstraint(_in("status", _STATUSES), name="ck_agent_watches_status"),
    )
    op.create_index("ix_agent_watches_agent_status", "agent_watches", ["agent_member_id", "status"])
    op.create_index("ix_agent_watches_condition_active", "agent_watches", ["condition"], postgresql_where=sa.text("status = 'active'"))
    op.create_table(
        "github_pull_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("repo", sa.Text(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("base_ref", sa.Text(), nullable=True),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("merge_commit_sha", sa.Text(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("org_id", "repo", "number", name="uq_github_pull_requests_org_repo_number"),
        sa.CheckConstraint("state IN ('open', 'closed')", name="ck_github_pull_requests_state"),
    )
    op.create_index("ix_github_pull_requests_org_merge_commit", "github_pull_requests", ["org_id", "merge_commit_sha"])
    op.create_table(
        "deploy_servings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("revision", sa.Text(), nullable=False),
        sa.Column("commit_sha", sa.Text(), nullable=False),
        sa.Column("first_request_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("service", "revision", name="uq_deploy_servings_service_revision"),
        sa.CheckConstraint("service IN ('backend')", name="ck_deploy_servings_service"),
    )


def downgrade() -> None:
    op.drop_table("deploy_servings")
    op.drop_index("ix_github_pull_requests_org_merge_commit", table_name="github_pull_requests")
    op.drop_table("github_pull_requests")
    op.drop_index("ix_agent_watches_condition_active", table_name="agent_watches")
    op.drop_index("ix_agent_watches_agent_status", table_name="agent_watches")
    op.drop_table("agent_watches")
