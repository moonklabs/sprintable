"""story #f8f7cb0f(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 채널 발행 결과·멱등
원장. 같은 (gate_id, version_id)는 UNIQUE — 재요청이 Threads에 새 POST를 내지 않고
기존 행을 반환한다(멱등, story AC 명시). `gate_id` 단독이 아니라 `version_id`까지 축에
넣는 이유: 재상신(#3374 규율)이 같은 gate를 새 버전으로 재봉인할 수 있어, gate_id
단독이면 "재승인된 새 버전"의 발행이 "이미 발행된 옛 버전"과 충돌한다.

`status` 3종: `container_created`(컨테이너만 생성됨, publish 실패로 부분 성공) ·
`published`(완료) · `failed`(컨테이너 생성 자체가 실패 — PO 결정②: 이 경우도 새 행을
만들지 않고 같은 (gate_id, version_id) 행을 그 자리에서 갱신해 재시도한다)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChannelPublication(Base):
    __tablename__ = "channel_publications"
    __table_args__ = (
        UniqueConstraint("gate_id", "version_id", name="uq_channel_publications_gate_version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    gate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # FK 없음 — channel_connections·channel_post_drafts와 동일 관례(그라운딩 §9).
    connection_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    external_container_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    permalink: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="container_created")
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
