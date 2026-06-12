"""L2-S3: L1 activity stream adapter (`L1ActivitySource`).

블루프린트 §5 S3. L2 휴리스틱 트리거가 L1 canonical 활동 스트림을 소비하기 위한 얇은 어댑터.
BE-6 helper(`poll_activities_after_seq`·`latest_activity_for_object`)를 감싸 ORM `ActivityEvent`
행을 L2 내부 계약인 `ActivitySignal` dataclass로 normalize한다 — evaluator(S4) 등 다운스트림을
ORM 모델 변화로부터 격리.

AC②: L1 모듈 import가 실패해도(미배포·리팩터 등) startup은 깨지지 않고 source가 disabled로 떨어진다
(7a57e7b1 OSS-stub graceful guard 선례). disabled면 poll은 빈 배치·latest는 None을 반환해 L2
트리거가 조용히 무동작한다.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ActivitySignal:
    """L1 canonical 활동 1행의 L2-내부 정규화 표현.

    evaluator(S4)가 의존하는 안정 계약 — 트리거 로직을 ActivityEvent ORM 스키마로부터 분리한다.
    payload/recipient/source 컬렉션은 frozen dataclass 불변성을 위해 복사(tuple/dict)한다.
    """

    activity_seq: int
    activity_id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    verb: str
    occurred_at: datetime
    actor_id: uuid.UUID | None = None
    object_type: str | None = None
    object_id: uuid.UUID | None = None
    dedup_key: str = ""
    payload: dict = field(default_factory=dict)
    recipient_ids: tuple[uuid.UUID, ...] = ()
    recipient_types: tuple[str, ...] = ()
    representative_event_id: uuid.UUID | None = None
    source_event_ids: tuple[uuid.UUID, ...] = ()

    @classmethod
    def from_activity(cls, row) -> "ActivitySignal":
        """`ActivityEvent` ORM 행(혹은 동형 객체)을 ActivitySignal로 normalize(AC①)."""
        return cls(
            activity_seq=row.activity_seq,
            activity_id=row.activity_id,
            org_id=row.org_id,
            project_id=row.project_id,
            verb=row.verb,
            occurred_at=row.occurred_at,
            actor_id=row.actor_id,
            object_type=row.object_type,
            object_id=row.object_id,
            dedup_key=row.dedup_key,
            payload=dict(row.payload or {}),
            recipient_ids=tuple(row.recipient_ids or ()),
            recipient_types=tuple(row.recipient_types or ()),
            representative_event_id=row.representative_event_id,
            source_event_ids=tuple(row.source_event_ids or ()),
        )


# AC②: L1 활동 스트림 import 실패해도 startup crash 0 — source는 disabled로 격리.
try:
    from app.services.activity_stream import (
        latest_activity_for_object as _latest_activity_for_object,
        poll_activities_after_seq as _poll_activities_after_seq,
    )

    _L1_AVAILABLE = True
    _L1_IMPORT_ERROR: str | None = None
except Exception as exc:  # pragma: no cover - 방어적 가드(정상 경로에선 import 성공)
    _poll_activities_after_seq = None  # type: ignore[assignment]
    _latest_activity_for_object = None  # type: ignore[assignment]
    _L1_AVAILABLE = False
    _L1_IMPORT_ERROR = repr(exc)


class L1ActivitySource:
    """L1 canonical 활동 스트림을 L2 트리거에 공급하는 어댑터.

    - `poll_after_seq`: cursor 이후 신규 활동을 activity_seq ASC(AC③)로 ActivitySignal 배치 + next
      cursor로 반환.
    - `latest_for_object`: object 기준 최신 활동 1건(L4 anchoring 경로 재사용).

    L1 미가용 시 `enabled=False` — poll은 `([], None)`, latest는 `None`을 반환하고 트리거는 조용히
    무동작(AC②). 인스턴스 생성 시 disabled를 1회 경고한다.
    """

    def __init__(self) -> None:
        self._enabled = _L1_AVAILABLE
        if not self._enabled:
            logger.warning(
                "L1ActivitySource disabled — L1 activity stream import 실패(%s); "
                "L2 트리거는 무동작으로 격리됨.",
                _L1_IMPORT_ERROR,
            )

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def poll_after_seq(
        self,
        db: "AsyncSession",
        after_seq: int,
        *,
        limit: int = 100,
        org_id: uuid.UUID | None = None,
    ) -> tuple[list[ActivitySignal], int | None]:
        """after_seq 초과 활동을 activity_seq ASC ActivitySignal 배치 + next cursor로.

        org_id 생략 = 전 org(시스템 트리거 워커). disabled면 `([], None)`.
        """
        if not self._enabled:
            return [], None
        rows, next_after_seq = await _poll_activities_after_seq(
            db, after_seq, limit=limit, org_id=org_id
        )
        signals = [ActivitySignal.from_activity(r) for r in rows]
        # AC③: helper가 이미 ASC를 보장하나, 어댑터 계약으로 명시 재정렬(불변식 방어 — cursor 진행은
        # 마지막 원소 seq에 의존하므로 순서 역전은 누락·재처리를 유발).
        signals.sort(key=lambda s: s.activity_seq)
        return signals, next_after_seq

    async def latest_for_object(
        self,
        db: "AsyncSession",
        org_id: uuid.UUID,
        object_type: str,
        object_id: uuid.UUID,
    ) -> ActivitySignal | None:
        """object의 최신 canonical 활동 1건을 ActivitySignal로. 없거나 disabled면 None."""
        if not self._enabled:
            return None
        row = await _latest_activity_for_object(db, org_id, object_type, object_id)
        return ActivitySignal.from_activity(row) if row is not None else None
