"""story #4178(E-PROD-ESC·BE·계약) — 실 PG.

사람(JWT) 세션의 GET /api/v2/auth/me `member_id`는 users.id라, 그 값으로
/api/v2/events/stream(events.py:406-414 — resolve_member_identity + user_id 일치)에 붙으면
404가 난다. `member_id`의 의미는 바꾸지 않고(onboarding-form/verify-email이 기대는 계약,
test_3195_me_email_verified.py가 핀) additive `org_member_id`를 신설 — 이 파일은 그 값이
/events/stream의 신원 게이트를 실제로 통과한다는 것을 실 PG로 고정한다.
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


async def _seed(session, *, with_org_member: bool = True):
    from app.models.member import AgentProjectProfile, Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"human-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()

    om_id = None
    if with_org_member:
        om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="member")
        session.add(om)
        await session.commit()
        om_id = om.id

    # 에이전트가 team_members VIEW(members⋈agent_project_profiles)에 보이려면 프로젝트 프로필이 필요.
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=agent.id, project_id=project.id))
    await session.commit()

    return {"org_id": org.id, "user_id": user_id, "org_member_id": om_id, "agent_id": agent.id}


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _override(app, Session, auth_ctx):
    from app.dependencies.auth import get_current_user
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return auth_ctx

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="human@test",
        claims={"app_metadata": {"org_id": str(org_id)}}, org_id=str(org_id),
    )


async def _stream_gate_status(session, auth_ctx, member_id: uuid.UUID, org_id: uuid.UUID) -> int:
    """/events/stream 엔드포인트가 실제로 부르는 신원 게이트(events._resolve_stream_member)를
    그대로 호출 — 복제 아님(PO CHANGES). SSE 본문(무한 스트림)은 게이트 뒤라 여기서 멈춘다.
    200=통과, 그 외=게이트가 던진 HTTPException status."""
    from fastapi import HTTPException

    from app.routers.events import _resolve_stream_member

    try:
        resolved = await _resolve_stream_member(auth_ctx, member_id, org_id, session)
    except HTTPException as exc:
        return exc.status_code
    assert resolved == member_id
    return 200


@pytest.mark.anyio
async def test_human_session_org_member_id_passes_events_stream_gate_member_id_does_not():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        _override(app, Session, _human_auth(seeded["user_id"], seeded["org_id"]))
        try:
            resp = await _client_for(app).get("/api/v2/auth/me")
        finally:
            app.dependency_overrides.clear()
        assert resp.status_code == 200, resp.text
        body = resp.json()
        payload = body.get("data", body)

        assert payload["member_id"] == str(seeded["user_id"])  # 기존 계약 무변경
        assert payload["org_member_id"] == str(seeded["org_member_id"])

        human = _human_auth(seeded["user_id"], seeded["org_id"])
        async with Session() as s:
            # 버그 재현: 기존 member_id(users.id)로는 404.
            assert await _stream_gate_status(s, human, uuid.UUID(payload["member_id"]), seeded["org_id"]) == 404
            # 처방: 신설 org_member_id로는 통과.
            assert await _stream_gate_status(s, human, uuid.UUID(payload["org_member_id"]), seeded["org_id"]) == 200
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_session_without_org_member_row_returns_200_org_member_id_none():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, with_org_member=False)
        _override(app, Session, _human_auth(seeded["user_id"], seeded["org_id"]))
        try:
            resp = await _client_for(app).get("/api/v2/auth/me")
        finally:
            app.dependency_overrides.clear()
        assert resp.status_code == 200, resp.text
        payload = resp.json().get("data", resp.json())
        assert payload["org_member_id"] is None
        assert payload["member_id"] == str(seeded["user_id"])
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_api_key_session_unchanged_org_member_id_none():
    from app.dependencies.auth import AuthContext
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        agent_auth = AuthContext(
            user_id=str(seeded["agent_id"]), email=None,
            claims={"app_metadata": {"api_key_id": "key-1", "org_id": str(seeded["org_id"])}},
            org_id=str(seeded["org_id"]),
        )
        _override(app, Session, agent_auth)
        try:
            resp = await _client_for(app).get("/api/v2/auth/me")
        finally:
            app.dependency_overrides.clear()
        assert resp.status_code == 200, resp.text
        payload = resp.json().get("data", resp.json())
        assert payload["member_id"] == str(seeded["agent_id"])
        assert payload["org_member_id"] is None

        # 뽑아낸 게이트의 에이전트 경로 무회귀 — member_id 생략이면 키의 멤버로, 남의 id면 403.
        from fastapi import HTTPException

        from app.routers.events import _resolve_stream_member

        async with Session() as s:
            assert await _resolve_stream_member(agent_auth, None, seeded["org_id"], s) == seeded["agent_id"]
            with pytest.raises(HTTPException) as exc:
                await _resolve_stream_member(agent_auth, uuid.uuid4(), seeded["org_id"], s)
            assert exc.value.status_code == 403
    finally:
        await engine.dispose()
