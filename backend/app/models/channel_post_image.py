"""story 620beefc(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 채널 포스트 이미지
원본+파생본 원장. Phase1은 `ChannelPostVersion`과 1:1(version_id UNIQUE,
`image_max_count=1`)이었다 — 한 버전이 봉인하는 이미지는 최대 하나.

story #3550(Phase2, 페드루 PO 確定 2026-09-06, 마이그 0343) — Instagram 캐러셀
(2~10장) 지원으로 1:1 제약을 1:N(`UniqueConstraint(version_id, position)`)으로
완화. `position`(0-indexed)이 순서를 명시 — 봉인 해시(`ChannelPostVersion.
image_sha256`)는 이 순서대로 이어붙인 합성값(N=1은 항등, `channel_post_images.py
::compute_image_seal_hash`)이라 순서 재배열도 이미지 바꿔치기와 동형으로 봉인을
깬다(디디 설계 메모·PO 確定 안 A).

원본은 항상 보존한다(계보, PO 決定 ③ "원본 보존 + 파생본 별도 행"). 파생본이 필요
없었으면(원본이 이미 어댑터 규격 안) `derived_*`는 전부 None — "나가는(발행에 실제로
쓰이는) 파생본"은 그때 원본 자신이다. `final_*` 프로퍼티가 그 폴백을 코드 한 곳에서만
결정한다(다른 곳이 `derived_* or original_*`을 각자 다시 안 짜도록)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChannelPostImage(Base):
    __tablename__ = "channel_post_images"
    __table_args__ = (
        UniqueConstraint("version_id", "position", name="uq_channel_post_images_version_position"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    draft_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # story #3550(마이그 0343) — 0-indexed. 봉인 해시가 이 순서를 그대로 잠근다(§ 모듈
    # docstring) — 재배열=바꿔치기와 동형으로 판정돼야 하므로 이 값을 신뢰의 SSOT로 쓴다.
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    original_object_path: Mapped[str] = mapped_column(Text, nullable=False)
    original_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    original_content_type: Mapped[str] = mapped_column(Text, nullable=False)
    original_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    original_width: Mapped[int] = mapped_column(Integer, nullable=False)
    original_height: Mapped[int] = mapped_column(Integer, nullable=False)

    derived_object_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    derived_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    derived_content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    derived_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    derived_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    derived_height: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    @property
    def final_object_path(self) -> str:
        return self.derived_object_path or self.original_object_path

    @property
    def final_sha256(self) -> str:
        return self.derived_sha256 or self.original_sha256

    @property
    def final_content_type(self) -> str:
        return self.derived_content_type or self.original_content_type

    @property
    def final_bytes(self) -> int:
        return self.derived_bytes if self.derived_bytes is not None else self.original_bytes

    @property
    def final_width(self) -> int:
        return self.derived_width if self.derived_width is not None else self.original_width

    @property
    def final_height(self) -> int:
        return self.derived_height if self.derived_height is not None else self.original_height

    @property
    def was_converted(self) -> bool:
        """§17-14 배지("자동 변환됨") 판정 — 파생본이 실제로 만들어졌는지."""
        return self.derived_object_path is not None
