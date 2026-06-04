import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ApiKey(Base):
    __tablename__ = "agent_api_keys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # E-MEMBER-SSOT AC3-5 ③: team_member_id DEPRECATED — canonical 식별자는 member_id(members.id 미러).
    # dual 유지(레거시 호환). ⚠️ FK는 0088 rename로 team_members_legacy를 가리킴(team_members는 뷰);
    # 모델 선언("team_members.id")은 stale-drift(런타임 무관, DB 제약이 권위).
    team_member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # E-MEMBER-SSOT AC3-1: canonical members.id 미러 (team_member_id와 1:1 dual-write, 0075 ID 보존).
    # AC3-1b(0080): anchor write-sync로 신규 agent members 선행 보장 → FK 재추가(QA H1 해소).
    # ondelete SET NULL(미러 — 실삭제는 team_member_id CASCADE가 처리). nullable.
    member_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("members.id", ondelete="SET NULL"), nullable=True, index=True
    )
    key_prefix: Mapped[str] = mapped_column(Text, nullable=False)
    key_hash: Mapped[str] = mapped_column(Text, nullable=False)
    scope: Mapped[list | None] = mapped_column(ARRAY(Text), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
