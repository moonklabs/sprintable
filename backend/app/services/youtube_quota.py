"""story #3815(Phase3·3-5 PR2, 페드루 PO 確定 2026-09-12) — YouTube Data API v3
종량 quota. `x_publish_budget.py`/`generation_budget.py`의 계산 프리미티브(evidence
합산+거부 신호)와 같은 사상이지만 **다른 축** — X/생성비는 조직별 월 지갑인데,
이건 **플랫폼 전체가 공유하는 일일 카운터**(우리 GCP 프로젝트가 Google에 매일
받는 quota는 조직 수와 무관하게 하나뿐이다). 그래서 `compute_generation_budget_
status`(조직별 `org_content_rules` 조회+조직 필터 합산)를 그대로 재사용하지 않고
별도 함수로 연다 — org_id 필터를 빼고 플랫폼 전체 합산, 기간도 "월"이 아니라
"오늘(UTC)"이다.

한도·단가는 `app/core/config.py::Settings`의 env 값(⚠️미확認 근거는 그 파일 상단
딱지 참고) — `org_content_rules`가 아니라 `Evidence.org_id`는 여전히 채운다
(어느 조직이 오늘 quota를 얼마나 썼는지 귀속 추적용, 판정 자체는 org 무관 합산)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.evidence import Evidence

YOUTUBE_QUOTA_KIND = "youtube_quota_units"


class YouTubeQuotaExceededError(Exception):
    """AC "422 YOUTUBE_QUOTA_EXCEEDED" 신호 — 라우터가 이 예외를 그 코드로 감싼다
    (generation_budget.py::GenerationBudgetExceededError와 동형 4값 계약이지만
    "_minor"(통화 최소단위)가 아니라 "_units"(quota 단위)라 필드명을 갈아 별도
    클래스로 연다 — 통화 예산과 섞으면 다음 사람이 단위를 헷갈린다).

    story #3815(페드루 PO 낱말 확定 2026-09-12 10:46Z) — 리셋 경계가 "오늘/내일"
    (날짜뿐)이 아니라 정확한 **시각**이라(플랫폼 전체 하루 카운터, `_platform_
    quota_day_window`의 `end`) `reset_at`을 싣는다 — FE가 "{reset_at}부터 다시"로
    쓸 수 있게(ChannelRateLimitedError.reset_at과 동형 관례). 사용자 문자열엔
    "quota" 낱말을 안 쓴다(→"사용량") — 이 예외 자신의 `str()`은 로그용 영문
    기술 문구일 뿐, 사람에게 보이는 최종 문장은 라우터가 i18n_catalog로 조립.

    story #3815(배포 83 픽셀 결함, 페드루 PO 지적 2026-09-12 23:50Z) —
    `reset_timezone`(IANA 이름, 예: "America/Los_Angeles")을 함께 실어 라우터가
    `TIMEZONE_DISPLAY_NAMES`로 사람이 읽을 문구를 조립할 수 있게 한다 — `reset_at`
    (정확한 UTC 시각)과 이 값이 항상 같은 채널 어댑터 선언(`quota_reset_timezone`)
    에서 나온다(두 곳이 각자 짓지 않는다)."""

    def __init__(
        self, *, limit_units: int, spent_units: int, estimated_units: int, remaining_units: int,
        reset_at: datetime, reset_timezone: str,
    ):
        self.limit_units = limit_units
        self.spent_units = spent_units
        self.estimated_units = estimated_units
        self.remaining_units = remaining_units
        self.reset_at = reset_at
        self.reset_timezone = reset_timezone
        super().__init__(
            f"youtube platform-wide daily quota exceeded: limit={limit_units} spent={spent_units} "
            f"estimated={estimated_units} remaining={remaining_units} reset_at={reset_at.isoformat()} "
            f"reset_timezone={reset_timezone}"
        )


def _platform_quota_day_window(now: datetime, tz_name: str) -> tuple[datetime, datetime]:
    """"오늘"을 `tz_name`(IANA, 채널 어댑터의 `quota_reset_timezone` 선언값) 기준
    자정~다음날 자정으로 — generation_budget.py::_period_window의 "month"와 동형
    사상, 다른 기간 단위. org_time.py::org_midnight_utc와 같은 계산 원리(naive
    date + ZoneInfo tzinfo = 그 tz 기준 자정, DST 자동 반영)이지만 이 함수는
    `now`를 인자로 받는다(호출부가 이미 그 관례 — 테스트가 임의 시각을 주입해
    경계를 결정적으로 검증할 수 있어야 한다, org_time.py는 "지금"만 다뤄 이
    요구가 없었다). 다음날 경계도 date끼리 더한 뒤 새 datetime을 만든다(aware
    datetime에 timedelta를 더하는 것과 달리, tzinfo 재계산 모호성이 없다)."""
    tz = ZoneInfo(tz_name)
    local_date = now.astimezone(tz).date()
    next_date = local_date + timedelta(days=1)
    start = datetime(local_date.year, local_date.month, local_date.day, tzinfo=tz).astimezone(timezone.utc)
    end = datetime(next_date.year, next_date.month, next_date.day, tzinfo=tz).astimezone(timezone.utc)
    return start, end


async def get_platform_youtube_quota_spent_units(
    db: AsyncSession, *, channel: str, now: datetime | None = None,
) -> int:
    """오늘(채널 어댑터가 선언한 시간대 기준) 플랫폼 전체(모든 조직 합산) youtube
    quota 소비량. org_id 필터가 없는 게 이 함수의 요점 — x_publish_budget류와
    다른 자리. `channel`은 리셋 시간대를 결정할 뿐 evidence 필터 축이 아니다
    (youtube/youtube_sandbox 둘 다 같은 플랫폼 카운터를 흉내)."""
    from app.services.channel_adapters import get_channel_adapter

    now = now or datetime.now(timezone.utc)
    adapter = get_channel_adapter(channel)
    tz_name = adapter.quota_reset_timezone if adapter is not None else "UTC"
    start, end = _platform_quota_day_window(now, tz_name)
    rows = (await db.execute(
        select(Evidence.payload).where(
            Evidence.type == "metric",
            Evidence.payload["kind"].astext == YOUTUBE_QUOTA_KIND,
            Evidence.created_at >= start, Evidence.created_at < end,
        )
    )).scalars().all()
    return sum(int(p["units"]) for p in rows if p and p.get("units") is not None)


async def check_youtube_quota_or_raise(
    db: AsyncSession, *, channel: str, estimated_units: int, now: datetime | None = None,
) -> None:
    """`_publish_x_thread_draft`류의 발행 직전 재검사와 같은 위치 축 — YouTube
    발행 provider 호출(resumable upload session 생성) 直前에 부른다. `channel`은
    리셋 시간대 선언을 읽는 축(youtube/youtube_sandbox 호출부가 자기 channel
    문자열을 그대로 넘긴다)."""
    from app.services.channel_adapters import get_channel_adapter

    now = now or datetime.now(timezone.utc)
    adapter = get_channel_adapter(channel)
    tz_name = adapter.quota_reset_timezone if adapter is not None else "UTC"
    limit_units = settings.youtube_quota_daily_limit_units
    spent_units = await get_platform_youtube_quota_spent_units(db, channel=channel, now=now)
    remaining_units = limit_units - spent_units
    if estimated_units > remaining_units:
        _, reset_at = _platform_quota_day_window(now, tz_name)
        raise YouTubeQuotaExceededError(
            limit_units=limit_units, spent_units=spent_units,
            estimated_units=estimated_units, remaining_units=remaining_units,
            reset_at=reset_at, reset_timezone=tz_name,
        )


async def record_youtube_quota_usage_evidence(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_id: uuid.UUID, publication_id: uuid.UUID,
    event: str, units: int,
) -> None:
    """`record_api_usage_cost_evidence`와 동형 멱등 축 — **publication_id+event**로
    (사용처가 "insert" 1회·"list" N회처럼 같은 publication에 여러 event가 있을 수
    있어 X의 publication_id+sequence 대신 이 조합)."""
    existing = (await db.execute(
        select(Evidence.id).where(
            Evidence.org_id == org_id, Evidence.type == "metric",
            Evidence.payload["kind"].astext == YOUTUBE_QUOTA_KIND,
            Evidence.payload["publication_id"].astext == str(publication_id),
            Evidence.payload["event"].astext == event,
        )
    )).scalar_one_or_none()
    if existing is not None:
        return
    db.add(Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        type="metric", ref=str(publication_id), source="platform",
        payload={
            "kind": YOUTUBE_QUOTA_KIND, "units": units, "event": event, "publication_id": str(publication_id),
        },
    ))
    await db.commit()
