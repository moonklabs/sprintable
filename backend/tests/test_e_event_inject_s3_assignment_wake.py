"""E-EVENT-INJECT S3: assignment-wake.

스토리를 agent에 배정만 해도 dispatch 클릭 없이 깨워 work-turn 시작:
agent assignee → story_assigned gateway Event(content) + seq + commit + wake_agent.
human assignee → 기존 dispatch_notification 유지(변경0), wake 없음.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
ASSIGNEE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _story(assignee_id):
    s = MagicMock()
    s.id = STORY_ID
    s.org_id = ORG_ID
    s.project_id = PROJECT_ID
    s.epic_id = None
    s.sprint_id = None
    s.assignee_id = assignee_id
    s.assignee_ids = [assignee_id] if assignee_id else []
    s.reporter_id = None  # 9f25e74a: created_by(alias) 검증 위해 명시
    s.meeting_id = None
    s.title = "Build login"
    s.description = "OAuth + password"
    s.status = "backlog"
    s.priority = "medium"
    s.story_points = None
    s.acceptance_criteria = None
    s.position = None
    s.is_excluded = False
    s.success_hypothesis = None
    s.metric_definition = None
    s.measure_after = None
    s.outcome_status = "n_a"
    s.outcome_result = None
    s.attachments = []
    s.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return s


async def _run_patch(assignee_type: str):
    """assignee_type('agent'/'human')으로 PATCH /stories/{id} 실행 후 (wake_agent, dispatch_notification, added events) 반환."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "project_id": str(PROJECT_ID)}}

    session = AsyncMock()
    added = []
    session.add = MagicMock(side_effect=added.append)
    result = MagicMock()
    result.scalar_one_or_none.return_value = assignee_type  # TeamMember.type 조회
    result.scalars.return_value.all.return_value = []
    result.all.return_value = []
    session.execute = AsyncMock(return_value=result)
    session.commit = AsyncMock()
    session.flush = AsyncMock()

    async def _seq(db, ev):
        ev.recipient_seq = 7  # seq 발급 시뮬

    async def override_db():
        yield session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    story = _story(ASSIGNEE_ID)
    try:
        with patch("app.repositories.base.BaseRepository.update", new_callable=AsyncMock, return_value=story), \
             patch("app.routers.stories.StoryRepository.get", new_callable=AsyncMock, return_value=_story(None)), \
             patch("app.routers.stories._resolve_team_member_id", new_callable=AsyncMock, return_value=None), \
             patch("app.routers.stories._resolve_actor_info", new_callable=AsyncMock, return_value=(None, None, None)), \
             patch("app.routers.stories._upsert_assignee_participation", new_callable=AsyncMock), \
             patch("app.repositories.story_assignee.StoryAssigneeRepository.set_for_story", new_callable=AsyncMock, return_value=[ASSIGNEE_ID]), \
             patch("app.routers.stories.assign_recipient_seq", side_effect=_seq), \
             patch("app.routers.stories.wake_agent") as mock_wake, \
             patch("app.routers.stories.dispatch_notification", new_callable=AsyncMock) as mock_dispatch:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as c:
                resp = await c.patch(f"/api/v2/stories/{STORY_ID}", json={"assignee_id": str(ASSIGNEE_ID)})
            return resp, mock_wake, mock_dispatch, added
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_assignee_wakes_with_story_assigned_event():
    resp, mock_wake, mock_dispatch, added = await _run_patch("agent")
    assert resp.status_code == 200
    # story_assigned Event(content 포함)가 생성됐고 wake_agent 호출됨
    sa_events = [e for e in added if getattr(e, "event_type", None) == "story_assigned"]
    assert len(sa_events) == 1
    ev = sa_events[0]
    assert ev.recipient_type == "agent"
    assert ev.payload["content"].startswith("[story] Build login")
    mock_wake.assert_called_once()
    mock_dispatch.assert_not_called()  # 중복전달 방지: agent는 dispatch_notification 안 탐


@pytest.mark.anyio
async def test_human_assignee_uses_dispatch_notification_no_wake():
    resp, mock_wake, mock_dispatch, added = await _run_patch("human")
    assert resp.status_code == 200
    sa_events = [e for e in added if getattr(e, "event_type", None) == "story_assigned"]
    assert sa_events == []  # human은 신규 gateway Event 없음
    mock_wake.assert_not_called()
    mock_dispatch.assert_called_once()  # 기존 경로 유지
