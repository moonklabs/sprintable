"""story #2412 AC1/AC4 — StandupEntryRepository.list()에 order_by가 없었다(limit만 적용).

"최근"을 요구하는 화면(FE `/api/standup` → GET /api/v2/standups → list_standups →
repo.list(), routers/standups.py:181)이 결정적 순서 보장 없이 나갔다 — #2248이
`/standups/history`(별도 엔드포인트, raw 쿼리로 우회)만 고치고 repo.list() 자체는
"공유 범용 메서드라 손 안 댄다"고 명시적으로 남겨둔 자리(그 주석 참조, routers/standups.py).

repo.list() 실호출처는 코드베이스 전체에 routers/standups.py:181(list_standups) 1곳뿐(grep
확認, routers/sprints.py는 get_missing()만 사용) — 그 1곳을 고치면 FE 화면 + MCP
get_standup/list_standup_entries 도구까지 전부 같이 고쳐진다.

positive control(AC4, 실제로 이 테스트 개발 중 수행): repositories/standup.py::list()의
order_by(...) 줄을 지우고 이 파일을 돌리면 test_list_returns_entries_ordered_by_date_desc가
빨간불로 돌아간다(다중 project 랜덤 insert 순서 때문에 결정적으로 재현) — order_by가 실제로
결과를 만드는 코드임을 확認했다.
"""
from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2412000-0000-0000-0000-000000000010")
PROJ = uuid.UUID("d2412000-0000-0000-0000-000000000011")
VIEWER_USER = uuid.UUID("d2412000-0000-0000-0000-000000000013")
VIEWER_MEMBER = uuid.UUID("d2412000-0000-0000-0000-000000000014")


@pytest.fixture
def anyio_backend():
    return "asyncio"


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
        f"DELETE FROM users WHERE id='{VIEWER_USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_viewer_access(s) -> None:
    """list_standups(routers/standups.py)의 has_project_access 게이트를 통과시키기 위한
    최소 seed(test_2248과 동형)."""
    await s.execute(text(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{VIEWER_USER}','d2412@d2412.test','x','D2412',true,true,0,false,0)"
    ))
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{VIEWER_MEMBER}','{ORG}','{VIEWER_USER}','human','D2412',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,role,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{VIEWER_MEMBER}','member','granted')"
    ))


async def _seed_entry(s, *, author_id: uuid.UUID, the_date: date, created_at: datetime) -> uuid.UUID:
    eid = uuid.uuid4()
    await s.execute(text(
        f"INSERT INTO standup_entries (id,org_id,project_id,author_id,date,done,plan,blockers,"
        f"plan_story_ids,created_at,updated_at) VALUES "
        f"('{eid}','{ORG}','{PROJ}','{author_id}','{the_date.isoformat()}','done','plan',NULL,"
        f"'{{}}','{created_at.isoformat()}','{created_at.isoformat()}')"
    ))
    await s.execute(text(
        f"INSERT INTO standup_entry_projects (id,org_id,entry_id,project_id) VALUES "
        f"(gen_random_uuid(),'{ORG}','{eid}','{PROJ}')"
    ))
    return eid


@pytest.mark.anyio
async def test_list_returns_entries_ordered_by_date_desc_realdb():
    """AC1/AC4 본체 — 여러 날짜에 걸쳐 삽입 순서를 뒤섞어도(가장 오래된 것을 먼저 넣음) 반환은
    date 내림차순이어야 한다. 스토리 repro(142건 중 2026-07-01 최신 건이 맨 앞이 아님)를
    작은 스케일로 재현."""
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _clean(s)
            await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2412-org','free')"))
            await s.execute(text(f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P2412')"))

            base = datetime(2026, 6, 1, tzinfo=timezone.utc)
            # 의도적으로 날짜 오름차순(가장 오래된 것부터)으로 삽입 — order_by 없으면 삽입/PK
            # 순서에 의존하는 우연한 정렬이 나올 수 있어, 그 우연을 배제하려 정반대로 넣는다.
            dates = [base.date() + timedelta(days=i) for i in range(5)]  # [06-01 .. 06-05]
            oldest_first_ids = []
            for i, d in enumerate(dates):
                eid = await _seed_entry(s, author_id=uuid.uuid4(), the_date=d, created_at=base + timedelta(seconds=i))
                oldest_first_ids.append(eid)
            await s.commit()

            repo = StandupEntryRepository(s, ORG)
            result = await repo.list(project_id=PROJ)

        got_ids = [e.id for e in result]
        assert got_ids == list(reversed(oldest_first_ids)), (
            "date 내림차순(최신이 맨 앞)이어야 한다 — repo.list()에 order_by가 없으면 "
            "삽입 순서 그대로(오래된 게 맨 앞) 나온다."
        )
        assert [e.date for e in result] == sorted(dates, reverse=True)
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_list_same_date_tiebreaks_by_created_at_desc_realdb():
    """같은 date(서로 다른 author, org-level 다건 제출 상황)일 때 created_at 내림차순으로
    동석차 tiebreak — 순서가 매 실행 랜덤이 아니라 결정적이어야 한다."""
    from app.repositories.standup import StandupEntryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _clean(s)
            await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2412-org','free')"))
            await s.execute(text(f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P2412')"))

            same_date = date(2026, 6, 10)
            base = datetime(2026, 6, 10, 9, 0, tzinfo=timezone.utc)
            # created_at 오름차순(먼저 제출한 사람 순)으로 삽입 — 기대 결과는 그 역순.
            earliest_first_ids = []
            for i in range(3):
                eid = await _seed_entry(s, author_id=uuid.uuid4(), the_date=same_date, created_at=base + timedelta(minutes=i))
                earliest_first_ids.append(eid)
            await s.commit()

            repo = StandupEntryRepository(s, ORG)
            result = await repo.list(project_id=PROJ)

        assert [e.id for e in result] == list(reversed(earliest_first_ids)), (
            "같은 date면 created_at 내림차순(가장 최근 제출이 먼저)이어야 한다."
        )
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_list_standups_router_uses_ordered_repo_list_realdb():
    """AC1 — 실제 소비처(routers/standups.py:181, list_standups = FE `/api/standup` 화면
    데이터 경로)를 통해서도 동일하게 정렬돼 나온다."""
    from app.routers.standups import list_standups
    from app.repositories.standup import StandupEntryRepository
    from app.dependencies.auth import AuthContext

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _clean(s)
            await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2412-org','free')"))
            await s.execute(text(f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P2412')"))
            await _seed_viewer_access(s)

            base = datetime(2026, 6, 1, tzinfo=timezone.utc)
            dates = [base.date() + timedelta(days=i) for i in range(4)]
            oldest_first_ids = []
            for i, d in enumerate(dates):
                eid = await _seed_entry(s, author_id=uuid.uuid4(), the_date=d, created_at=base + timedelta(seconds=i))
                oldest_first_ids.append(eid)
            await s.commit()

        async with Session() as s:
            repo = StandupEntryRepository(s, ORG)
            auth = AuthContext(
                user_id=str(VIEWER_USER), email=None,
                claims={"app_metadata": {"org_id": str(ORG)}}, org_id=str(ORG),
            )
            entries = await list_standups(project_id=PROJ, author_id=None, sprint_id=None, date_filter=None, repo=repo, auth=auth)

        assert [e.id for e in entries] == list(reversed(oldest_first_ids)), (
            "화면 데이터 경로(list_standups)도 최신 date가 맨 앞이어야 한다(AC1 본체)."
        )
    finally:
        await eng.dispose()
