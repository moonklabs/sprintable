"""story #2412 AC3 — MCP `standup_history` 도구가 존재하지도 않는 `days` 인자를 조용히
삼키던 것(AC2)의 후속: `days`를 실제 필드로 만들고 BE `/api/v2/standups/history`가 진짜로
그 기간으로 필터링하는지 확認. `date`(스탠드업 실제 날짜) 기준 — `created_at`(제출 시각)이
아니다: 늦게 제출된 옛날 날짜 스탠드업을 "최근"으로 잘못 포함시키지 않기 위해서다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2412d00-0000-0000-0000-000000000010")
PROJ = uuid.UUID("d2412d00-0000-0000-0000-000000000011")
AUTHOR_USER = uuid.UUID("d2412d00-0000-0000-0000-000000000013")
AUTHOR_MEMBER = uuid.UUID("d2412d00-0000-0000-0000-000000000014")


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


async def _seed(s) -> None:
    """오늘 기준 0/5/10/20일 전 4건 — days=7이면 앞의 둘(0·5일 전)만 남아야 한다."""
    await _clean(s)
    await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2412d-org','free')"))
    await s.execute(text(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{AUTHOR_USER}','d2412d@d2412d.test','x','D2412D',true,true,0,false,0)"
    ))
    await s.execute(text(f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P2412D')"))
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{AUTHOR_MEMBER}','{ORG}','{AUTHOR_USER}','human','D2412D',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,role,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{AUTHOR_MEMBER}','member','granted')"
    ))
    today = datetime.now(timezone.utc).date()
    for i, days_ago in enumerate([0, 5, 10, 20]):
        eid = uuid.uuid4()
        the_date = today - timedelta(days=days_ago)
        created_at = datetime(the_date.year, the_date.month, the_date.day, 9, 0, tzinfo=timezone.utc)
        await s.execute(text(
            f"INSERT INTO standup_entries (id,org_id,project_id,author_id,date,done,plan,blockers,"
            f"plan_story_ids,created_at,updated_at) VALUES "
            f"('{eid}','{ORG}','{PROJ}','{AUTHOR_MEMBER}','{the_date.isoformat()}','done-{i}','plan-{i}',NULL,"
            f"'{{}}','{created_at.isoformat()}','{created_at.isoformat()}')"
        ))
        await s.execute(text(
            f"INSERT INTO standup_entry_projects (id,org_id,entry_id,project_id) VALUES "
            f"(gen_random_uuid(),'{ORG}','{eid}','{PROJ}')"
        ))
    await s.commit()


@pytest.mark.anyio
async def test_days_filter_excludes_entries_older_than_window_realdb():
    from app.routers.standups import list_standup_history
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            page = await list_standup_history(project_id=PROJ, limit=30, cursor=None, days=7, repo=repo, auth=_auth())
        assert len(page["data"]) == 2, "days=7이면 0일전·5일전 2건만 — 10일전·20일전은 창 밖"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_no_days_param_returns_all_realdb():
    from app.routers.standups import list_standup_history
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            page = await list_standup_history(project_id=PROJ, limit=30, cursor=None, days=None, repo=repo, auth=_auth())
        assert len(page["data"]) == 4, "days 미지정 = 기존 동작(기간 필터 없음) 그대로 4건 전부"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_days_one_means_today_only_realdb():
    from app.routers.standups import list_standup_history
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            page = await list_standup_history(project_id=PROJ, limit=30, cursor=None, days=1, repo=repo, auth=_auth())
        assert len(page["data"]) == 1, "days=1은 오늘 하루만(0일전 1건) — 스토리 repro(days=14 vs days=1)와 반대증명"
    finally:
        await eng.dispose()
