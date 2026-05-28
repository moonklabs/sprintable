"""S2-3: idle 감지 API + presence_status 조회 검증.

AC1: GET /api/v2/team-members 응답에 presence_status 필드 포함
AC2: last_seen_at 5분 이내 → online
AC3: last_seen_at 5~30분 → idle
AC4: last_seen_at 30분 초과 또는 NULL(agent) → offline
AC5: type=human → presence_status=null
AC6: schema @computed_field 존재
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()

NOW = datetime.now(timezone.utc)


def _mock_member(type_: str = "agent", last_seen_at=None):
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
    m.webhook_url = None
    m.is_active = True
    m.color = "#3385f8"
    m.agent_role = None
    m.created_by = None
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 19, tzinfo=timezone.utc)
    m.last_seen_at = last_seen_at
    m.active_story_id = None
    m.agent_status = None
    m.active_story = None
    return m


# ─── AC6: computed_field 존재 확인 ───────────────────────────────────────────

def test_presence_status_computed_field_exists():
    """AC6: TeamMemberResponse에 presence_status computed_field 존재."""
    from app.schemas.team_member import TeamMemberResponse
    assert "presence_status" in TeamMemberResponse.model_computed_fields


# ─── AC2~5: threshold 계산 단위 테스트 ──────────────────────────────────────

def test_presence_status_online():
    """AC2: last_seen_at 4분 전 → online."""
    from app.schemas.team_member import TeamMemberResponse
    now = datetime.now(timezone.utc)
    m = _mock_member(last_seen_at=now - timedelta(minutes=4))
    resp = TeamMemberResponse.model_validate(m)
    assert resp.presence_status == "online"


def test_presence_status_idle():
    """AC3: last_seen_at 15분 전 → idle."""
    from app.schemas.team_member import TeamMemberResponse
    m = _mock_member(last_seen_at=NOW - timedelta(minutes=15))
    resp = TeamMemberResponse.model_validate(m)
    assert resp.presence_status == "idle"


def test_presence_status_offline_over_30():
    """AC4: last_seen_at 31분 전 → offline."""
    from app.schemas.team_member import TeamMemberResponse
    m = _mock_member(last_seen_at=NOW - timedelta(minutes=31))
    resp = TeamMemberResponse.model_validate(m)
    assert resp.presence_status == "offline"


def test_presence_status_offline_null_agent():
    """AC4: agent이고 last_seen_at NULL → offline."""
    from app.schemas.team_member import TeamMemberResponse
    m = _mock_member(type_="agent", last_seen_at=None)
    resp = TeamMemberResponse.model_validate(m)
    assert resp.presence_status == "offline"


def test_presence_status_null_for_human():
    """AC5: type=human → presence_status=null."""
    from app.schemas.team_member import TeamMemberResponse
    m = _mock_member(type_="human", last_seen_at=NOW - timedelta(minutes=1))
    resp = TeamMemberResponse.model_validate(m)
    assert resp.presence_status is None


def test_presence_status_boundary_just_under_5min():
    """AC2: 4분59초 전 → online (5분 경계 이내)."""
    from app.schemas.team_member import TeamMemberResponse
    now = datetime.now(timezone.utc)
    m = _mock_member(last_seen_at=now - timedelta(minutes=4, seconds=59))
    resp = TeamMemberResponse.model_validate(m)
    assert resp.presence_status == "online"


def test_presence_status_boundary_just_under_30min():
    """AC3: 29분59초 전 → idle (30분 경계 이내)."""
    from app.schemas.team_member import TeamMemberResponse
    now = datetime.now(timezone.utc)
    m = _mock_member(last_seen_at=now - timedelta(minutes=29, seconds=59))
    resp = TeamMemberResponse.model_validate(m)
    assert resp.presence_status == "idle"


# ─── AC1: GET /api/v2/team-members 응답에 presence_status 포함 ───────────────

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


@pytest.mark.anyio
async def test_list_team_members_includes_presence_status():
    """AC1: GET /api/v2/team-members 응답에 presence_status 필드 포함."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [
            _mock_member(type_="agent", last_seen_at=NOW - timedelta(minutes=2))
        ]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/team-members?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert "presence_status" in body[0]
        assert body[0]["presence_status"] == "online"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_members_mixed_presence():
    """AC1/2/3/4/5: 다양한 멤버 타입 + last_seen_at 혼합."""
    client, session, app = await _client()
    try:
        members = [
            _mock_member(type_="agent", last_seen_at=NOW - timedelta(minutes=2)),   # online
            _mock_member(type_="agent", last_seen_at=NOW - timedelta(minutes=15)),  # idle
            _mock_member(type_="agent", last_seen_at=NOW - timedelta(minutes=60)),  # offline
            _mock_member(type_="agent", last_seen_at=None),                         # offline
            _mock_member(type_="human", last_seen_at=NOW - timedelta(minutes=1)),   # null
        ]
        # 고유 ID 부여
        for i, m in enumerate(members):
            m.id = uuid.uuid4()

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = members
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/team-members?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        statuses = [m["presence_status"] for m in resp.json()]
        assert statuses == ["online", "idle", "offline", "offline", None]
    finally:
        app.dependency_overrides.clear()
