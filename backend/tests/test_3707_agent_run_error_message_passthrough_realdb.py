"""story #3707 — `agent_runs.error_message` 쓰기/읽기 계약 누락, 실 PG.

원인: `AgentRun` 모델·리퍼(`agent_run_lifecycle.py` abandoned 전이)는 `error_message` 컬럼을
직접 쓰지만, 공개 API 스키마(`CreateAgentRun`/`UpdateAgentRun`/`AgentRunResponse`)엔 그 필드가
아예 없었다. MCP `emit_event`/`update_run_status`가 요청 바디에 `error_message`를 실어 보내도
Pydantic이 스키마에 없는 필드를 기본(extra=ignore)으로 조용히 버려 DB엔 한 번도 안 닿았다 —
dev 전 프로젝트에 「failed + error_message」 실행이 0건이던 근본(story #3677 라이브 표본 확보를
막던 자리).

수정: 세 스키마에 `error_message: str | None` 추가 — create_agent_run 라우터가 named-arg로
repo에 명시 전달, update_agent_run은 이미 exclude_unset 패스스루라 스키마 추가만으로 배선됨.
"""
from __future__ import annotations

import os
import uuid

import pytest

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    """org+project+caller(project 접근권 有)+agent(team_members 뷰 진입).

    [[reference_local_realdb_pg16_pgvector]] 함정2 — team_members는 VIEW라 TeamMember를
    직접 insert 못 함. Member(type="agent")+ProjectAccess로 뷰 원재료를 심는다.
    """
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent A")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    ))
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id, "caller_id": caller_id}


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _fetch_run_error_message_db(Session, run_id):
    from sqlalchemy import text
    async with Session() as s:
        row = (await s.execute(
            text("SELECT error_message FROM agent_runs WHERE id = :i"), {"i": run_id},
        )).one()
        return row[0]


@pytest.mark.anyio
async def test_create_with_error_message_persists_and_is_readable_write_then_read_roundtrip():
    """AC1+AC2 핵심 — POST(status=failed+error_message) → DB에 실제로 닿는지 → GET 응답에
    실리는지, write→read 왕복 전체를 pin. 스키마에서 error_message를 도로 빼면(mutation-kill)
    이 테스트가 정확히 이 자리서 RED(POST 바디가 조용히 버려짐)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            msg = "[스모크·3677] 의도된 실패 표본"
            resp = await client.post(
                "/api/v2/agent-runs",
                json={
                    "agent_id": str(seeded["agent_id"]),
                    "project_id": str(seeded["project_id"]),
                    "status": "failed",
                    "error_message": msg,
                },
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            # AC2 — 응답(AgentRunResponse)에 그대로 실려야 화면(실행 상세)이 볼 수 있다.
            assert body["error_message"] == msg, f"POST 응답에 error_message가 안 실림(회귀): {body}"

            run_id = body["id"]
            # AC1 — DB에 실제로 닿았는지(응답 echo가 아니라 진짜 저장인지 구분).
            db_value = await _fetch_run_error_message_db(Session, run_id)
            assert db_value == msg, f"DB엔 안 닿음(응답만 echo, 회귀): {db_value!r}"

            # GET 단건도 동일 값을 보여줘야 실행 상세 화면이 재방문 시에도 본다.
            get_resp = await client.get(f"/api/v2/agent-runs/{run_id}")
            assert get_resp.status_code == 200, get_resp.text
            assert get_resp.json()["error_message"] == msg
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_error_message_persists_and_readable():
    """AC1+AC2 — PATCH(status=failed+error_message)도 동형인지(MCP update_run_status가 부르는
    실 경로 — story 대부분의 실 실패 보고는 running으로 생성 후 이 PATCH로 failed 전이)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post(
                "/api/v2/agent-runs",
                json={"agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"])},
            )
            assert create_resp.status_code == 201, create_resp.text
            run_id = create_resp.json()["id"]

            msg = "[스모크·3677] 의도된 실패 표본(PATCH)"
            patch_resp = await client.patch(
                f"/api/v2/agent-runs/{run_id}",
                json={"status": "failed", "error_message": msg},
            )
            assert patch_resp.status_code == 200, patch_resp.text
            assert patch_resp.json()["error_message"] == msg, "PATCH 응답에 error_message가 안 실림(회귀)"

            db_value = await _fetch_run_error_message_db(Session, run_id)
            assert db_value == msg, f"DB엔 안 닿음(회귀): {db_value!r}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
