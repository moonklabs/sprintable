"""story #f8f7cb0f(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 채널 발행 결과·멱등
원장. 같은 (gate_id, version_id, sequence)는 UNIQUE — 재요청이 Threads에 새 POST를
내지 않고 기존 행을 반환한다(멱등, story AC 명시). `gate_id` 단독이 아니라 `version_id`
까지 축에 넣는 이유: 재상신(#3374 규율)이 같은 gate를 새 버전으로 재봉인할 수 있어,
gate_id 단독이면 "재승인된 새 버전"의 발행이 "이미 발행된 옛 버전"과 충돌한다.

story #3808(Phase3·3-3 PR2, 페드루 PO 確定 2026-09-11) — `sequence` 열 추가(원래
UNIQUE는 (gate_id, version_id)뿐 — X 스레드(연속 게시) N건이 같은 gate+version
아래 여러 발행물을 가질 수 있어 이 축을 얹었다). threads/instagram/facebook 등은
이 열을 절대 안 건드려 server_default 0 그대로(회귀 0, additive).

`status` 3종: `container_created`(컨테이너만 생성됨, publish 실패로 부분 성공) ·
`published`(완료) · `failed`(컨테이너 생성 자체가 실패 — PO 결정②: 이 경우도 새 행을
만들지 않고 같은 (gate_id, version_id, sequence) 행을 그 자리에서 갱신해 재시도한다)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# story #3808(Phase3·3-3 PR2, 카디르 QA 실측 2026-09-11 — #3395/PR#3752 동시발행
# 500 재발 처방) — 제약 이름의 유일한 정본. channel_posts.py의 동시 발행 경합
# IntegrityError 판정(SAVEPOINT 안, constraint_name 문자열 비교)이 이 상수를
# import해서 쓴다 — 제약 이름이 여기(모델)와 그쪽(서비스) 두 곳에 각자 하드코딩
# 돼 있으면 한쪽만 바뀔 때(이번처럼 sequence 열 추가로 이름이 바뀐 경우) 조용히
# 어긋나 경합 처리가 통째로 죽는다(카디르 QA가 잡은 실 회귀 — 판정이 항상
# raise로 떨어져 threads/instagram/facebook 전 채널에서 동시 발행 2건 500 재발).
UQ_GATE_VERSION_SEQUENCE_CONSTRAINT_NAME = "uq_channel_publications_gate_version_sequence"


class ChannelPublication(Base):
    __tablename__ = "channel_publications"
    __table_args__ = (
        UniqueConstraint(
            "gate_id", "version_id", "sequence", name=UQ_GATE_VERSION_SEQUENCE_CONSTRAINT_NAME,
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    gate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # FK 없음 — channel_connections·channel_post_drafts와 동일 관례(그라운딩 §9).
    connection_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    channel: Mapped[str] = mapped_column(Text, nullable=False)
    # story #3808(Phase3·3-3 PR2, 페드루 PO 確定 2026-09-11) — X 스레드(연속 게시) N건
    # 지원. 헤드=1, 두 번째=2... (1-indexed, 페드루 PO 明示 — 단일 글도 1로 채운다,
    # 0-indexed 아님). threads/instagram/facebook 등은 이 열을 절대 안 건드려
    # server_default 0 그대로(다른 값 영역이라 X의 1-indexed와 절대 안 겹친다 —
    # 어차피 채널마다 (gate_id, version_id)가 겹칠 일 자체가 없어 무관).
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    external_container_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    permalink: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="container_created")
    error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #3640(BE·샌드박스 리그·소형, 페드루 PO 確定 2026-09-07) — `[sandbox:
    # expire-after-publish]` 마커가 발행 시 media_id에 영구 접미사를 새겨 fetch_replies가
    # «매번» 401을 던지던 「영구 지뢰」를 닫는다. 이 발행물에서 그 401을 이미 한 번
    # 관측했으면(양성대조 완료) True — channel_post_comments.py가 그 뒤부터 접미사를
    # 벗긴 media_id로 재조회해 200을 받는다(sandbox 어댑터 자체는 결정적·상태 없음 그대로,
    # 상태는 이 발행물 행에만 산다).
    sandbox_expired_once: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
