"""story #3475(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 블루프린트 v3 §7
Phase 1 「실측」 5지표를 제품이 센다(지금까지 런북 회차마다 사람이 손으로 셌다).

5줄 確定 그대로:
1. 정시 = `published_at - scheduled_at <= platform_settings.on_time_tolerance_seconds`
   (기본 120s — cron 1분 tick + 워커 여유, 어드민 관리값, `on_time_tolerance_seconds`
   마이그 0329). 정시율 = 정시 발행 수 / 예약 발행(scheduled_at 있는 성공) 수.
   재료: `publication_commands.scheduled_at` × `channel_publications.published_at`
   (gate_id·approved_version=version_id 조인 — channel_post/site_post-external 공용
   테이블, #3479/#3830 그라운딩). hosted_site 발행(연결 없음)은 channel_publications
   행 자체가 없어 이 지표 모수 밖 — 어댑터가 매개하는 "예약된" 발행만 다룬다(정시성
   자체가 어댑터 지연을 재는 개념이라 hosted_site 즉시발행엔 해당 없음).
2. 중복 0 — `channel_publications` UNIQUE(gate_id, version_id)가 구조적으로 0을
   보장한다. 이 함수는 세지 않고 실 쿼리(group by having count>1)로 0을 낸다 —
   제약이 사라지면(회귀) 이 값이 움직인다.
3. 승인 없는 호출·복구시간 — `publication_attempts`(story #3474) 원장 기준.
   `unapproved_adapter_calls` = adapter_called인데 approval_check != 'ok'인 시도 수
   (정상 0). `recovery_seconds_p50/p95` = dead_letter 뒤 첫 성공 시도까지의 시간 —
   원장만으로 파생(publication_commands에 신규 컬럼 0, #3474 모델 docstring 그대로).
4. 토큰 만료 — `connections_expired`(status IN expired/revoked/error, 지금 상태
   스냅샷 — window 무관) · `connections_expiring_7d`(status=active·
   token_expires_at < now+7d, 고정 7일 지평선 — window 토글과 무관, FE §18 정본).
5. `on_time_rate`는 분모 0이면 null(「0」과 「미측정」을 가른다 — FE §18-2 정본).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.channel_connection import ChannelConnection
from app.models.channel_publication import ChannelPublication
from app.models.publication_attempt import PublicationAttempt
from app.models.publication_command import PublicationCommand
from app.services.platform_settings import get_platform_settings

_EXPIRED_STATUSES = ("expired", "revoked", "error")


@dataclass(frozen=True)
class PublishingMetrics:
    window: str
    on_time_rate: float | None
    on_time_numer: int
    on_time_denom: int
    duplicate_publications: int
    unapproved_adapter_calls: int
    recovery_seconds_p50: float | None
    recovery_seconds_p95: float | None
    connections_expired: int
    connections_expiring_7d: int
    computed_at: datetime


def _window_start(window: str, *, now: datetime) -> datetime:
    days = 7 if window == "7d" else 30
    return now - timedelta(days=days)


async def _compute_on_time_rate(
    session: AsyncSession, *, org_id: uuid.UUID, window_start: datetime, tolerance_seconds: int,
) -> tuple[float | None, int, int]:
    """예약 발행(scheduled_at 있는 성공) 모수 안에서 정시 비율. hosted_site(연결
    없음, channel_publications 행 자체가 없음)는 이 조인 밖 — 어댑터 매개 발행만.
    표본 규모가 작아(런북 회차 단위) 파이썬에서 판정 — DB dialect별 interval 연산
    차이를 피한다."""
    stmt = (
        select(PublicationCommand.scheduled_at, ChannelPublication.published_at)
        .select_from(PublicationCommand)
        .join(
            ChannelPublication,
            (ChannelPublication.gate_id == PublicationCommand.gate_id)
            & (ChannelPublication.version_id == PublicationCommand.approved_version),
        )
        .where(
            PublicationCommand.org_id == org_id,
            PublicationCommand.scheduled_at.is_not(None),
            PublicationCommand.scheduled_at >= window_start,
            ChannelPublication.status == "published",
        )
    )
    rows = (await session.execute(stmt)).all()
    denom = len(rows)
    if denom == 0:
        return None, 0, 0
    tolerance = timedelta(seconds=tolerance_seconds)
    numer = sum(
        1 for scheduled_at, published_at in rows
        if published_at is not None and (published_at - scheduled_at) <= tolerance
    )
    return numer / denom, numer, denom


async def _compute_duplicate_publications(
    session: AsyncSession, *, org_id: uuid.UUID, window_start: datetime,
) -> int:
    """UNIQUE(gate_id, version_id)가 구조적으로 0을 보장 — 세지 않고 실 쿼리로 낸다
    (제약 회귀 시 이 값이 움직인다, 확定②)."""
    dup_subq = (
        select(ChannelPublication.gate_id)
        .where(ChannelPublication.org_id == org_id, ChannelPublication.created_at >= window_start)
        .group_by(ChannelPublication.gate_id, ChannelPublication.version_id)
        .having(func.count() > 1)
    )
    result = await session.execute(select(func.count()).select_from(dup_subq.subquery()))
    return int(result.scalar_one())


async def _compute_unapproved_adapter_calls(
    session: AsyncSession, *, org_id: uuid.UUID, window_start: datetime,
) -> int:
    stmt = (
        select(func.count())
        .select_from(PublicationAttempt)
        .join(PublicationCommand, PublicationCommand.id == PublicationAttempt.command_id)
        .where(
            PublicationCommand.org_id == org_id,
            PublicationAttempt.started_at >= window_start,
            PublicationAttempt.adapter_called.is_(True),
            PublicationAttempt.approval_check != "ok",
        )
    )
    return int((await session.execute(stmt)).scalar_one())


async def _compute_recovery_percentiles(
    session: AsyncSession, *, org_id: uuid.UUID, window_start: datetime,
) -> tuple[float | None, float | None]:
    """dead_letter_at이 있는 커맨드마다, 그 뒤 첫 성공 시도(approval_check='ok' AND
    adapter_called AND finished_at IS NOT NULL AND finished_at > dead_letter_at)까지의
    간격(초)을 파이썬에서 percentile로 낸다 — 표본이 적어(원장 규모) DB 윈도 함수보다
    명확하고 테스트하기 쉽다."""
    commands_stmt = select(PublicationCommand.id, PublicationCommand.dead_letter_at).where(
        PublicationCommand.org_id == org_id,
        PublicationCommand.dead_letter_at.is_not(None),
        PublicationCommand.dead_letter_at >= window_start,
    )
    dead_letter_rows = (await session.execute(commands_stmt)).all()
    if not dead_letter_rows:
        return None, None

    durations: list[float] = []
    for command_id, dead_letter_at in dead_letter_rows:
        first_success_stmt = (
            select(PublicationAttempt.finished_at)
            .where(
                PublicationAttempt.command_id == command_id,
                PublicationAttempt.approval_check == "ok",
                PublicationAttempt.adapter_called.is_(True),
                PublicationAttempt.finished_at.is_not(None),
                PublicationAttempt.finished_at > dead_letter_at,
            )
            .order_by(PublicationAttempt.finished_at.asc())
            .limit(1)
        )
        finished_at = (await session.execute(first_success_stmt)).scalar_one_or_none()
        if finished_at is not None:
            durations.append((finished_at - dead_letter_at).total_seconds())

    if not durations:
        return None, None
    durations.sort()
    return _percentile(durations, 0.50), _percentile(durations, 0.95)


def _percentile(sorted_values: list[float], p: float) -> float:
    """nearest-rank 방식(표본 1개면 그 값). statistics.quantiles는 표본<2에서
    예외를 내 소표본(복구 이벤트는 드물다)에 안 맞는다."""
    if len(sorted_values) == 1:
        return sorted_values[0]
    idx = min(len(sorted_values) - 1, max(0, round(p * (len(sorted_values) - 1))))
    return sorted_values[idx]


async def _compute_connection_expiry(
    session: AsyncSession, *, org_id: uuid.UUID, now: datetime,
) -> tuple[int, int]:
    """지금 상태의 스냅샷 — window(7d/30d 토글)와 무관하다(FE §18 정본: 7일 내
    만료는 고정 7일 지평선)."""
    expired_stmt = select(func.count()).select_from(ChannelConnection).where(
        ChannelConnection.org_id == org_id, ChannelConnection.status.in_(_EXPIRED_STATUSES),
    )
    expiring_stmt = select(func.count()).select_from(ChannelConnection).where(
        ChannelConnection.org_id == org_id,
        ChannelConnection.status == "active",
        ChannelConnection.token_expires_at.is_not(None),
        ChannelConnection.token_expires_at < now + timedelta(days=7),
    )
    expired = int((await session.execute(expired_stmt)).scalar_one())
    expiring = int((await session.execute(expiring_stmt)).scalar_one())
    return expired, expiring


async def compute_publishing_metrics(
    session: AsyncSession, *, org_id: uuid.UUID, window: str,
) -> PublishingMetrics:
    now = datetime.now(timezone.utc)
    window_start = _window_start(window, now=now)
    settings = await get_platform_settings(session)

    on_time_rate, on_time_numer, on_time_denom = await _compute_on_time_rate(
        session, org_id=org_id, window_start=window_start, tolerance_seconds=settings.on_time_tolerance_seconds,
    )
    duplicate_publications = await _compute_duplicate_publications(session, org_id=org_id, window_start=window_start)
    unapproved_adapter_calls = await _compute_unapproved_adapter_calls(
        session, org_id=org_id, window_start=window_start,
    )
    recovery_p50, recovery_p95 = await _compute_recovery_percentiles(
        session, org_id=org_id, window_start=window_start,
    )
    connections_expired, connections_expiring_7d = await _compute_connection_expiry(session, org_id=org_id, now=now)

    return PublishingMetrics(
        window=window,
        on_time_rate=on_time_rate,
        on_time_numer=on_time_numer,
        on_time_denom=on_time_denom,
        duplicate_publications=duplicate_publications,
        unapproved_adapter_calls=unapproved_adapter_calls,
        recovery_seconds_p50=recovery_p50,
        recovery_seconds_p95=recovery_p95,
        connections_expired=connections_expired,
        connections_expiring_7d=connections_expiring_7d,
        computed_at=now,
    )
