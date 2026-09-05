"""story #3497(Phase2·마케팅운영, 페드루 決定 2026-09-05, migration 0332) — 채널 인사이트
수집 잡 원장. 블루프린트 v3 §2(d)·§3 「발행 후 1일·7일 스냅샷이 동일 게시물 evidence에
누적된다」·「토큰·한도 실패는 연결 상태로 승격한다」의 실행 단위.

`channel_publications`/`site_posts` 어느 쪽으로 발행됐는지 이 테이블은 모른다(FK 없음 —
`channel_connections`·`channel_post_drafts`와 동일 관례, 그라운딩 §9) — `publication_id`
는 그 발행을 가리키는 값(hosted_site는 site_post.id, 외부 목적지는 channel_publication.id)
일 뿐이고, 이 테이블 자체는 "언제 다시 봐야 하는지·무엇을 봤는지"만 안다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class InsightSnapshot(Base):
    __tablename__ = "insight_snapshots"
    __table_args__ = (
        # 페드루 決定 — 발행 성공 시 +1d·+7d 두 행 등록, 같은 발행 재처리에도 멱등
        # (같은 publication_id·같은 due_at 재등록 시도는 새 행이 아니라 기존 행).
        UniqueConstraint("publication_id", "due_at", name="uq_insight_snapshots_publication_due_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # FK 없음 — channel_connections·channel_post_drafts와 동일 관례(그라운딩 §9).
    # hosted_site=site_posts.id · 외부 목적지(wordpress/webhook/threads 등)=
    # channel_publications.id.
    publication_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # "hosted_site"|"sandbox"|"wordpress"|"webhook"|"threads"|... — CHANNEL_ADAPTERS
    # 키와 동일 문자열(어댑터 선택 축).
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    # 외부 매체 식별자(Threads media_id 등). hosted_site는 조회 축이 slug+lang이라 NULL.
    external_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 'pending'|'captured'|'unsupported'|'failed'|'dead_letter' — publication_commands.status
    # 관례와 동형(그라운딩 §9), 새 상태값 체계 발명 안 함.
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # 어댑터 원본 응답 그대로(디버그·재정규화 근거) — 정규화 로직이 나중에 바뀌어도
    # 원본이 있으면 재계산 가능.
    raw_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # {impressions, reach, views, engagements, clicks, spend, conversions} — 각 int|null.
    # null=그 채널 어댑터가 그 지표를 선언 안 함("미제공"), 0=선언했고 실제로 0(예: 발행
    # 직후 아직 조회 없음). 이 구분이 이 스토리의 척추(페드루 決定) — 절대 섞지 않는다.
    normalized: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    source: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
