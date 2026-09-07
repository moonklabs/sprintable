"""story #3620(Phase2·BE+FE·실측·4열, 페드루 PO 確定 2026-09-07, migration 0349) —
「채널 원본 지표와 evidence 대조」 기록 원장. §7 Phase 2 실측 열 5종 중 3618이
범위 밖으로 남긴 마지막 제품 몫 — 발행 1개에 대해 "지금" 채널 API를 재조회한
원본값(raw)과 "기간 내 최신 captured 스냅샷"의 정규화 값을 지표별로 비교해 대조
기록 1행을 남긴다.

FK 없음 — channel_connections·insight_snapshots와 동일 관례(그라운딩 §9,
publication_id는 channel_publications.id를 가리키는 값일 뿐)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class ChannelPublicationReconciliation(Base):
    __tablename__ = "channel_publication_reconciliations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    publication_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # 이 대조가 비교 대상으로 삼은 스냅샷(있으면) — FK 없음(위 관례). 스냅샷이
    # 하나도 없었으면 NULL(그 경우 모든 지표 판정이 "unmeasured"로 남는다 —
    # 비교할 저장값 자체가 없어서, AC 명시 "이번엔 해석하지 않는다"와 동형).
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # 어댑터 원본 응답 그대로(insight_snapshots.raw_payload와 동형 — 재정규화 근거 보존).
    live_raw: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # {impressions: "match"|"mismatch"|"unmeasured", ...} — 정의 1(모듈 docstring)의
    # 지표별 판정 결과. 7키(insight_snapshots.NORMALIZED_KEYS의 첫 7개, GA4 inflow
    # 3키는 범위 밖 — 이 스토리는 채널 어댑터 재조회 경로만 다룬다).
    verdicts: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # 정의 3(불일치 수)의 분자 판정을 매번 verdicts JSONB를 스캔하지 않고 바로 세게
    # 하는 비정규화 컬럼(verdicts가 정본, 이 컬럼은 그 요약) — any(v=="mismatch").
    has_mismatch: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # NULL=에이전트 API 경로(호출자가 human이 아님 — evidence.created_by NULL 관례와
    # 동형, "특정 행위자 없는 순수 시스템 기록"이 아니라 "에이전트 행위자"이므로
    # 정확히는 다르지만, 이 스토리는 사람/에이전트 둘 다 같은 함수를 타는 게 AC4
    # 핵심이라 별도 actor_type 컬럼 없이 requested_by만으로 "누가 눌렀나"를 남긴다
    # — member_id는 사람·에이전트 둘 다 가진 값, 굳이 NULL 분기를 안 둔다).
    requested_by_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
