"""story #3554(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Instagram 릴스(영상)
마스터 원장. `ChannelPostImage`(620beefc)와 달리 서버 측 변환(재인코딩)을 하지
않는다(ffmpeg류 의존 0 — PO 明示, Cloud Run 이미지 반경 확대를 피함) — 순수
파이썬 MP4 박스 파서(`channel_post_videos.py::parse_mp4_metadata`)로 규격(길이·
해상도·코덱 fourcc)만 읽어 어댑터 선언과 대조하고, 통과하면 원본을 그대로
"나가는" 파생본으로 쓴다(그래서 derived_* 컬럼이 없다 — 이미지 파이프와의
유일한 구조 차이).

버전당 영상은 최대 1개(`UniqueConstraint(version_id)`, 캐러셀처럼 N개로 열
필요가 없다 — 릴스는 항상 본편 1편+커버 1장 조합). 커버는 이 테이블이 아니라
기존 `ChannelPostImage`(position=0)를 그대로 재사용한다(PO 明示 "커버=별개
이미지 에셋·기존 이미지 파이프") — 새 테이블·새 업로드 경로를 커버용으로
따로 만들지 않는다."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChannelPostVideo(Base):
    __tablename__ = "channel_post_videos"
    __table_args__ = (
        UniqueConstraint("version_id", name="uq_channel_post_videos_version"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    draft_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    original_object_path: Mapped[str] = mapped_column(Text, nullable=False)
    original_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    original_content_type: Mapped[str] = mapped_column(Text, nullable=False)
    original_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # MP4 박스 파서(mvhd/tkhd/stsd)로 읽은 값 — 어댑터 규격(video_max_seconds·
    # video_aspect_target·video_codecs) 대조에 쓴다. 파싱 실패 자체는 저장 前
    # 422로 거부되므로(fail-closed) 이 세 컬럼은 항상 채워진 채로만 커밋된다.
    duration_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    codec: Mapped[str] = mapped_column(Text, nullable=False)

    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
