"""story #4179(E-PROD-ESC·BE+FE) — 실 PG.

free_response(#2603 멘션 전용 라우팅의 방 단위 예외)가 PATCH 응답에만 있고 단건·목록 GET엔
없어, 웹 토글이 새로 열 때마다 off로 읽혔다(그 상태로 저장하면 꺼짐). 두 GET이 저장된 값을
그대로 돌려주는지 고정 — 켠 방은 True, 기본 방은 False(둘 다 실어야 FE 폴백에 기대지 않는다).
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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _override(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
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
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _seed(session):
    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    members = []
    for name in ("Me", "Other"):
        uid = uuid.uuid4()
        session.add(User(id=uid, email=f"{name}-{uid.hex[:8]}@test.com", hashed_password="x"))
        await session.commit()
        m = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=uid, name=name)
        session.add(m)
        await session.commit()
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project.id, member_id=m.id, permission="granted", role="member",
        ))
        await session.commit()
        members.append((uid, m))
    (me_uid, me), (_, other) = members

    convs = {}
    for key, free in (("on", True), ("off", False)):
        conv = Conversation(
            id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group",
            title=f"room-{key}", created_by=me.id, free_response=free,
        )
        session.add(conv)
        await session.flush()
        for pid in (me.id, other.id):
            session.add(ConversationParticipant(conversation_id=conv.id, member_id=pid))
        await session.commit()
        convs[key] = conv.id

    return {"org_id": org.id, "project_id": project.id, "me_user_id": me_uid, "convs": convs}


@pytest.mark.anyio
async def test_single_and_list_get_return_stored_free_response():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        _override(app, Session, seeded["me_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            on = await client.get(f"/api/v2/conversations/{seeded['convs']['on']}")
            off = await client.get(f"/api/v2/conversations/{seeded['convs']['off']}")
            listed = await client.get("/api/v2/conversations", params={"project_id": str(seeded["project_id"])})
        finally:
            app.dependency_overrides.clear()

        assert on.status_code == 200, on.text
        assert off.status_code == 200, off.text
        assert on.json()["free_response"] is True
        assert off.json()["free_response"] is False

        assert listed.status_code == 200, listed.text
        rows = {r["id"]: r for r in listed.json()["data"]}
        assert rows[str(seeded["convs"]["on"])]["free_response"] is True
        assert rows[str(seeded["convs"]["off"])]["free_response"] is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_patch_then_get_round_trips_free_response():
    """AC2의 BE 절반 — 켜기(PATCH) 뒤 새로 읽기(GET)가 켜진 값을 돌려준다(새로고침 시나리오)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        conv_id = seeded["convs"]["off"]
        _override(app, Session, seeded["me_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            patched = await client.patch(f"/api/v2/conversations/{conv_id}", json={"free_response": True})
            reread = await client.get(f"/api/v2/conversations/{conv_id}")
        finally:
            app.dependency_overrides.clear()

        assert patched.status_code == 200, patched.text
        assert reread.status_code == 200, reread.text
        assert reread.json()["free_response"] is True
    finally:
        await engine.dispose()
