import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ProjectAccess(Base):
    """프로젝트별 접근 제어 (grant 모델: 레코드 있음 = 접근 허용, 레코드 없음 = no access).

    S-MBR-10: opt-out → grant 전환. org Owner/Admin은 레코드 없이도 항상 접근 가능.
    """
    __tablename__ = "project_access"
    __table_args__ = (
        UniqueConstraint("project_id", "org_member_id", name="uq_project_access_project_member"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # nullable=True: migration 0075 dropped the NOT NULL constraint to admit agent
    # direct placement (agents have no org_member). The model lagged behind that DDL,
    # so create_all reproduced the old NOT NULL — the root of the prod onboarding 500.
    org_member_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("org_members.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    permission: Mapped[str] = mapped_column(Text, nullable=False, default="granted", server_default="granted")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # E-MEMBER-SSOT AC2-1: 앵커 placement 컬럼 (additive — 코드 cutover 없음, 백필로 채움).
    # member_id → members.id FK는 마이그 0075에서 NOT VALID로 추가(기존 행 검증 보류).
    member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    role: Mapped[str] = mapped_column(Text, nullable=False, default="member", server_default="member")
    color: Mapped[str] = mapped_column(Text, nullable=False, default="#3385f8", server_default="#3385f8")
    can_manage_members: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    access_source: Mapped[str] = mapped_column(Text, nullable=False, default="direct", server_default="direct")
    inherited_from_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
