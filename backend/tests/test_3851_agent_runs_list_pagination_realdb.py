"""story #3851(customer-zero·BE·목록 상한) — GET /api/v2/agent-runs cursor 페이지네이션
realdb 검증. 미르코 3844 그라운딩 실측(2026-09-14 06:06Z) — 이 라우트가 body=순수 배열·
헤더 X-Total-Count/X-Next-Cursor 0이라 「반환 길이===limit이면 더 있을 수 있음」 보수
처리로만 FE가 partial을 짐작했다. 3841(standups)·goals.py·retros.py와 동일 헤더 계약을
이 라우트에도 이식(바디 봉투는 무변 — 순수 배열 그대로).

세팅은 test_agent_runs_story_id_filter_realdb.py의 `_session_factory`/`_client_for`/
`_setup_app` 재사용(중복 재발명 금지, 이 파일 관례와 동형) — 시드만 이 스토리 전용
(limit+1 다건·명시 created_at 스태거)으로 새로 짠다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import pytest

from tests.test_agent_runs_story_id_filter_realdb import (
    _client_for,
    _session_factory,
    _setup_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _seed_runs(session, *, run_count: int, other_org_run_count: int = 0):
    """caller org에 project 1개·agent 1개·run `run_count`건(created_at을 1초씩 벌려
    최신순 정렬이 결정적이도록 명시 스태거) — story_id 필터 테스트와 달리 이 스토리는
    순수 개수·커서 이어짐만 본다. other_org_run_count>0이면 별개 org에 그만큼 run을
    더 심어 org 격리(다른 org 수가 caller org의 X-Total-Count에 안 섞임)를 같이 잰다."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from sqlalchemy import text

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id,
        permission="granted", role="member",
    ))
    await session.commit()

    _ins = text(
        "INSERT INTO agent_runs (id, org_id, project_id, agent_id, trigger, status, created_at) "
        "VALUES (:id, :org_id, :project_id, :agent_id, 'manual', 'completed', :created_at)"
    )
    base = datetime.now(timezone.utc)
    run_ids: list[uuid.UUID] = []
    for i in range(run_count):
        rid = uuid.uuid4()
        run_ids.append(rid)
        # i=0이 가장 최근(created_at DESC 정렬의 1페이지 첫 항목) — base에서 i초씩 과거로.
        await session.execute(_ins, {
            "id": rid, "org_id": org.id, "project_id": project.id, "agent_id": agent.id,
            "created_at": base - timedelta(seconds=i),
        })
    await session.commit()

    if other_org_run_count:
        other_org = Organization(id=uuid.uuid4(), name="OtherOrg", slug=f"org-{uuid.uuid4().hex[:8]}")
        session.add(other_org)
        await session.commit()
        other_project = Project(id=uuid.uuid4(), org_id=other_org.id, name="Other Project")
        session.add(other_project)
        await session.commit()
        other_agent = Member(id=uuid.uuid4(), org_id=other_org.id, type="agent", name="Other Agent")
        session.add(other_agent)
        await session.commit()
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=other_project.id, member_id=other_agent.id,
            permission="granted", role="member",
        ))
        await session.commit()
        for i in range(other_org_run_count):
            await session.execute(_ins, {
                "id": uuid.uuid4(), "org_id": other_org.id, "project_id": other_project.id,
                "agent_id": other_agent.id, "created_at": base - timedelta(seconds=i),
            })
        await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "caller_id": caller_id,
        "run_ids_newest_first": run_ids,
    }


@pytest.mark.anyio
async def test_first_page_limit_and_next_cursor():
    """limit+1 시드(3건, limit=2) — 첫 페이지가 정확히 limit개·최신순·X-Total-Count=3
    (cursor 前 grand total, 아직 cursor 자체가 없으니 전체와 같음)·X-Next-Cursor 有."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_runs(s, run_count=3)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs?project_id={seeded['project_id']}&limit=2")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert isinstance(body, list), "바디는 그대로 순수 배열이어야 한다(봉투 변경 0)"
            assert len(body) == 2
            assert [r["id"] for r in body] == [str(seeded["run_ids_newest_first"][0]), str(seeded["run_ids_newest_first"][1])]
            assert resp.headers.get("X-Total-Count") == "3"
            next_cursor = resp.headers.get("X-Next-Cursor")
            assert next_cursor, "다음 페이지가 있는데 X-Next-Cursor가 없다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_second_page_continues_with_cursor():
    """1페이지 X-Next-Cursor로 2페이지를 부르면 남은 1건만(전체 3건 중 나머지)·X-Total-Count
    는 그 cursor 適用 後 남은 개수(=1, base.py 관례). goals.py/docs.py와 동일 관례(entries
    有면 마지막 페이지라도 X-Next-Cursor를 그대로 싣는다 — 호출부는 X-Total-Count 대비 누적
    수신량으로 "더 있나"를 판단, cursor 부재로 판단하지 않는다) — 그래서 여기선 부재를
    안 잰다(양성대조는 X-Total-Count=1이 이미 "더 없음"을 말한다)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_runs(s, run_count=3)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp1 = await client.get(f"/api/v2/agent-runs?project_id={seeded['project_id']}&limit=2")
            cursor = resp1.headers["X-Next-Cursor"]

            # cursor는 ISO 8601(+00:00 포함)이라 URL 인코딩 없이 이어붙이면 "+"가 쿼리
            # 파서에 공백으로 읽혀 400이 난다(FE loadmore.test.tsx의 동일 함정과 동형).
            resp2 = await client.get(
                f"/api/v2/agent-runs?project_id={seeded['project_id']}&limit=2&cursor={quote(cursor)}"
            )
            assert resp2.status_code == 200, resp2.text
            body2 = resp2.json()
            assert len(body2) == 1
            assert body2[0]["id"] == str(seeded["run_ids_newest_first"][2])
            assert resp2.headers.get("X-Total-Count") == "1"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_isolation_total_count_excludes_other_org():
    """caller org에 3건·다른 org에 5건을 심어도 X-Total-Count는 caller org 3건만(다른
    org 행이 섞여 새면 8이 된다 — has_project_access 가드가 이미 project_id 자체를 막지만,
    total count 계산 경로가 그 가드를 우회해 별도로 새는 회귀 클래스를 이 축이 잡는다)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_runs(s, run_count=3, other_org_run_count=5)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs?project_id={seeded['project_id']}&limit=50")
            assert resp.status_code == 200, resp.text
            assert len(resp.json()) == 3
            assert resp.headers.get("X-Total-Count") == "3"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_dropping_limit_clause_returns_oversized_page():
    """뮤테이션 표적 — repo.list()가 limit을 안 걸면(옛 「전부 반환」 사각 재현) 3건 시드+
    limit=2 요청에 3건이 그대로 돌아온다. 이 assert가 지금 GREEN이라는 것 자체가 limit이
    실제로 쿼리에 반영되고 있다는 증거(mutation self-check)."""
    import app.repositories.agent_run as repo_mod
    from sqlalchemy import select
    from app.models.agent_run import AgentRun

    original_list = repo_mod.AgentRunRepository.list

    async def _list_ignoring_limit(self, project_id, agent_id=None, story_id=None,
                                    status=None, from_dt=None, to_dt=None, limit=50, cursor=None):
        q = select(AgentRun).where(AgentRun.project_id == project_id).order_by(AgentRun.created_at.desc())
        result = await self.session.execute(q)
        runs = list(result.scalars().all())
        return runs, len(runs)

    repo_mod.AgentRunRepository.list = _list_ignoring_limit
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_runs(s, run_count=3)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs?project_id={seeded['project_id']}&limit=2")
            assert resp.status_code == 200, resp.text
            assert len(resp.json()) == 3, "뮤테이션이 걸리지 않았다(limit이 여전히 실제로 2로 자르고 있다)"
        finally:
            await client.aclose()
    finally:
        repo_mod.AgentRunRepository.list = original_list
        app.dependency_overrides.clear()
        await engine.dispose()
