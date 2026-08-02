"""story #2248 — GET /api/v2/standups/history의 웹 FE 소비자는 사실 이 함수가 아니라
list_standups(별도, ㉠ 페이지네이션 개념 자체 없음)를 부르고 있었다(FE 프록시 경로 결함,
`/api/v2/standups` → `/api/v2/standups/history` 정정). list_standup_history 자체는 이미
#2231 정본 규약A(limit+1 오버페치 + has_more/next_cursor body meta) + created_at DESC
정렬(안정적 순서)이 적용돼 있다 — 이 테스트는 그것을 realdb로 검증한다(#2231 AC3 책임).
MCP 도구(sprintable_mcp/tools/standup.py::standup_history)도 이 함수를 쓰므로 회귀 확認 겸함.
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

ORG = uuid.UUID("d2248000-0000-0000-0000-000000000010")
PROJ = uuid.UUID("d2248000-0000-0000-0000-000000000011")
AUTHOR_USER = uuid.UUID("d2248000-0000-0000-0000-000000000013")
AUTHOR_MEMBER = uuid.UUID("d2248000-0000-0000-0000-000000000014")


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


async def _seed(s, n: int) -> list[uuid.UUID]:
    await _clean(s)
    await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2248-org','free')"))
    await s.execute(text(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{AUTHOR_USER}','d2248@d2248.test','x','D2248',true,true,0,false,0)"
    ))
    await s.execute(text(f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P2248')"))
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{AUTHOR_MEMBER}','{ORG}','{AUTHOR_USER}','human','D2248',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,role,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{AUTHOR_MEMBER}','member','granted')"
    ))
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ids = []
    for i in range(n):
        eid = uuid.uuid4()
        ids.append(eid)
        created_at = base + timedelta(seconds=i)
        the_date = (base + timedelta(days=i)).date().isoformat()
        await s.execute(text(
            f"INSERT INTO standup_entries (id,org_id,project_id,author_id,date,done,plan,blockers,"
            f"plan_story_ids,created_at,updated_at) VALUES "
            f"('{eid}','{ORG}','{PROJ}','{AUTHOR_MEMBER}','{the_date}','done-{i}','plan-{i}',NULL,"
            f"'{{}}','{created_at.isoformat()}','{created_at.isoformat()}')"
        ))
        await s.execute(text(
            f"INSERT INTO standup_entry_projects (id,org_id,entry_id,project_id) VALUES "
            f"(gen_random_uuid(),'{ORG}','{eid}','{PROJ}')"
        ))
    await s.commit()
    return list(reversed(ids))  # newest-first, matches server ORDER BY created_at DESC


@pytest.mark.anyio
async def test_second_page_returns_different_rows_realdb():
    from app.routers.standups import list_standup_history
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            newest_first = await _seed(s, n=5)

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            page1 = await list_standup_history(project_id=PROJ, limit=2, cursor=None, days=None, repo=repo, auth=_auth())
        assert [e.id for e in page1["data"]] == newest_first[0:2]
        assert page1["meta"]["has_more"] is True

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            page2 = await list_standup_history(
                project_id=PROJ, limit=2, cursor=page1["meta"]["next_cursor"], days=None, repo=repo, auth=_auth(),
            )
        page2_ids = [e.id for e in page2["data"]]
        assert page2_ids == newest_first[2:4], "page2가 page1과 다른 행을 반환해야 한다(#2231 AC3 본체)"
        assert not (set(page2_ids) & {e.id for e in page1["data"]})

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            page3 = await list_standup_history(
                project_id=PROJ, limit=2, cursor=page2["meta"]["next_cursor"], days=None, repo=repo, auth=_auth(),
            )
        assert [e.id for e in page3["data"]] == newest_first[4:5]
        assert page3["meta"]["has_more"] is False
        assert page3["meta"]["next_cursor"] is None
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_no_cursor_under_limit_has_more_false_realdb():
    from app.routers.standups import list_standup_history
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=3)

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            page = await list_standup_history(project_id=PROJ, limit=20, cursor=None, days=None, repo=repo, auth=_auth())
        assert [e.id for e in page["data"]] == seeded
        assert page["meta"]["has_more"] is False
        assert page["meta"]["next_cursor"] is None
    finally:
        await eng.dispose()


class _FakeQuerySentinel:
    """#2540 CI 재현(오르테가군) — FastAPI Query(...) 객체처럼 str이 아니면서 truthy인 것을
    흉내낸다."""
    default = None


@pytest.mark.anyio
async def test_non_string_truthy_cursor_treated_as_no_cursor_not_crash_realdb():
    from app.routers.standups import list_standup_history
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=3)

        fake_sentinel = _FakeQuerySentinel()
        assert bool(fake_sentinel) is True

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            page = await list_standup_history(project_id=PROJ, limit=20, cursor=fake_sentinel, days=None, repo=repo, auth=_auth())
        assert [e.id for e in page["data"]] == seeded, "커서 없음으로 취급돼 전체가 나와야 한다(크래시 아님)"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_invalid_cursor_format_400_realdb():
    from app.routers.standups import list_standup_history
    from app.repositories.standup import StandupEntryRepository
    from fastapi import HTTPException

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, n=1)

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            with pytest.raises(HTTPException) as ei:
                await list_standup_history(project_id=PROJ, limit=20, cursor="not-a-date", days=None, repo=repo, auth=_auth())
            assert ei.value.status_code == 400
    finally:
        await eng.dispose()
