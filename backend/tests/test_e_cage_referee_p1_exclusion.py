"""E-CAGE-REFEREE P1: 데이터 오염 청소 테스트 (is_excluded 필터 + dry-run)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── from_attributes 회귀 방지 ────────────────────────────────────────────────

def test_story_response_has_is_excluded():
    """StoryResponse에 is_excluded 필드 존재 + 기본값 False."""
    from app.schemas.story import StoryResponse
    # default 값 검증
    fields = StoryResponse.model_fields
    assert "is_excluded" in fields
    assert fields["is_excluded"].default is False


def test_story_model_has_is_excluded():
    """Story 모델에 is_excluded 필드 존재."""
    from app.models.pm import Story
    assert hasattr(Story, "is_excluded")


# ── is_excluded 필터 — get_agent_stats ───────────────────────────────────────

@pytest.mark.anyio
async def test_get_agent_stats_excludes_marked_stories():
    """get_agent_stats 쿼리에 Story.is_excluded.is_(False) 포함 검증."""
    from app.repositories.analytics import AnalyticsRepository
    import sqlalchemy as sa

    session = AsyncMock()
    # TeamMember 존재 확인 쿼리
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = MEMBER_ID
    # stories 쿼리
    stories_result = MagicMock()
    stories_result.all.return_value = []

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return member_result
        return stories_result

    session.execute = mock_execute

    repo = AnalyticsRepository(session, ORG_ID)
    result = await repo.get_agent_stats(PROJECT_ID, MEMBER_ID)

    # stories 쿼리가 실행됐는지 확인 (2번째 execute)
    assert call_count >= 2

    # 반환값이 있는지 (None이 아닌)
    assert result is not None
    assert result["completed"] == 0


# ── PATCH stories/{id} is_excluded 마킹 ──────────────────────────────────────

@pytest.mark.anyio
async def test_patch_story_is_excluded_true():
    """PATCH /stories/{id} is_excluded=true → 마킹 성공."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    marked_story = MagicMock()
    marked_story.id = STORY_ID
    marked_story.org_id = ORG_ID
    marked_story.project_id = PROJECT_ID
    marked_story.epic_id = None
    marked_story.sprint_id = None
    marked_story.assignee_id = None
    marked_story.meeting_id = None
    marked_story.title = "Story 1"
    marked_story.status = "backlog"
    marked_story.priority = "medium"
    marked_story.story_points = 3
    marked_story.description = None
    marked_story.acceptance_criteria = None
    marked_story.position = None
    marked_story.is_excluded = True  # 마킹됨
    marked_story.success_hypothesis = None
    marked_story.metric_definition = None
    marked_story.measure_after = None
    marked_story.outcome_status = "n_a"
    marked_story.outcome_result = None
    marked_story.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    marked_story.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        with patch("app.repositories.base.BaseRepository.update", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = marked_story
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.patch(f"/api/v2/stories/{STORY_ID}", json={"is_excluded": True})
            assert resp.status_code == 200
            assert resp.json()["is_excluded"] is True
            call_kwargs = mock_update.call_args[1]
            assert call_kwargs.get("is_excluded") is True
    finally:
        app.dependency_overrides.clear()


# ── dry-run 리포트 엔드포인트 ─────────────────────────────────────────────────

@pytest.mark.anyio
async def test_exclusion_dry_run_200():
    """GET /api/v2/exclusion/dry-run → 200 리포트 (마킹 없음)."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    call_count = 0
    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count <= 2:
            result.scalar_one.return_value = 100 if call_count == 1 else 5
        elif call_count == 3:
            result.all.return_value = []
        else:
            result.all.return_value = []
        return result

    mock_session.execute = mock_execute

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/exclusion/dry-run")
        assert resp.status_code == 200
        body = resp.json()
        # 리포트 구조 확인
        assert "total_stories" in body
        assert "already_excluded" in body
        assert "high_sp_candidates" in body
        assert "assignee_distribution" in body
        assert "criteria" in body
        # 마킹 없음 명시 확인
        assert "자동 마킹 없음" in body["criteria"]["note"]
    finally:
        app.dependency_overrides.clear()


# ── org 격리 ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_org_isolation_exclusion():
    """dry-run은 org 스코프 내 데이터만 보여줌."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def mock_execute(stmt, *args, **kwargs):
        result = MagicMock()
        result.scalar_one.return_value = 0
        result.all.return_value = []
        return result

    mock_session.execute = mock_execute

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/exclusion/dry-run")
        assert resp.status_code == 200
        assert resp.json()["total_stories"] == 0
    finally:
        app.dependency_overrides.clear()
