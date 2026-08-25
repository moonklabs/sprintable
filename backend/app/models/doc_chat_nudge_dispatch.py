"""story #2747 QA delta(카디르·페드루, 2026-08-25) — draft doc 채팅공유 넛지의 정직한
1회성 anchor. 최초 구현은 (발신자,작성자) DM의 메시지 로그를 SSOT로 삼았는데, 이건 키
축이 틀렸다(작성자당 전역 1회가 AC인데 DM당 1회로 좁게 잡았다 — 서로 다른 발신자가 각자
DM에서 mention하면 각각 새 넛지가 나갔다) + SELECT→INSERT가 SAVEPOINT일 뿐 동시성 보장이
아니었다(asyncio.gather 동시 호출 시 둘 다 SELECT를 통과할 수 있음). uq(org_id, doc_id)
UNIQUE 제약으로 "이 doc에 넛지를 발송하겠다"는 사실 자체를 원자적 reservation row로
INSERT — 실패(IntegrityError=이미 있음)하면 그 자리서 조용히 skip한다(DB가 직렬화를
보장 — app 레벨 락/SAVEPOINT 불요, 텍스트비교 아닌 실 제약).
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DocChatNudgeDispatch(Base):
    __tablename__ = "doc_chat_nudge_dispatches"
    __table_args__ = (
        UniqueConstraint("org_id", "doc_id", name="uq_doc_chat_nudge_dispatch_org_doc"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    doc_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("docs.id", ondelete="CASCADE"), nullable=False
    )
    author_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    message_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
