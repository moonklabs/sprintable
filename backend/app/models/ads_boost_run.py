"""story #3806(Phase3·3-2 PR3 워커 fix, 페드루 PO 確定 2026-09-11) — 승인된 ads_boost
게이트가 실제로 실행되면서 얻는 Meta 측 정체성(campaign/adset/ad id)·현재 상태 원장.

`gate`에 쓰지 않는 이유(페드루 明示) — sealed_* 열은 "승인된 것"의 불변 스냅샷이라
실행 뒤에만 알 수 있는 외부 id를 얹으면 그 불변성이 깨진다. 1 gate = 1 run(그 게이트가
재봉인/재승인되어도 같은 boost 실행 단위이므로 새 run을 만들지 않고 이 행을 갱신
— `sealed_ads_boost_version_id`가 바뀌는 재승인도 "그 보이는 게시물의 같은 boost"라는
연속성은 유지된다는 판단, PR 4가 지출을 조회할 identity가 흔들리면 안 되므로)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AdsBoostRun(Base):
    __tablename__ = "ads_boost_runs"
    __table_args__ = (
        UniqueConstraint("gate_id", name="uq_ads_boost_runs_gate_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # FK 없음 — channel_connections·publication_commands와 동일 관례(그라운딩 §9).
    gate_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # Meta act_<id> 계정 하위 3계층(campaign→adset→ad) — object_story_id 기반 「Page
    # post ad」(PR 2 그라운딩 ⑤ 확認)가 실제로 만드는 3개 객체. 셋 다 nullable — 실행
    # 첫 시도 전(pending) 또는 provider 실패 시 비어 있을 수 있다.
    campaign_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    adset_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    ad_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 'pending'|'running'|'paused'|'failed' — publication_command.status(그 요청
    # 자체의 처리 상태)와 다른 축이다: 이건 "Meta 쪽 캠페인이 지금 어느 상태인가"의
    # 최종 관측값(마지막으로 성공한 toggle의 결과), publication_command는 "그 요청을
    # 처리했나"의 이력 원장.
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    paused_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # story #3806(Phase3·3-2 PR 11, 페드루 PO 確定 2026-09-11 16:20Z) — 캡처된 paid
    # 지출 합이 gate.sealed_ads_budget_minor에 도달/초과한 순간(1회, 0368 마이그).
    # null=미도달 — 지어내지 않는다. 이 값이 찍힌 뒤에만 자동 중지를 시도해 매 tick
    # 재-중지 요청을 안 보내는 멱등 게이트(ads_spend_snapshots.py::_enforce_spend_cap).
    cap_reached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )
