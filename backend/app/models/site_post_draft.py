"""story #3365(Phase0 S1, 선생님 확定 2026-09-03) — 초안 원장. 고객 에이전트가 넣는 초안과
휴먼이 고친 개정판을 같은 work item·slug 아래 불변 버전으로 쌓는다. `SitePost`(공개 projection,
site_post.py)와 분리 — 승인·발행 전에는 이 테이블에만 존재하고 공개 행은 절대 안 생긴다.

버전 원문·주체는 SitePostVersion(아래)이 SSOT — 이 draft 행 자체엔 원작성 주체를 중복 저장하지
않는다(version_number=1이 원작성 버전).

`campaign_id`(story #3437, 페드루 PO 確定 2026-09-04) — 이 content_item이 속하는
Campaign(campaign.py). FK 없음(이 도메인 전체 관례). nullable — campaign 없는 단독 글도
허용(AC3 명시).

`connection_id`(story e4fc29fa, 페드루 PO 確定 2026-09-04, 조각③a) — 이 content_item이
나가는 목적지(`channel_connections` 행). FK 없음(이 도메인 전체 관례). nullable —
null=hosted_site(Sprintable 호스팅, 기존 기본 동작·기존 draft 전부 무변경). 승인 뒤
바뀌면 재승인 대상(gate.sealed_destination_connection_id와 비교, site_posts.py::
_reseal_gate_on_new_version 참고)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SitePostDraft(Base):
    __tablename__ = "site_post_drafts"
    __table_args__ = (
        UniqueConstraint("org_id", "work_item_id", "slug", name="uq_site_post_drafts_org_work_item_slug"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    campaign_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    connection_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
