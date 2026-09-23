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


# ── PO CHANGES ①(보안·IDOR) — 사람 세션 400·403 갈래를 게이트 함수로 직접 핀 ──────────────

async def _seed_org_with_two_humans(session):
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    out = {"org_id": org.id}
    for key in ("me", "other"):
        uid = uuid.uuid4()
        session.add(User(id=uid, email=f"{key}-{uid.hex[:8]}@test.com", hashed_password="x"))
        await session.commit()
        om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=uid, role="member")
        session.add(om)
        await session.commit()
        out[f"{key}_user_id"] = uid
        out[f"{key}_om_id"] = om.id
    return out


@pytest.mark.anyio
async def test_human_stream_gate_requires_member_id_400():
    from fastapi import HTTPException

    from app.routers.events import _resolve_stream_member

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_two_humans(s)
        me = _human_auth(seeded["me_user_id"], seeded["org_id"])
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await _resolve_stream_member(me, None, seeded["org_id"], s)
        assert exc.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_stream_gate_rejects_other_members_stream_403():
    """같은 org의 남의 org_member_id로는 구독 불가(IDOR) — 본인 것은 통과(양성대조)."""
    from fastapi import HTTPException

    from app.routers.events import _resolve_stream_member

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_with_two_humans(s)
        me = _human_auth(seeded["me_user_id"], seeded["org_id"])
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await _resolve_stream_member(me, seeded["other_om_id"], seeded["org_id"], s)
            assert exc.value.status_code == 403
            assert await _resolve_stream_member(me, seeded["me_om_id"], seeded["org_id"], s) == seeded["me_om_id"]
    finally:
        await engine.dispose()


# ── PO CHANGES ② — /auth/me와 /events/stream의 «현재 org» 규칙 통일 ─────────────────────

async def _seed_two_org_human(session):
    """사람 1명이 org A(JWT org)·org B 둘 다 가입, org C는 미가입."""
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User

    orgs = {}
    for key in ("a", "b", "c"):
        org = Organization(id=uuid.uuid4(), name=f"Org{key}", slug=f"org-{key}-{uuid.uuid4().hex[:8]}")
        session.add(org)
        await session.commit()
        orgs[key] = org.id
    uid = uuid.uuid4()
    session.add(User(id=uid, email=f"multi-{uid.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    oms = {}
    for key in ("a", "b"):
        om = OrgMember(id=uuid.uuid4(), org_id=orgs[key], user_id=uid, role="member")
        session.add(om)
        await session.commit()
        oms[key] = om.id
    return {"user_id": uid, "orgs": orgs, "oms": oms}


async def _auth_me(app, Session, auth_ctx, headers=None):
    _override(app, Session, auth_ctx)
    try:
        return await _client_for(app).get("/api/v2/auth/me", headers=headers or {})
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_auth_me_follows_x_org_id_header_like_the_stream():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_org_human(s)
        orgs, oms = seeded["orgs"], seeded["oms"]
        human = _human_auth(seeded["user_id"], orgs["a"])  # JWT org = A

        # 헤더 org B → 응답 org_id·org_member_id 둘 다 B(한 응답 안에서 org가 섞이지 않음).
        resp_b = await _auth_me(app, Session, human, {"X-Org-Id": str(orgs["b"])})
        assert resp_b.status_code == 200, resp_b.text
        body_b = resp_b.json().get("data", resp_b.json())
        assert body_b["org_id"] == str(orgs["b"])
        assert body_b["org_member_id"] == str(oms["b"])
        async with Session() as s:
            # 스트림(org B)이 그 값을 통과시킨다 · 옛 규칙의 값(org A 기준)은 org B 스트림에서 404.
            assert await _stream_gate_status(s, human, oms["b"], orgs["b"]) == 200
            assert await _stream_gate_status(s, human, oms["a"], orgs["b"]) == 404

        # 헤더 없음 → JWT org(A) 기준(기존 동작 무변).
        resp_a = await _auth_me(app, Session, human)
        body_a = resp_a.json().get("data", resp_a.json())
        assert body_a["org_id"] == str(orgs["a"])
        assert body_a["org_member_id"] == str(oms["a"])

        # 미가입 org C를 헤더로 → 스트림과 같은 판정(403).
        resp_c = await _auth_me(app, Session, human, {"X-Org-Id": str(orgs["c"])})
        assert resp_c.status_code == 403, resp_c.text
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_no_org_human_without_header_still_200():
    """«무 org여도 항상 200» 계약(test_3195가 mock으로 핀) — 실 PG·실 요청 경로로도 재확認."""
    from app.dependencies.auth import AuthContext
    from app.main import app

    engine, Session = await _session_factory()
    try:
        from app.models.user import User

        uid = uuid.uuid4()
        async with Session() as s:
            s.add(User(id=uid, email=f"noorg-{uid.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
        no_org = AuthContext(user_id=str(uid), email="n@test", claims={"app_metadata": {}})
        resp = await _auth_me(app, Session, no_org)
        assert resp.status_code == 200, resp.text
        body = resp.json().get("data", resp.json())
        assert body["org_id"] is None and body["org_member_id"] is None
    finally:
        await engine.dispose()
