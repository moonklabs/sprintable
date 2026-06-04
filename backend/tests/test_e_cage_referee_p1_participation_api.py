"""E-CAGE-REFEREE P1: participation API + 자동기록 훅 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
ROLE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_story_obj(assignee_id=None):
    s = MagicMock()
    s.id = STORY_ID
    s.org_id = ORG_ID
    s.project_id = PROJECT_ID
    s.epic_id = None
    s.sprint_id = None
    s.assignee_id = assignee_id
    s.assignee_ids = [assignee_id] if assignee_id else []  # E-BOARD S5
    s.meeting_id = None
    s.title = "Story 1"
    s.status = "backlog"
    s.priority = "medium"
    s.story_points = 3
    s.description = None
    s.acceptance_criteria = None
    s.position = None
    s.is_excluded = False
    s.success_hypothesis = None
    s.metric_definition = None
    s.measure_after = None
    s.outcome_status = "n_a"
    s.outcome_result = None
    s.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return s


def _mock_role():
    r = MagicMock()
    r.id = ROLE_ID
    r.org_id = ORG_ID
    r.key = "implementation"
    r.label = "구현"
    r.is_default = True
    r.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return r


async def _make_client(mock_session):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "project_id": str(PROJECT_ID)}}

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


# ── 자동기록 훅 — create_story ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_story_with_assignee_auto_creates_participation():
    """create_story + assignee → _upsert_assignee_participation 호출 단언."""
    mock_session = AsyncMock()
    story = _mock_story_obj(assignee_id=MEMBER_ID)

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.routers.stories._upsert_assignee_participation", new_callable=AsyncMock) as mock_upsert:
            mock_create.return_value = story
            async with client as c:
                resp = await c.post("/api/v2/stories", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Story 1",
                    "assignee_id": str(MEMBER_ID),
                })
            assert resp.status_code == 201
            # _upsert_assignee_participation이 실제 호출됐는지 단언
            mock_upsert.assert_called_once()
            call_args = mock_upsert.call_args[0]
            assert call_args[2] == story.id   # story_id
            assert call_args[3] == MEMBER_ID   # assignee_id
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_story_without_assignee_no_participation():
    """create_story + assignee 없음 → participation 자동기록 없음."""
    mock_session = AsyncMock()
    story = _mock_story_obj(assignee_id=None)

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.routers.stories._upsert_assignee_participation", new_callable=AsyncMock) as mock_upsert:
            mock_create.return_value = story
            async with client as c:
                resp = await c.post("/api/v2/stories", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Story 1",
                })
            assert resp.status_code == 201
            mock_upsert.assert_not_called()
    finally:
        app.dependency_overrides.clear()


# ── 자동기록 훅 — update_story ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_update_story_assignee_auto_creates_participation():
    """update_story assignee 변경 → _upsert_assignee_participation 호출 단언."""
    mock_session = AsyncMock()
    # E-BOARD S5: update_story가 _attach_assignee_ids로 story_assignees 조회 → 빈 결과 모킹
    _empty = MagicMock()
    _empty.all.return_value = []
    _empty.scalars.return_value.all.return_value = []
    _empty.scalar_one_or_none.return_value = None
    _empty.scalar.return_value = None
    mock_session.execute.return_value = _empty
    story = _mock_story_obj(assignee_id=MEMBER_ID)

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.base.BaseRepository.update", new_callable=AsyncMock) as mock_update, \
             patch("app.repositories.story.StoryRepository.get", new_callable=AsyncMock) as mock_get, \
             patch("app.routers.stories._upsert_assignee_participation", new_callable=AsyncMock) as mock_upsert, \
             patch("app.routers.stories._resolve_team_member_id", new_callable=AsyncMock, return_value=None), \
             patch("app.routers.stories._resolve_actor_info", new_callable=AsyncMock, return_value=(None, None, None)):
            mock_update.return_value = story
            mock_get.return_value = _mock_story_obj(assignee_id=None)
            mock_session.commit = AsyncMock()
            async with client as c:
                resp = await c.patch(f"/api/v2/stories/{STORY_ID}", json={
                    "assignee_id": str(MEMBER_ID),
                })
            assert resp.status_code == 200
            mock_upsert.assert_called_once()
    finally:
        app.dependency_overrides.clear()


# ── _upsert_assignee_participation 멱등성 단위 테스트 ─────────────────────────

@pytest.mark.anyio
async def test_upsert_assignee_participation_idempotent():
    """이미 participation 존재 → 중복 생성 안 함."""
    from app.routers.stories import _upsert_assignee_participation

    session = AsyncMock()
    default_role = _mock_role()

    with patch("app.repositories.participation.ParticipationRoleRepository.get_default", new_callable=AsyncMock) as mock_role, \
         patch("app.repositories.participation.ParticipationRepository.exists", new_callable=AsyncMock) as mock_exists, \
         patch("app.repositories.participation.ParticipationRepository.create", new_callable=AsyncMock) as mock_create:
        mock_role.return_value = default_role
        mock_exists.return_value = True  # 이미 존재

        await _upsert_assignee_participation(session, ORG_ID, STORY_ID, MEMBER_ID)

        mock_create.assert_not_called()


@pytest.mark.anyio
async def test_upsert_assignee_participation_creates_when_not_exists():
    """participation 없음 → 신규 생성."""
    from app.routers.stories import _upsert_assignee_participation

    session = AsyncMock()
    default_role = _mock_role()

    with patch("app.repositories.participation.ParticipationRoleRepository.get_default", new_callable=AsyncMock) as mock_role, \
         patch("app.repositories.participation.ParticipationRepository.exists", new_callable=AsyncMock) as mock_exists, \
         patch("app.repositories.participation.ParticipationRepository.create", new_callable=AsyncMock) as mock_create:
        mock_role.return_value = default_role
        mock_exists.return_value = False  # 없음

        await _upsert_assignee_participation(session, ORG_ID, STORY_ID, MEMBER_ID)

        mock_create.assert_called_once()
        call_kwargs = mock_create.call_args[1]
        assert call_kwargs["story_id"] == STORY_ID
        assert call_kwargs["member_id"] == MEMBER_ID
        assert call_kwargs["role_id"] == default_role.id


@pytest.mark.anyio
async def test_upsert_no_default_role_skips():
    """org에 default role 없으면 조용히 스킵."""
    from app.routers.stories import _upsert_assignee_participation

    session = AsyncMock()

    with patch("app.repositories.participation.ParticipationRoleRepository.get_default", new_callable=AsyncMock) as mock_role, \
         patch("app.repositories.participation.ParticipationRepository.create", new_callable=AsyncMock) as mock_create:
        mock_role.return_value = None  # default role 없음

        await _upsert_assignee_participation(session, ORG_ID, STORY_ID, MEMBER_ID)

        mock_create.assert_not_called()


# ── 기존 story create/update 비파괴 ───────────────────────────────────────────

@pytest.mark.anyio
async def test_create_story_without_assignee_still_201():
    """assignee 없이 create_story → 정상 201 (기존 동작 비파괴)."""
    mock_session = AsyncMock()
    story = _mock_story_obj(assignee_id=None)

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = story
            async with client as c:
                resp = await c.post("/api/v2/stories", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Story without assignee",
                })
        assert resp.status_code == 201
        assert resp.json()["title"] == "Story 1"
    finally:
        app.dependency_overrides.clear()
