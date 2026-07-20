"""story #1993(E-KNOWLEDGE-LINK S1) — mentions 정규화 테이블. 근본 설계 doc
design-org-knowledge-mentions-backlinks §1.

source(chat_message|doc)가 target(doc·CHECK엔 story/epic 여지도 열어두되 이번 write-path
파서는 target_type='doc'만 실제로 채운다 — gate 멘션은 스코프 밖)을 멘션한 사실을 기록하는
순수 링크 테이블. 폴리모픽 source_id/target_id는(entity_slug_history 와 동형) 단일 FK가
불가해 plain UUID(+index)로 둔다 — 참조 무결성은 애플리케이션 write-path(파서)가 보장.

기존 `mentioned_ids`(ConversationMessage 컬럼·멤버 멘션 알림용) 파이프라인과는 완전히 별개
(비접촉) 병행 경로 — 이 테이블은 org 지식 그래프(백링크) 조회용, `mentioned_ids`는 알림 발신용."""
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin

# 이번 write-path 파서가 실제로 채우는 값은 SOURCE_TYPES 전체 · target_type='doc' 뿐이다.
# story/epic 은 CHECK 여지만(스키마 레벨 확장 대비) — 파서 미구현(과확장 금지, story #1993 스코프).
SOURCE_TYPES = frozenset({"chat_message", "doc"})
TARGET_TYPES = frozenset({"doc", "story", "epic"})


class Mention(Base, OrgScopedMixin):
    __tablename__ = "mentions"
    __table_args__ = (
        UniqueConstraint(
            "source_type", "source_id", "target_type", "target_id",
            name="uq_mentions_source_target",
        ),
        CheckConstraint("source_type IN ('chat_message', 'doc')", name="ck_mentions_source_type"),
        CheckConstraint("target_type IN ('doc', 'story', 'epic')", name="ck_mentions_target_type"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # PO 방향②: canonicalize_member_id 를 거친 canonical members.id(alias 정규화 후).
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
