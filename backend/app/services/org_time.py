"""story #3674(BE·FE·確定, 페드루 PO 確定 2026-09-07) — 「오늘」의 경계를 조직
시간대로. 3665(#4020)가 프로세스 로컬 TZ 직접 호출(`date` 모듈의 `today` 메서드)을
UTC로 고정해 "환경마다 다른 오늘"은 닫았지만, 남은 것은 "조직의 오늘" — KST(UTC+9)
조직은 KST 00:00~09:00 사이 UTC 날짜가 아직 하루 전이라, 스탠드업/일별 집계의
"오늘" 경계가 사람이 보는 날과 어긋난다(그라운딩 story #3674 description ①~⑤).

`organizations.timezone`(story #46da6450, migration 0320)이 이미 착지해 있었으나
그 착지 범위는 "저장/표시만"이었다(model 주석 — 서버 시각 처리는 UTC-explicit
무변경) — 이 파일이 그 필드를 처음으로 "오늘 경계 계산"에 쓴다(새 확장, PO 確定).

시그니처는 **request가 아니라 org**를 받는다 — 크론/잡 경로(요청 컨텍스트 자체가
없음, l2_trigger_worker·command_center 집계 등)가 org_id만으로 성립해야 하는 것이
org.timezone(방식 A)을 요청별 tz 헤더(방식 B)보다 택한 이유 그 자체다(그라운딩 ③).

null org.timezone(미설정, 백필 없음)은 UTC로 폴백 — 3665가 명시적으로 만든
UTC 고정 동작을 이 폴백 분기 안으로 그대로 흡수한다(기존 동작 보존, 회귀 0)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.models.organization import Organization

_UTC = ZoneInfo("UTC")


def org_tz(org_timezone: str | None) -> ZoneInfo:
    """조직 timezone 문자열(IANA) → ZoneInfo. None(미설정)이면 UTC(3665 동작 보존)."""
    if not org_timezone:
        return _UTC
    return ZoneInfo(org_timezone)


def org_today(org_timezone: str | None) -> date:
    """이 조직이 지금 보는 "오늘"(캘린더 날짜). org_timezone이 None이면 UTC 오늘
    (3665와 동일 값 — standups.py:308류가 이 함수로 옮겨가도 null org에선 결과가
    안 바뀐다)."""
    return datetime.now(timezone.utc).astimezone(org_tz(org_timezone)).date()


def org_midnight_utc(org_timezone: str | None) -> datetime:
    """이 조직 시간대 기준 "오늘 0시"를 UTC-aware datetime으로 — timestamptz 컬럼과
    직접 비교하는 자리(예: deployment_lifecycle.py의 "오늘 실행 횟수" 카운트)용.
    org_today(tz)의 date에 그 tz 자체를 붙여 자정을 만든 뒤(naive date + tzinfo=tz는
    "그 tz 기준 자정"을 정확히 표현한다 — deployment_lifecycle.py 원 결함처럼 tz를
    UTC로 갈아 끼우는 게 아니라 처음부터 올바른 tz로 만든다) UTC로 변환한다."""
    tz = org_tz(org_timezone)
    today = org_today(org_timezone)
    local_midnight = datetime(today.year, today.month, today.day, tzinfo=tz)
    return local_midnight.astimezone(timezone.utc)


def to_org_date(dt: datetime, org_timezone: str | None) -> date:
    """UTC(또는 임의 tz-aware) 시각을 이 조직 시간대의 캘린더 날짜로 변환.
    dt가 naive면 astimezone()이 시스템 로컬 tz로 잘못 해석할 위험이 있다 —
    호출부는 항상 tz-aware datetime(UTC 저장 관례)을 넘길 것."""
    return dt.astimezone(org_tz(org_timezone)).date()


def org_date_sql(column: ColumnElement, org_timezone: str | None) -> ColumnElement:
    """SQL 레벨 일별 그룹핑(예: command_center.py의 `func.date(AgentRun.started_at)`
    대체) — Postgres `timezone(name, ts)`가 UTC 저장값을 그 tz의 로컬시각으로
    변환한 뒤 `date()`로 자른다. Postgres의 `timezone()` 함수는 IANA 이름 문자열을
    그대로 받아(ZoneInfo 키와 동일 포맷) 별도 변환이 필요 없다."""
    tz_name = org_timezone or "UTC"
    return func.date(func.timezone(tz_name, column))


async def get_org_timezone(session: AsyncSession, org_id: uuid.UUID) -> str | None:
    """org_id로 organizations.timezone 단일 컬럼만 조회(불필요한 전체 row load
    없음). 조직이 존재하지 않으면 None(호출부가 이미 org_id를 신뢰하는 경로라는
    전제 — 이 함수는 존재 검증을 안 한다, 검증은 호출부의 기존 접근권 가드 몫)."""
    return (
        await session.execute(select(Organization.timezone).where(Organization.id == org_id))
    ).scalar_one_or_none()
