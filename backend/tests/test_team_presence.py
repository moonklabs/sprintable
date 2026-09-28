"""eb1a8f95: 팀 presence 집계 API — dedup + presence_status/working 매핑 단위 테스트."""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers import team_presence

ORG_ID = uuid.uuid4()


def _make_auth():
    from app.dependencies.auth import AuthContext

    return AuthContext(user_id=str(uuid.uuid4()), email=None, claims={"app_metadata": {"org_id": str(ORG_ID)}})


_AUTH = _make_auth()


@pytest.fixture(autouse=True)
def _accessible_projects_without_db():
    """story #4350 — 에이전트 «지금 하는 스토리»를 caller의 접근 가능 프로젝트로 거르며 그 집합을 먼저 푼다(목 세션이라 고정).
    app.main 대신 이 라우터 모듈을 이미 불렀으므로(모듈 머리 import) 패치가 다른 파일로 새지 않는다."""
    with patch("app.services.project_auth.accessible_project_ids_in_org", AsyncMock(return_value=[uuid.uuid4()])):
        yield


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _resp(member_id, name="Agent", presence="online"):
    """_inject_active_stories 반환 형태(TeamMemberResponse 유사) mock."""
    return SimpleNamespace(
        id=member_id, name=name, avatar_url=None, agent_role="be",
        runtime_type=None, presence_status=presence, active_story=None,
    )


@pytest.mark.anyio
async def test_team_presence_maps_presence_and_working():
    a_id, b_id = uuid.uuid4(), uuid.uuid4()
    agents = [SimpleNamespace(id=a_id), SimpleNamespace(id=b_id)]
    responses = [_resp(a_id, "Alpha", "online"), _resp(b_id, "Beta", "idle")]

    repo = MagicMock()
    repo.list = AsyncMock(return_value=agents)
    with patch("app.routers.team_presence.TeamMemberRepository", return_value=repo), \
         patch("app.routers.team_presence._inject_active_stories", new=AsyncMock(return_value=responses)), \
         patch("app.routers.team_presence.chat_presence.working_member_ids", new=AsyncMock(return_value={str(a_id)})):
        result = await team_presence.get_team_presence(session=MagicMock(), org_id=ORG_ID, auth=_AUTH)

    by_id = {str(r.member_id): r for r in result}
    assert by_id[str(a_id)].presence_status == "online"
    assert by_id[str(a_id)].working is True   # a 는 working 집합에 있음
    assert by_id[str(b_id)].presence_status == "idle"
    assert by_id[str(b_id)].working is False  # b 는 없음


@pytest.mark.anyio
async def test_team_presence_dedups_multiproject_rows():
    """멀티프로젝트 뷰 행(같은 id 중복) → 멤버당 1로 dedup."""
    a_id = uuid.uuid4()
    # 같은 에이전트가 3개 프로젝트 행으로 반환
    agents = [SimpleNamespace(id=a_id), SimpleNamespace(id=a_id), SimpleNamespace(id=a_id)]
    captured = {}

    async def _fake_inject(unique, session, *, accessible_project_ids):
        captured["unique_count"] = len(unique)
        return [_resp(a_id)]

    repo = MagicMock()
    repo.list = AsyncMock(return_value=agents)
    with patch("app.routers.team_presence.TeamMemberRepository", return_value=repo), \
         patch("app.routers.team_presence._inject_active_stories", new=_fake_inject), \
         patch("app.routers.team_presence.chat_presence.working_member_ids", new=AsyncMock(return_value=set())):
        result = await team_presence.get_team_presence(session=MagicMock(), org_id=ORG_ID, auth=_AUTH)

    assert captured["unique_count"] == 1  # dedup 후 1
    assert len(result) == 1


@pytest.mark.anyio
async def test_team_presence_empty_when_no_agents():
    repo = MagicMock()
    repo.list = AsyncMock(return_value=[])
    with patch("app.routers.team_presence.TeamMemberRepository", return_value=repo), \
         patch("app.routers.team_presence._inject_active_stories", new=AsyncMock(return_value=[])), \
         patch("app.routers.team_presence.chat_presence.working_member_ids", new=AsyncMock(return_value=set())):
        result = await team_presence.get_team_presence(session=MagicMock(), org_id=ORG_ID, auth=_AUTH)
    assert result == []
