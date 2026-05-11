"""report-done API 단위 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
AGENT_ID = uuid.UUID("9cac9d96-5474-45f7-941e-787407597b52")
MEMO_ID = uuid.uuid4()

_PO_ID = uuid.UUID("05f52181-ea2a-42be-b9a8-9a418b72feb1")
_DEV_ID = uuid.UUID("9cac9d96-5474-45f7-941e-787407597b52")
_QA_ID = uuid.UUID("685f3f72-c85c-4a32-898f-3d3320ba39ad")


def _mock_story(status: str = "in-progress") -> MagicMock:
    s = MagicMock()
    s.id = STORY_ID
    s.org_id = ORG_ID
    s.project_id = PROJECT_ID
    s.title = "테스트 스토리"
    s.status = status
    return s


def _mock_memo() -> MagicMock:
    m = MagicMock()
    m.id = MEMO_ID
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    return m


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(AGENT_ID)
    ctx.email = "agent@test.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    ctx.org_id = str(ORG_ID)

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
async def test_invalid_stage_400():
    """유효하지 않은 stage는 400 반환."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/workflow/report-done", json={
                "story_id": str(STORY_ID),
                "stage": "invalid_stage",
                "agent_id": str(AGENT_ID),
            })
        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_story_not_found_404():
    """존재하지 않는 story_id는 404 반환."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.post("/api/v2/workflow/report-done", json={
                "story_id": str(uuid.uuid4()),
                "stage": "kickoff",
                "agent_id": str(AGENT_ID),
            })
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_kickoff_to_dev():
    """kickoff 완료 → DEV 킥오프 메모 발송 + 스토리 in-progress 전환."""
    client, session, app = await _client()
    try:
        story = _mock_story(status="ready-for-dev")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        with (
            patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock) as mock_update,
            patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create,
        ):
            mock_update.return_value = story
            mock_create.return_value = _mock_memo()

            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json={
                    "story_id": str(STORY_ID),
                    "stage": "kickoff",
                    "agent_id": str(AGENT_ID),
                })

        assert resp.status_code == 200
        data = resp.json()
        assert data["completed_stage"] == "kickoff"
        assert data["next_stage"] == "dev"
        assert data["story_status"] == "in-progress"
        assert data["memo_id"] is not None
        mock_update.assert_called_once()
        mock_create.assert_called_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dev_to_review():
    """dev 완료 → PO 리뷰 메모 발송, 스토리 상태 변경 없음."""
    client, session, app = await _client()
    try:
        story = _mock_story(status="in-progress")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _mock_memo()

            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json={
                    "story_id": str(STORY_ID),
                    "stage": "dev",
                    "agent_id": str(AGENT_ID),
                })

        assert resp.status_code == 200
        data = resp.json()
        assert data["completed_stage"] == "dev"
        assert data["next_stage"] == "review"
        assert data["story_status"] is None
        assert data["memo_id"] is not None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_merge_to_done():
    """merge 완료 → 스토리 done 전환, 메모 없음."""
    client, session, app = await _client()
    try:
        story = _mock_story(status="in-review")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = story

            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json={
                    "story_id": str(STORY_ID),
                    "stage": "merge",
                    "agent_id": str(AGENT_ID),
                })

        assert resp.status_code == 200
        data = resp.json()
        assert data["completed_stage"] == "merge"
        assert data["next_stage"] == "done"
        assert data["story_status"] == "done"
        assert data["memo_id"] is None
        mock_update.assert_called_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_context_field_accepted():
    """context 필드를 포함한 요청이 정상 처리된다."""
    client, session, app = await _client()
    try:
        story = _mock_story()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _mock_memo()

            async with client as c:
                resp = await c.post("/api/v2/workflow/report-done", json={
                    "story_id": str(STORY_ID),
                    "stage": "dev",
                    "agent_id": str(AGENT_ID),
                    "context": {"pr_url": "https://github.com/moonklabs/sprintable/pull/999"},
                })

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_all_valid_stages():
    """모든 유효 stage가 400 없이 처리된다."""
    from app.routers.workflow_report import _VALID_STAGES

    client, session, app = await _client()
    try:
        for stage in _VALID_STAGES:
            story = _mock_story()
            mock_result = MagicMock()
            mock_result.scalar_one_or_none.return_value = story
            session.execute = AsyncMock(return_value=mock_result)

            with (
                patch("app.repositories.story.StoryRepository.update", new_callable=AsyncMock, return_value=story),
                patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock, return_value=_mock_memo()),
            ):
                async with client as c:
                    resp = await c.post("/api/v2/workflow/report-done", json={
                        "story_id": str(STORY_ID),
                        "stage": stage,
                        "agent_id": str(AGENT_ID),
                    })

            assert resp.status_code == 200, f"stage={stage} → {resp.status_code}"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_next_assignee_mapping():
    """각 stage별 next_role이 올바른 member_id에 매핑된다."""
    from app.routers.workflow_report import _ROLE_TO_MEMBER, _TRANSITIONS

    assert _ROLE_TO_MEMBER["po"] == uuid.UUID("05f52181-ea2a-42be-b9a8-9a418b72feb1")
    assert _ROLE_TO_MEMBER["dev"] == uuid.UUID("9cac9d96-5474-45f7-941e-787407597b52")
    assert _ROLE_TO_MEMBER["qa"] == uuid.UUID("685f3f72-c85c-4a32-898f-3d3320ba39ad")
    assert _TRANSITIONS["kickoff"]["next_role"] == "dev"
    assert _TRANSITIONS["dev"]["next_role"] == "po"
    assert _TRANSITIONS["review"]["next_role"] == "qa"
    assert _TRANSITIONS["qa"]["next_role"] == "po"
    assert _TRANSITIONS["merge"]["next_role"] is None


@pytest.mark.anyio
async def test_pipeline_sequence():
    """kickoff→dev→review→qa→merge→done 순서가 올바르다."""
    from app.routers.workflow_report import _TRANSITIONS, _VALID_STAGES

    stage = "kickoff"
    visited = [stage]
    while True:
        t = _TRANSITIONS.get(stage)
        if t is None:
            break
        stage = t["next_stage"]
        visited.append(stage)
        if stage == "done":
            break

    assert visited == ["kickoff", "dev", "review", "qa", "merge", "done"]
