import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import OrgScopedMixin, SoftDeleteMixin, TimestampMixin


class Project(Base, OrgScopedMixin, TimestampMixin, SoftDeleteMixin):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("org_id", "slug", name="uq_projects_org_slug"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # story 139d2405(S-slug-infra): workspace 내 유일(org-scoped) — 전역 유일인 organizations.slug와
    # 다른 스코프(project는 root bare 경로가 아니라 `/{ws}/{proj}/...` 하위라 워크스페이스 내에서만
    # 유일하면 됨). additive(0184 백필=이름 kebab 파생 — 기존 실 데이터는 채워짐). ⚠️nullable 유지
    # (NOT NULL 아님): 이 리포 전역에 raw `Project(...)` 생성자를 직접 쓰는 실DB 테스트 시더가
    # 수백 곳이라(slug 인지 0) NOT NULL로 걸면 그 전부가 즉시 깨진다(실측 확認 — 666건 NotNull
    # violation). 신규 API 경로(app/routers/projects.py)는 항상 실값을 채워 넣어 실질적으로
    # non-null이고, 유니크 제약(org_id, slug)은 NULL 여러 개를 서로 다른 값으로 취급해 무해하다.
    slug: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # S3-2: warn(default) | block
    violation_level: Mapped[str] = mapped_column(String(10), nullable=False, default="warn")

    # relationships (string refs to avoid circular imports)
    team_members: Mapped[list["TeamMember"]] = relationship("TeamMember", back_populates="project", lazy="select")
    sprints: Mapped[list["Sprint"]] = relationship("Sprint", back_populates="project", lazy="select")
    epics: Mapped[list["Goal"]] = relationship("Goal", back_populates="project", lazy="select")


class OrgMember(Base):
    __tablename__ = "org_members"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_org_members_org_user"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="member")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
