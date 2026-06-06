"""E-STANDUP 51447ca0: projection read — GET ?project_id= 를 standup_entry_projects link join.

- org-level 엔트리(project_id NULL)가 링크된 프로젝트 뷰에 surface, 미링크 프로젝트엔 미surface.
- legacy 엔트리(project_id 보유 + 링크)도 surface(0099 백필 링크·무회귀·CP1).
- get_missing: 링크된 org 엔트리 제출자는 missing 제외.
- feedback projection: 엔트리 링크 기준.
"""
from __future__ import annotations

import os
import uuid
from datetime import date as _date

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


_RAW = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.mark.anyio
@pytest.mark.skipif(not _ASYNC, reason="real-DB URL 미설정 — skip")
async def test_projection_link_join_realdb():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.repositories.standup import StandupEntryRepository

    org = uuid.uuid4()
    p1, p2, p3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    a_org = uuid.uuid4()       # org-level 작성자(canonical member id)
    a_leg = uuid.uuid4()       # legacy 작성자
    e_org, e_leg = uuid.uuid4(), uuid.uuid4()
    d = _date(2026, 6, 6)
    eng = create_async_engine(_ASYNC)
    sm = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with sm() as s:
            for pid in (p1, p2, p3):
                await s.execute(text("INSERT INTO projects (id,org_id,name,created_at) VALUES (:i,:o,'P',now())"),
                                {"i": pid, "o": org})
            # org-level 엔트리: project_id NULL, 링크 p1+p2
            await s.execute(text(
                "INSERT INTO standup_entries (id,org_id,project_id,author_id,date,plan_story_ids,created_at,updated_at)"
                " VALUES (:i,:o,NULL,:a,:d,ARRAY[]::uuid[],now(),now())"), {"i": e_org, "o": org, "a": a_org, "d": d})
            for pid in (p1, p2):
                await s.execute(text("INSERT INTO standup_entry_projects (id,entry_id,project_id,org_id) VALUES (gen_random_uuid(),:e,:p,:o)"),
                                {"e": e_org, "p": pid, "o": org})
            # legacy 엔트리: project_id=p1 보유 + 링크 p1(0099 백필 동형)
            await s.execute(text(
                "INSERT INTO standup_entries (id,org_id,project_id,author_id,date,plan_story_ids,created_at,updated_at)"
                " VALUES (:i,:o,:p,:a,:d,ARRAY[]::uuid[],now(),now())"), {"i": e_leg, "o": org, "p": p1, "a": a_leg, "d": d})
            await s.execute(text("INSERT INTO standup_entry_projects (id,entry_id,project_id,org_id) VALUES (gen_random_uuid(),:e,:p,:o)"),
                            {"e": e_leg, "p": p1, "o": org})
            # missing roster: a_org 를 owner org_member 로(roster 포함). submitted=링크된 엔트리.
            await s.execute(text("INSERT INTO org_members (id,org_id,user_id,role,created_at) VALUES (:i,:o,:u,'owner',now())"),
                            {"i": a_org, "o": org, "u": uuid.uuid4()})
            await s.commit()

            repo = StandupEntryRepository(s, org)
            # p1: org-level + legacy 둘 다
            ids_p1 = {e.id for e in await repo.list(project_id=p1, date=d)}
            assert ids_p1 == {e_org, e_leg}, f"p1 projection {ids_p1}"
            # p2: org-level 만(legacy는 p1만 링크)
            ids_p2 = {e.id for e in await repo.list(project_id=p2, date=d)}
            assert ids_p2 == {e_org}, f"p2 projection {ids_p2}"
            # p3: 링크 없음 → 빈
            ids_p3 = {e.id for e in await repo.list(project_id=p3, date=d)}
            assert ids_p3 == set(), f"p3 should be empty {ids_p3}"
            # project_id 없는 list = 전체(org scope)
            ids_all = {e.id for e in await repo.list(date=d)}
            assert {e_org, e_leg} <= ids_all

            # get_missing(p1): a_org 는 링크된 엔트리 제출 → missing 제외
            missing_p1 = await repo.get_missing(p1, d)
            assert a_org not in missing_p1, f"a_org should not be missing on p1: {missing_p1}"
            # get_missing(p3): a_org roster(owner org-wide)지만 p3 링크 엔트리 없음 → missing 포함
            missing_p3 = await repo.get_missing(p3, d)
            assert a_org in missing_p3, f"a_org should be missing on p3: {missing_p3}"
        async with sm() as s:
            await s.execute(text("DELETE FROM standup_entry_projects WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM standup_entries WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM org_members WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM projects WHERE org_id=:o"), {"o": org})
            await s.commit()
    finally:
        await eng.dispose()
