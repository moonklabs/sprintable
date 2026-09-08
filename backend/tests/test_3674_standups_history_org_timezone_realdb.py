"""story #3674(BE 確定, 페드루 PO 確定 2026-09-07) — standups.py:308의 "오늘" 경계가
org.timezone을 실제로 쓰는지 realdb로 확認. 경계 표본은 스토리 본문 지정 그대로:
UTC 2026-09-07T23:30(Asia/Seoul로는 이미 2026-09-08 08:30, KST 00:00~09:00 창 안) —
org.timezone='Asia/Seoul'이면 "오늘"=09-08, org.timezone=NULL(미설정)이면 "오늘"=
09-07(3665/#4020 동작 보존, 회귀 0).

두 날짜(09-07·09-08)에 각 1건씩 표본을 심어 days=1이 org.timezone에 따라 정확히
다른 1건만 골라내는지로 "org tz가 실제로 경계를 바꾼다"를 직접 증명한다(그냥 "0건
아님"보다 강한 주장 — 정확히 어느 날짜가 선택되는지까지 고정)."""
from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d3674d00-0000-0000-0000-000000000010")
PROJ = uuid.UUID("d3674d00-0000-0000-0000-000000000011")
AUTHOR_USER = uuid.UUID("d3674d00-0000-0000-0000-000000000013")
AUTHOR_MEMBER = uuid.UUID("d3674d00-0000-0000-0000-000000000014")

_UTC_TODAY = date(2026, 9, 7)
_SEOUL_TODAY = date(2026, 9, 8)  # UTC 2026-09-07T23:30 기준 Asia/Seoul 캘린더 날짜.
_FROZEN_UTC = datetime(2026, 9, 7, 23, 30, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AUTHOR_USER), email=None,
        claims={"app_metadata": {"org_id": str(ORG)}},
        org_id=str(ORG),
    )


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM standup_entry_projects WHERE project_id='{PROJ}'",
        f"DELETE FROM standup_entries WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE id='{PROJ}'",
        f"DELETE FROM users WHERE id='{AUTHOR_USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s, *, org_timezone: str | None) -> None:
    """UTC-오늘(09-07)·Asia/Seoul-오늘(09-08) 각 1건. org.timezone은 표본별로 다르게."""
    await _clean(s)
    tz_sql = f"'{org_timezone}'" if org_timezone else "NULL"
    await s.execute(text(
        f"INSERT INTO organizations (id,name,slug,plan,timezone) VALUES "
        f"('{ORG}','O','d3674d-org','free',{tz_sql})"
    ))
    await s.execute(text(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{AUTHOR_USER}','d3674d@d3674d.test','x','D3674D',true,true,0,false,0)"
    ))
    await s.execute(text(f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P3674D')"))
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{AUTHOR_MEMBER}','{ORG}','{AUTHOR_USER}','human','D3674D',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,role,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{AUTHOR_MEMBER}','member','granted')"
    ))
    for the_date, label in [(_UTC_TODAY, "utc-today"), (_SEOUL_TODAY, "seoul-today")]:
        eid = uuid.uuid4()
        created_at = datetime(the_date.year, the_date.month, the_date.day, 9, 0, tzinfo=timezone.utc)
        await s.execute(text(
            f"INSERT INTO standup_entries (id,org_id,project_id,author_id,date,done,plan,blockers,"
            f"plan_story_ids,created_at,updated_at) VALUES "
            f"('{eid}','{ORG}','{PROJ}','{AUTHOR_MEMBER}','{the_date.isoformat()}','done-{label}','plan-{label}',NULL,"
            f"'{{}}','{created_at.isoformat()}','{created_at.isoformat()}')"
        ))
        await s.execute(text(
            f"INSERT INTO standup_entry_projects (id,org_id,entry_id,project_id) VALUES "
            f"(gen_random_uuid(),'{ORG}','{eid}','{PROJ}')"
        ))
    await s.commit()


def _frozen_now(tz=None):
    assert tz == timezone.utc
    return _FROZEN_UTC


@pytest.mark.anyio
async def test_days_one_excludes_utc_today_when_org_timezone_set_realdb():
    """AC 경계 표본 — org.timezone='Asia/Seoul'이면 days=1의 경계가 09-08(seoul-today)
    이라 UTC-오늘(09-07, org 입장에선 "어제") 표본이 창 밖으로 빠진다 — days=1 필터가
    `>=`(이상)라 09-07 표본이 «빠지는지»가 09-08 표본이 «들어오는지»보다 더 강한 증거
    (09-08은 어느 경계든 항상 포함되므로 discriminator는 09-07의 배제 여부)."""
    from app.routers.standups import list_standup_history
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, org_timezone="Asia/Seoul")

        with patch("app.services.org_time.datetime") as mock_dt:
            mock_dt.now.side_effect = _frozen_now
            async with Session() as s:
                repo = StandupEntryRepository(s, ORG)
                page = await list_standup_history(project_id=PROJ, limit=30, cursor=None, days=1, repo=repo, auth=_auth())
        dates = {e.date.isoformat() for e in page["data"]}
        assert dates == {_SEOUL_TODAY.isoformat()}, "09-07(utc-today)은 org 입장에서 어제라 빠져야 한다"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_days_one_includes_utc_today_when_org_timezone_unset_realdb():
    """⭐뮤테이션 표적2 — org.timezone=NULL(미설정)이면 경계가 UTC 그대로 09-07(3665
    동작 보존, 회귀 0)이라 09-07 표본이 포함된다(days=1의 `>=` 특성상 09-08도 같이
    걸리는 건 정상 — 여기서 보는 건 "09-07이 빠지지 않는다"는 사실 그 자체).
    standups.py의 org_today(org_timezone) 호출을 org_today("Asia/Seoul")로 하드코딩
    하는 뮤테이션을 주면 09-07이 사라져 이 테스트가 RED."""
    from app.routers.standups import list_standup_history
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, org_timezone=None)

        with patch("app.services.org_time.datetime") as mock_dt:
            mock_dt.now.side_effect = _frozen_now
            async with Session() as s:
                repo = StandupEntryRepository(s, ORG)
                page = await list_standup_history(project_id=PROJ, limit=30, cursor=None, days=1, repo=repo, auth=_auth())
        dates = {e.date.isoformat() for e in page["data"]}
        assert _UTC_TODAY.isoformat() in dates
    finally:
        await eng.dispose()
