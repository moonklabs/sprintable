"""S2-4: story claim/unclaim MCP 도구 + 현재 작업 가시화 검증.

AC1: POST /api/v2/team-members/{id}/claim → 200 + {claimed, story_id}
AC2: POST /api/v2/team-members/{id}/unclaim → 200 + {unclaimed}
AC3: claim 시 story가 project에 없으면 400
AC4: MCP claim_story 도구 존재
AC5: MCP unclaim_story 도구 존재
AC6: GET /api/v2/team-members 응답에 active_story {id, title, status} 포함
AC7: claim 중 last_seen_at 30분 초과여도 presence_status = idle
AC8: active_story schema 필드 존재
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
NOW = datetime.now(timezone.utc)


def _mock_member(active_story_id=None, last_seen_at=None, type_="agent"):
    m = MagicMock()
    m.id = MEMBER_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.user_id = None
    m.type = type_
    m.name = "TestAgent"
    m.role = "member"
    m.avatar_url = None
    m.agent_config = None
    m.is_active = True
    m.color = "#3385f8"
    m.agent_role = None
    m.runtime_type = None  # E-CHAT-CMD S1b: 신규 필드 — mock 명시(from_attributes ValidationError 방지)
    m.created_by = None
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 19, tzinfo=timezone.utc)
    m.last_seen_at = last_seen_at
    m.active_story_id = active_story_id
    m.agent_status = None
    m.active_story = None  # from_attributes 시 MagicMock 반환 방지
    return m


def _mock_story(id=None, title="Test Story", status="in-progress"):
    s = MagicMock()
    s.id = id or STORY_ID
    s.title = title
    s.status = status
    s.project_id = PROJECT_ID
    return s


def _resolved(member_id: uuid.UUID):
    """S17 RC②: resolve_member() 반환 mock — claim/unclaim self-scope 검증 대상 caller 신원."""
    from app.services.member_resolver import ResolvedMember

    return ResolvedMember(
        id=member_id, user_id=None, name="TestAgent", type="agent",
        role="member", org_id=ORG_ID, project_id=PROJECT_ID,
    )


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC1: claim 엔드포인트 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_claim_story_200():
    """AC1: POST /claim → 200 + {claimed: true, story_id}."""
    client, session, app = await _client()
    try:
        member = _mock_member()
        story = _mock_story()
        updated = _mock_member(active_story_id=STORY_ID)

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = member  # get member
            elif call_count == 2:
                result.scalar_one_or_none.return_value = story   # story 존재 확인
            else:
                result.scalar_one_or_none.return_value = updated  # update
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.refresh = AsyncMock()

        with patch("app.routers.team_members.assert_caller_is_member", new_callable=AsyncMock,
                   return_value=None):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/team-members/{MEMBER_ID}/claim",
                    json={"story_id": str(STORY_ID)},
                )

        assert resp.status_code == 200
        body = resp.json()
        assert body["claimed"] is True
        assert body["story_id"] == str(STORY_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_claim_story_403_when_caller_is_different_member():
    """S17 RC②(까심 델타 HIGH): self-scope — 타 member 명의로 claim 시도 시 403.

    이전엔 claim_story가 auth 파라미터 자체를 받지 않아 caller 확인이 전혀 없었다 — Bob이
    Alice member_id로 claim해 active_story/participation을 오염시킬 수 있는 구조였다.
    """
    client, session, app = await _client()
    try:
        member = _mock_member()
        result = MagicMock()
        result.scalar_one_or_none.return_value = member
        session.execute = AsyncMock(return_value=result)

        with patch("app.routers.team_members.assert_caller_is_member", new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=403, detail="Cannot act as another member")):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/team-members/{MEMBER_ID}/claim",
                    json={"story_id": str(STORY_ID)},
                )

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC2: unclaim 엔드포인트 ─────────────────────────────────────────────────

@pytest.mark.anyio
async def test_unclaim_story_200():
    """AC2: POST /unclaim → 200 + {unclaimed: true}."""
    client, session, app = await _client()
    try:
        member = _mock_member(active_story_id=STORY_ID)
        updated = _mock_member(active_story_id=None)

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = member if call_count == 1 else updated
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.refresh = AsyncMock()

        with patch("app.routers.team_members.assert_caller_is_member", new_callable=AsyncMock,
                   return_value=None):
            async with client as c:
                resp = await c.post(f"/api/v2/team-members/{MEMBER_ID}/unclaim")

        assert resp.status_code == 200
        assert resp.json()["unclaimed"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_unclaim_story_403_when_caller_is_different_member():
    """S17 RC②(까심 델타 HIGH — 파일락 경계의 마지막 구멍): self-scope — 타 member 명의로
    unclaim 시도 시 403. 이전엔 auth 파라미터 자체가 없어 Bob이 Alice 명의로 unclaim 호출 시
    release_all_file_locks(session, id)가 Alice의 모든 file lock을 해제할 수 있었다.
    """
    client, session, app = await _client()
    try:
        member = _mock_member(active_story_id=STORY_ID)
        result = MagicMock()
        result.scalar_one_or_none.return_value = member
        session.execute = AsyncMock(return_value=result)

        with patch("app.routers.team_members.assert_caller_is_member", new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=403, detail="Cannot act as another member")):
            async with client as c:
                resp = await c.post(f"/api/v2/team-members/{MEMBER_ID}/unclaim")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC3: story 없으면 400 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_claim_story_400_if_story_not_in_project():
    """AC3: story가 project에 없으면 400."""
    client, session, app = await _client()
    try:
        member = _mock_member()

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = member
            else:
                result.scalar_one_or_none.return_value = None  # story 없음
            return result

        session.execute = mock_execute

        with patch("app.routers.team_members.assert_caller_is_member", new_callable=AsyncMock,
                   return_value=None):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/team-members/{MEMBER_ID}/claim",
                    json={"story_id": str(uuid.uuid4())},
                )

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


# ─── AC4/5: MCP 도구 존재 확인 ───────────────────────────────────────────────

def test_mcp_claim_story_tool_in_tool_defs():
    """AC4: sprintable_claim_story 도구가 _TOOL_DEFS에 등록됨."""
    from sprintable_mcp.server import _TOOL_DEFS
    names = [t[0] for t in _TOOL_DEFS]
    assert "sprintable_claim_story" in names


def test_mcp_unclaim_story_tool_in_tool_defs():
    """AC5: sprintable_unclaim_story 도구가 _TOOL_DEFS에 등록됨."""
    from sprintable_mcp.server import _TOOL_DEFS
    names = [t[0] for t in _TOOL_DEFS]
    assert "sprintable_unclaim_story" in names


# ─── AC6/AC8: active_story 필드 ──────────────────────────────────────────────

def test_schema_has_active_story_field():
    """AC8: TeamMemberResponse에 active_story 필드 존재."""
    from app.schemas.team_member import TeamMemberResponse
    assert "active_story" in TeamMemberResponse.model_fields


@pytest.mark.anyio
async def test_list_members_active_story_injected():
    """AC6: GET /team-members 응답에 active_story {id, title, status} 포함."""
    client, session, app = await _client()
    try:
        story = _mock_story(id=STORY_ID, title="Fix Bug", status="in-progress")
        member = _mock_member(active_story_id=STORY_ID)

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                # list members
                result.scalars.return_value.all.return_value = [member]
            else:
                # stories batch 조회
                result.scalars.return_value.all.return_value = [story]
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/team-members?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["active_story"] is not None
        assert body[0]["active_story"]["id"] == str(STORY_ID)
        assert body[0]["active_story"]["title"] == "Fix Bug"
        assert body[0]["active_story"]["status"] == "in-progress"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_members_active_story_null_when_no_claim():
    """AC6: active_story_id 없으면 active_story=null."""
    client, session, app = await _client()
    try:
        member = _mock_member(active_story_id=None)

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalars.return_value.all.return_value = [member]
            else:
                result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.get(f"/api/v2/team-members?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json()[0]["active_story"] is None
    finally:
        app.dependency_overrides.clear()


# ─── AC7: claim 중 offline 강등 방지 ─────────────────────────────────────────

def test_presence_status_idle_when_claimed_over_30min():
    """AC7: claim 중이고 last_seen_at 60분 초과 → presence_status = idle (offline 아님)."""
    from app.schemas.team_member import TeamMemberResponse

    m = _mock_member(
        active_story_id=STORY_ID,
        last_seen_at=NOW - timedelta(hours=1),
    )
    resp = TeamMemberResponse.model_validate(m)
    assert resp.presence_status == "idle"


def test_presence_status_offline_when_unclaimed_over_30min():
    """AC7 반증: unclaim 상태이고 30분 초과 → offline."""
    from app.schemas.team_member import TeamMemberResponse

    m = _mock_member(
        active_story_id=None,
        last_seen_at=NOW - timedelta(hours=1),
    )
    resp = TeamMemberResponse.model_validate(m)
    assert resp.presence_status == "offline"
