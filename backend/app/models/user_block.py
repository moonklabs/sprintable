import uuid
from datetime import datetime

from sqlalchemy import DateTime, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class UserBlock(Base):
    """story #2349 AC3 — 1:1 상호작용(DM·멘션) 사용자 차단. team_members.id로 키를 잡는다
    (members.id는 아직 미배선 SSOT — 대화/메시지가 전부 team_members.id를 쓰는 것과 통일).

    ⚠️`team_members`는 실제로는 VIEW(members ⋈ project_access)라 FK 제약을 못 건다(포스트그레스
    하드 제약 — VIEW 참조 FK는 CREATE TABLE 자체가 실패한다, 2026-08-02 프레시 DB 마이그로
    실측). `ConversationParticipant.member_id`와 동일 패턴 — 실 DB엔 FK 없음(컬럼+인덱스만),
    참조 무결성은 애플리케이션 레벨(엔드포인트의 org 소속 확認)에서만 보장한다.
    """

    __tablename__ = "user_blocks"
    __table_args__ = (
        UniqueConstraint("blocker_member_id", "blocked_member_id", name="uq_user_block_pair"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    blocker_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    blocked_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
