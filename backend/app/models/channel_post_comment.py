"""story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 댓글 원장. 발행된
`channel_publications` 행의 댓글을 수집 잡이 채운다. FK 없음(channel_connections·
channel_post_drafts와 동일 관례, 그라운딩 §9) — `publication_id`는 channel_
publications.id를 가리키는 값일 뿐이다(hosted_site 댓글은 이 스토리 범위 밖)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChannelPostComment(Base):
    __tablename__ = "channel_post_comments"
    __table_args__ = (
        UniqueConstraint("publication_id", "external_comment_id", name="uq_channel_post_comments_publication_external"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    publication_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    external_comment_id: Mapped[str] = mapped_column(Text, nullable=False)
    author_display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    text_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    external_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    raw: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # story #3516 — 재수집 시 원격에 더는 없는 댓글의 소프트 삭제 표시(하드 삭제 안 함,
    # 이미 답변이 달렸을 수 있어 이력 보존). null=지금 살아있음.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ChannelPostCommentReply(Base):
    """story #3516 조각② 선제 스키마(조각①은 write 0 — 답변 흐름은 조각②에서 배선).
    봉인 축(답변 sha·대상 external id·대상 text_sha256)은 Gate.neutral_facts에 싣는다
    (site_posts.py::draft_id 관례와 동형 — 이 테이블에 새 컬럼을 안 늘린다)."""
    __tablename__ = "channel_post_comment_replies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    comment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # story #3516 조각②(마이그 0339, 페드루 착수 직후 디디 자가발견) — 0338이
    # gate_id를 NOT NULL로 냈었는데, 답변 흐름은 draft(에이전트도 작성 가능)→submit
    # (사람, 이 시점에 gate 생성) 2단계라 draft 행 시점엔 gate 자체가 없다. status=
    # "draft"인 동안은 null, submit이 채운다.
    gate_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    command_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # 'draft'|'pending'|'approved'|'sent'|'failed' — 조각②가 정의(조각①은 미사용).
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    external_reply_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_reply_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_by_kind: Mapped[str] = mapped_column(Text, nullable=False)  # 'human'|'agent'
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class CommentCollectionSchedule(Base):
    """story #3516 — insight_snapshot(story #3497)의 due_at 스케줄링 뼈대를 미러(같은
    테이블 공유 안 함 — 댓글 수집은 정규화값을 안 담고 시도 성공/실패만 남긴다). 3회
    (+1h·+1d·+7d)를 발행 성공 시 등록. 수동 재수집(`POST .../comments/refresh`)도
    같은 테이블에 due_at=now()로 즉시 처리 행을 넣는다 — 별도 rate-limit 상태 테이블을
    새로 만들지 않고, "이 publication의 가장 최근 captured_at"으로 5분 제한을 판정한다."""
    __tablename__ = "channel_post_comment_collection_schedule"
    __table_args__ = (
        UniqueConstraint("publication_id", "due_at", name="uq_comment_collection_schedule_publication_due_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    publication_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    external_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 'pending'|'in_progress'|'captured'|'unsupported'|'failed' — insight_snapshot.status와 동형.
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
