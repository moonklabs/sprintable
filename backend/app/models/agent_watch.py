"""story #4536 (E-DESKTOP-2 C-2 · alembic 0430) — watches an agent sets that live on the server, past its session; the PRs
the GitHub webhooks have told about; the commit each backend revision says it serves.

The lists below are the code side of the CHECK constraints in 0430."""
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

WATCH_CONDITIONS = ("github.pr_merged", "github.pr_checks_completed", "deploy.serving")
WATCH_STATUSES = ("active", "fired", "cancelled")  # «expired» is read from expires_at, never stored
SERVING_SERVICES = ("backend",)  # PO 06:01Z — the web has no path to report its own serving without a new public one


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


class AgentWatch(Base):
    __tablename__ = "agent_watches"
    __table_args__ = (
        CheckConstraint(_in("condition", WATCH_CONDITIONS), name="ck_agent_watches_condition"),
        CheckConstraint(_in("status", WATCH_STATUSES), name="ck_agent_watches_status"),
        Index("ix_agent_watches_agent_status", "agent_member_id", "status"),
        Index("ix_agent_watches_condition_active", "condition", postgresql_where=text("status = 'active'")),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    agent_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    condition: Mapped[str] = mapped_column(Text, nullable=False)
    target: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    fired_fact: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class GithubPullRequest(Base):
    """What the webhooks told an org about a PR — upserted by every pull_request webhook and by a check_suite's PR numbers,
    under the org the webhook resolved to (PO 06:51Z: an org reads only its own repos' PRs)."""

    __tablename__ = "github_pull_requests"
    __table_args__ = (
        UniqueConstraint("org_id", "repo", "number", name="uq_github_pull_requests_org_repo_number"),
        CheckConstraint("state IN ('open', 'closed')", name="ck_github_pull_requests_state"),
        Index("ix_github_pull_requests_org_merge_commit", "org_id", "merge_commit_sha"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    repo: Mapped[str] = mapped_column(Text, nullable=False)  # «owner/name», lowercase
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    base_ref: Mapped[str | None] = mapped_column(Text, nullable=True)
    state: Mapped[str] = mapped_column(Text, nullable=False)
    merged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    merge_commit_sha: Mapped[str | None] = mapped_column(Text, nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class DeployServing(Base):
    """A backend revision's own report of the commit it serves, made on its first outside request."""

    __tablename__ = "deploy_servings"
    __table_args__ = (
        UniqueConstraint("service", "revision", name="uq_deploy_servings_service_revision"),
        CheckConstraint("service IN ('backend')", name="ck_deploy_servings_service"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    service: Mapped[str] = mapped_column(Text, nullable=False)
    revision: Mapped[str] = mapped_column(Text, nullable=False)
    commit_sha: Mapped[str] = mapped_column(Text, nullable=False)
    first_request_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
