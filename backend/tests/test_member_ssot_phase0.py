"""E-MEMBER-SSOT Phase 0: resolve_member + 인가 불변식 테스트."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.member_resolver import ResolvedMember, lookup_members_by_ids, resolve_member

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_TM_ID = uuid.uuid4()
ORG_MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_auth(user_id: uuid.UUID = USER_ID, is_api_key: bool = False) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    if is_api_key:
        ctx.claims = {"app_metadata": {"api_key_id": "ak_xxx", "org_id": str(ORG_ID)}}
    else:
        ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    return ctx


def _make_team_member(tid=AGENT_TM_ID, ttype="agent", org_id=ORG_ID):
    tm = MagicMock()
    tm.id = tid
    tm.user_id = None
    tm.name = "TestAgent"
    tm.type = ttype
    tm.role = "agent"
    tm.org_id = org_id
    tm.project_id = PROJECT_ID
    return tm


def _make_org_member(oid=ORG_MEMBER_ID, user_id=USER_ID, org_id=ORG_ID):
    om = MagicMock()
    om.id = oid
    om.user_id = user_id
    om.org_id = org_id
    om.role = "member"
    om.deleted_at = None
    return om


# ── API키 에이전트 경로 ───────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_resolve_member_api_key_returns_team_member_id():
    """API키 인증 → team_member.id 반환."""
    auth = _make_auth(is_api_key=True)
    tm = _make_team_member()

    session = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.first.return_value = tm
    session.execute = AsyncMock(return_value=result)

    resolved = await resolve_member(auth, ORG_ID, session)
    assert resolved.id == AGENT_TM_ID
    assert resolved.type == "agent"
    assert resolved.user_id is None


@pytest.mark.anyio
async def test_resolve_member_api_key_not_found_raises_400():
    """API키이지만 team_member 없음 → 400."""
    auth = _make_auth(is_api_key=True)

    session = AsyncMock()
    result = MagicMock()
    result.scalars.return_value.first.return_value = None
    session.execute = AsyncMock(return_value=result)

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        await resolve_member(auth, ORG_ID, session)
    assert exc_info.value.status_code == 400


# ── JWT 휴먼 경로 ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_resolve_member_jwt_returns_org_member_id():
    """JWT 인증 → org_member.id 반환."""
    auth = _make_auth()
    om = _make_org_member()

    session = AsyncMock()
    user_mock = MagicMock()
    user_mock.email = "user@test.com"
    om_result = MagicMock(); om_result.scalar_one_or_none.return_value = om
    user_result = MagicMock(); user_result.scalar_one_or_none.return_value = user_mock

    with patch("app.services.member_resolver.has_project_access", return_value=True):
        session.execute = AsyncMock(side_effect=[om_result, user_result])
        resolved = await resolve_member(auth, ORG_ID, session, project_id=PROJECT_ID)

    assert resolved.id == ORG_MEMBER_ID
    assert resolved.type == "human"
    assert resolved.user_id == USER_ID
    assert resolved.name == "user@test.com"


@pytest.mark.anyio
async def test_resolve_member_jwt_no_project_access_403():
    """JWT 유저가 project에 접근권 없음 → 403."""
    auth = _make_auth()

    session = AsyncMock()
    from fastapi import HTTPException
    with patch("app.services.member_resolver.has_project_access", return_value=False):
        with pytest.raises(HTTPException) as exc_info:
            await resolve_member(auth, ORG_ID, session, project_id=PROJECT_ID)
    assert exc_info.value.status_code == 403


@pytest.mark.anyio
async def test_resolve_member_jwt_no_org_member_400():
    """JWT 유저가 org_member에 없음 → 400."""
    auth = _make_auth()

    session = AsyncMock()
    om_result = MagicMock(); om_result.scalar_one_or_none.return_value = None

    from fastapi import HTTPException
    with patch("app.services.member_resolver.has_project_access", return_value=True):
        session.execute = AsyncMock(return_value=om_result)
        with pytest.raises(HTTPException) as exc_info:
            await resolve_member(auth, ORG_ID, session, project_id=PROJECT_ID)
    assert exc_info.value.status_code == 400


# ── lookup_members_by_ids ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_lookup_members_team_member_first():
    """TeamMember 조회 우선 — org_member 조회 없음."""
    tm = _make_team_member()
    session = AsyncMock()
    tm_result = MagicMock(); tm_result.scalars.return_value.all.return_value = [tm]
    session.execute = AsyncMock(return_value=tm_result)

    result = await lookup_members_by_ids({AGENT_TM_ID}, session)
    assert AGENT_TM_ID in result
    assert result[AGENT_TM_ID].type == "agent"
    assert session.execute.call_count == 1  # TM만 조회


@pytest.mark.anyio
async def test_lookup_members_falls_back_to_org_member():
    """TeamMember에 없으면 OrgMember에서 fallback."""
    om = _make_org_member()
    session = AsyncMock()
    empty_tm = MagicMock(); empty_tm.scalars.return_value.all.return_value = []
    om_result = MagicMock(); om_result.scalars.return_value.all.return_value = [om]
    user_result = MagicMock(); user_result.scalars.return_value.all.return_value = []
    session.execute = AsyncMock(side_effect=[empty_tm, om_result, user_result])

    result = await lookup_members_by_ids({ORG_MEMBER_ID}, session)
    assert ORG_MEMBER_ID in result
    assert result[ORG_MEMBER_ID].type == "human"


# ── 인가 불변식 (create_conversation) ────────────────────────────────────────

@pytest.mark.anyio
async def test_create_conversation_rejects_non_creator():
    """에이전트 creator가 아닌 휴먼이 대화 생성 시도 → 403."""
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    agent_id = uuid.uuid4()
    creator_user_id = uuid.uuid4()  # 에이전트의 실제 creator
    requestor_user_id = USER_ID     # 요청자 (다른 유저)

    # ResolvedMember for requestor
    sender = ResolvedMember(
        id=ORG_MEMBER_ID, user_id=requestor_user_id,
        name="user@test.com", type="human", role="member",
        org_id=ORG_ID, project_id=PROJECT_ID,
    )

    agent_tm = MagicMock()
    agent_tm.id = agent_id
    agent_tm.type = "agent"
    agent_tm.created_by = creator_user_id  # 다른 user.id

    session = AsyncMock()
    agent_result = MagicMock(); agent_result.scalars.return_value.all.return_value = [agent_tm]

    async def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: _make_auth()
    app.dependency_overrides[get_verified_org_id] = lambda: ORG_ID

    with patch("app.routers.conversations._resolve_member", return_value=sender), \
         patch("app.routers.conversations.resolve_member", return_value=sender):
        session.execute = AsyncMock(return_value=agent_result)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/conversations", json={
                "type": "dm",
                "participant_ids": [str(agent_id)],
                "project_id": str(PROJECT_ID),
            })

    app.dependency_overrides.clear()
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_create_conversation_creator_allowed():
    """에이전트 creator가 대화 생성 → 403 아님."""
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    agent_id = uuid.uuid4()
    conv_id = uuid.uuid4()

    # sender = creator
    sender = ResolvedMember(
        id=ORG_MEMBER_ID, user_id=USER_ID,
        name="creator@test.com", type="human", role="member",
        org_id=ORG_ID, project_id=PROJECT_ID,
    )

    agent_tm = MagicMock()
    agent_tm.id = agent_id
    agent_tm.type = "agent"
    agent_tm.created_by = USER_ID  # 동일한 user.id

    conv = MagicMock()
    conv.id = conv_id
    conv.type = "dm"
    conv.title = None

    session = AsyncMock()
    agent_result = MagicMock(); agent_result.scalars.return_value.all.return_value = [agent_tm]
    dm_dedup = MagicMock(); dm_dedup.scalars.return_value.all.return_value = []  # 기존 DM 없음
    session.execute = AsyncMock(side_effect=[agent_result, dm_dedup])
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock(side_effect=lambda obj: setattr(obj, "id", conv_id) or setattr(obj, "type", "dm") or setattr(obj, "title", None))

    async def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: _make_auth()
    app.dependency_overrides[get_verified_org_id] = lambda: ORG_ID

    with patch("app.routers.conversations._resolve_member", return_value=sender), \
         patch("app.routers.conversations.resolve_member", return_value=sender):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/conversations", json={
                "type": "dm",
                "participant_ids": [str(agent_id)],
                "project_id": str(PROJECT_ID),
            })

    app.dependency_overrides.clear()
    assert resp.status_code != 403
