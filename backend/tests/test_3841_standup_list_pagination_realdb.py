"""story #3841(customer-zero·BE·목록 상한, 페드루 PO 確定 2026-09-14) — `GET /api/v2/standups`
(list_standups)이 그동안 limit/cursor 파라미터 없이 repo.list()의 하드코딩 1000-cap을
그대로 받아 "상한 없이 전부"(1000건 넘으면 조용히 잘림, has_more 신호 0)였던 것을
목표(goals.py)·문서(docs.py)와 같은 true cursor 페이지네이션(X-Total-Count·X-Next-Cursor
헤더, 바디는 기존 bare list 그대로 — 기존 소비처 회귀 0)으로 처방.

핵심 검증축: ①limit+1 시드 시 첫 페이지=limit·X-Total-Count>len(page)·cursor로 2페이지
이어짐(중복/누락 0) ②org 격리(타org 행이 count/페이지에 안 샘) ③limit 미지정 시 옛 관례
(1000 이하는 전량 반환)와 바이트 호환.
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

ORG = uuid.UUID("d3841000-0000-0000-0000-000000000010")
PROJ = uuid.UUID("d3841000-0000-0000-0000-000000000011")
AUTHOR_USER = uuid.UUID("d3841000-0000-0000-0000-000000000013")
AUTHOR_MEMBER = uuid.UUID("d3841000-0000-0000-0000-000000000014")

OTHER_ORG = uuid.UUID("d3841000-0000-0000-0000-000000000020")
OTHER_PROJ = uuid.UUID("d3841000-0000-0000-0000-000000000021")
OTHER_USER = uuid.UUID("d3841000-0000-0000-0000-000000000023")
OTHER_MEMBER = uuid.UUID("d3841000-0000-0000-0000-000000000024")


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
        f"DELETE FROM standup_entry_projects WHERE project_id IN ('{PROJ}','{OTHER_PROJ}')",
        f"DELETE FROM standup_entries WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ}','{OTHER_PROJ}')",
        f"DELETE FROM members WHERE org_id IN ('{ORG}','{OTHER_ORG}')",
        f"DELETE FROM projects WHERE id IN ('{PROJ}','{OTHER_PROJ}')",
        f"DELETE FROM users WHERE id IN ('{AUTHOR_USER}','{OTHER_USER}')",
        f"DELETE FROM organizations WHERE id IN ('{ORG}','{OTHER_ORG}')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_org(s, org, proj, user, member, n: int, day0: datetime) -> list[uuid.UUID]:
    await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{org}','O','o{org.hex[-8:]}','free')"))
    await s.execute(text(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{user}','u{user.hex[-8:]}@d3841.test','x','U',true,true,0,false,0)"
    ))
    await s.execute(text(f"INSERT INTO projects (id,org_id,name) VALUES ('{proj}','{org}','P')"))
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{member}','{org}','{user}','human','M',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,role,permission) VALUES "
        f"(gen_random_uuid(),'{proj}','{member}','member','granted')"
    ))
    ids: list[uuid.UUID] = []
    for i in range(n):
        eid = uuid.uuid4()
        ids.append(eid)
        created_at = day0 + timedelta(seconds=i)
        the_date = (day0 + timedelta(days=i)).date().isoformat()
        await s.execute(text(
            f"INSERT INTO standup_entries (id,org_id,project_id,author_id,date,done,plan,blockers,"
            f"plan_story_ids,created_at,updated_at) VALUES "
            f"('{eid}','{org}','{proj}','{member}','{the_date}','done-{i}','plan-{i}',NULL,"
            f"'{{}}','{created_at.isoformat()}','{created_at.isoformat()}')"
        ))
        await s.execute(text(
            f"INSERT INTO standup_entry_projects (id,org_id,entry_id,project_id) VALUES "
            f"(gen_random_uuid(),'{org}','{eid}','{proj}')"
        ))
    await s.commit()
    return list(reversed(ids))  # newest-first(date DESC), matches server order.


@pytest.mark.anyio
async def test_limit_plus_one_seed_paginates_with_total_count_and_cursor_realdb():
    """AC2 — limit+1(=6) 행 시드 → 첫 페이지 5건·X-Total-Count>len(page)(has_more 신호)·
    cursor로 2페이지째가 나머지 1건(누락/중복 0)."""
    from fastapi import Response
    from app.routers.standups import list_standups
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _clean(s)
            newest_first = await _seed_org(
                s, ORG, PROJ, AUTHOR_USER, AUTHOR_MEMBER, n=6,
                day0=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            resp1 = Response()
            page1 = await list_standups(
                response=resp1, project_id=PROJ, author_id=None, sprint_id=None,
                date_filter=None, limit=5, cursor=None, repo=repo, auth=_auth(),
            )
        assert [e.id for e in page1] == newest_first[0:5]
        total = int(resp1.headers["X-Total-Count"])
        assert total > len(page1), "남은 전체(cursor 기준)가 한 페이지보다 많아야 has_more 신호가 선다"
        next_cursor = resp1.headers["X-Next-Cursor"]

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            resp2 = Response()
            page2 = await list_standups(
                response=resp2, project_id=PROJ, author_id=None, sprint_id=None,
                date_filter=None, limit=5, cursor=next_cursor, repo=repo, auth=_auth(),
            )
        page2_ids = [e.id for e in page2]
        assert page2_ids == newest_first[5:6]
        assert not (set(page2_ids) & {e.id for e in page1}), "페이지 간 중복 0"
        assert int(resp2.headers["X-Total-Count"]) == len(page2), "마지막 페이지는 남은 전체=이 페이지 크기"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_org_isolation_other_org_rows_excluded_from_count_and_page_realdb():
    """AC2 org 격리 — 타org 행이 X-Total-Count·페이지 어디에도 안 샌다."""
    from fastapi import Response
    from app.routers.standups import list_standups
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _clean(s)
            mine = await _seed_org(
                s, ORG, PROJ, AUTHOR_USER, AUTHOR_MEMBER, n=2,
                day0=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )
            await _seed_org(
                s, OTHER_ORG, OTHER_PROJ, OTHER_USER, OTHER_MEMBER, n=5,
                day0=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            resp = Response()
            page = await list_standups(
                response=resp, project_id=PROJ, author_id=None, sprint_id=None,
                date_filter=None, limit=20, cursor=None, repo=repo, auth=_auth(),
            )
        assert [e.id for e in page] == mine
        assert int(resp.headers["X-Total-Count"]) == 2, "타org 5건이 count에 안 섞여야 한다"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_default_limit_under_1000_matches_old_full_return_byte_compat_realdb():
    """AC1 — limit 미지정(기본값)·응답 건수가 옛 하드코딩 1000-cap 이하일 때 바디는 여전히
    bare list(기존 소비처 무변경, 봉투로 안 바뀜)."""
    from fastapi import Response
    from app.routers.standups import list_standups
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _clean(s)
            seeded = await _seed_org(
                s, ORG, PROJ, AUTHOR_USER, AUTHOR_MEMBER, n=3,
                day0=datetime(2026, 1, 1, tzinfo=timezone.utc),
            )

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            resp = Response()
            page = await list_standups(
                response=resp, project_id=PROJ, author_id=None, sprint_id=None,
                date_filter=None, limit=1000, cursor=None, repo=repo, auth=_auth(),
            )
        assert isinstance(page, list), "바디는 여전히 bare list(봉투 아님) — 기존 소비처 계약"
        assert [e.id for e in page] == seeded
    finally:
        await eng.dispose()
