"""S19 AC5: Story router + repository 단위 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()


def _mock_story(status: str = "backlog") -> MagicMock:
    s = MagicMock()
    s.id = STORY_ID
    s.org_id = ORG_ID
    s.project_id = PROJECT_ID
    s.epic_id = None
    s.sprint_id = None
    s.assignee_id = None
    s.meeting_id = None
    s.title = "Story 1"
    s.status = status
    s.priority = "medium"
    s.story_points = 3
    s.description = None
    s.acceptance_criteria = None
    s.position = None
    # E-OUTCOME-LOOP: 신규 필드 (MagicMock이 반환하는 MagicMock 객체가 Pydantic 검증 실패하므로 명시 세팅)
    s.success_hypothesis = None
    s.metric_definition = None
    s.measure_after = None
    s.outcome_status = "n_a"
    s.outcome_result = None
    s.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return s


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

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
async def test_list_stories_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_story()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/stories?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["status"] == "backlog"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_story_201():
    client, session, app = await _client()
    try:
        story = _mock_story()
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = story

            async with client as c:
                resp = await c.post("/api/v2/stories", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Story 1",
                    "story_points": 3,
                })

        assert resp.status_code == 201
        assert resp.json()["story_points"] == 3
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_story_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_story()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/stories/{STORY_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(STORY_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_story_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/stories/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_story_200():
    client, session, app = await _client()
    try:
        updated = _mock_story()
        updated.story_points = 5
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(f"/api/v2/stories/{STORY_ID}", json={"story_points": 5})

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_story_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = _mock_story()
        session.execute = AsyncMock(return_value=mock_result)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/stories/{STORY_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_status_transition_200():
    """backlog → ready-for-dev 순차 전이 성공."""
    client, session, app = await _client()
    try:
        backlog_story = _mock_story("backlog")
        ready_story = _mock_story("ready-for-dev")

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = backlog_story
            else:
                result.scalar_one_or_none.return_value = ready_story
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.patch(
                f"/api/v2/stories/{STORY_ID}/status",
                json={"status": "ready-for-dev"},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "ready-for-dev"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_status_transition_invalid_400():
    """backlog → done 비순차 전이 → 400."""
    client, session, app = await _client()
    try:
        backlog_story = _mock_story("backlog")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = backlog_story
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(
                f"/api/v2/stories/{STORY_ID}/status",
                json={"status": "done"},
            )

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_status_update_returns_new_value_not_stale():
    """update() ORM setattr 방식 — 항상 동일 객체 반환해도 setattr된 새 값이 나와야 함."""
    client, session, app = await _client()
    try:
        original = _mock_story("backlog")

        async def mock_execute(stmt, *args, **kwargs):
            result = MagicMock()
            result.scalar_one_or_none.return_value = original
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.patch(
                f"/api/v2/stories/{STORY_ID}/status",
                json={"status": "ready-for-dev"},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "ready-for-dev"
        assert resp.json()["status"] != "backlog"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
@pytest.mark.parametrize("from_status,to_status", [
    ("ready-for-dev", "in-progress"),
    ("in-progress", "in-review"),
    ("in-review", "done"),
])
async def test_status_transition_each_step_200(from_status: str, to_status: str):
    """순차 전이 각 단계 성공."""
    client, session, app = await _client()
    try:
        story = _mock_story(from_status)

        async def mock_execute(stmt, *args, **kwargs):
            result = MagicMock()
            result.scalar_one_or_none.return_value = story
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.patch(
                f"/api/v2/stories/{STORY_ID}/status",
                json={"status": to_status},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == to_status
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["backlog", "ready-for-dev", "in-progress", "in-review", "done"])
async def test_status_same_status_idempotent_200(status: str):
    """동일 status로 PATCH → 200 idempotent (no-op)."""
    client, session, app = await _client()
    try:
        story = _mock_story(status)
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(
                f"/api/v2/stories/{STORY_ID}/status",
                json={"status": status},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == status
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
@pytest.mark.parametrize("from_status,to_status", [
    ("done", "in-review"),
    ("in-review", "in-progress"),
    ("ready-for-dev", "backlog"),
])
async def test_status_backward_transition_400(from_status: str, to_status: str):
    """역방향 전이 거부 → 400."""
    client, session, app = await _client()
    try:
        story = _mock_story(from_status)
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = story
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(
                f"/api/v2/stories/{STORY_ID}/status",
                json={"status": to_status},
            )

        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


# ── E-OUTCOME-LOOP S2: 의도필드 + metric_definition 검증 ──────────────────────

_VALID_METRIC = {"metric": "MAU", "source": "ga4", "target": 1000, "direction": "up"}


@pytest.mark.anyio
async def test_create_story_with_intent_fields_201():
    """create에 의도필드(success_hypothesis·metric_definition·measure_after) 전달 → 201 (AC1/AC2)."""
    client, session, app = await _client()
    try:
        story = _mock_story()
        story.success_hypothesis = "MAU 10% 증가"
        story.metric_definition = _VALID_METRIC
        story.measure_after = datetime(2026, 7, 1, tzinfo=timezone.utc)

        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = story

            async with client as c:
                resp = await c.post("/api/v2/stories", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Outcome Story",
                    "success_hypothesis": "MAU 10% 증가",
                    "metric_definition": _VALID_METRIC,
                    "measure_after": "2026-07-01T00:00:00Z",
                })

        assert resp.status_code == 201
        _, kwargs = mock_create.call_args
        assert kwargs.get("success_hypothesis") == "MAU 10% 증가"
        assert kwargs.get("metric_definition") == _VALID_METRIC
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
@pytest.mark.parametrize("bad_metric,desc", [
    ({"source": "ga4", "target": 100, "direction": "up"}, "metric 키 누락"),
    ({"metric": "MAU", "source": "bad_src", "target": 100, "direction": "up"}, "source 비정상값"),
    ({"metric": "MAU", "source": "ga4", "target": 100, "direction": "sideways"}, "direction 비정상값"),
    ({"metric": "MAU", "source": "ga4", "target": 100}, "direction 키 누락"),
])
async def test_create_story_invalid_metric_definition_422(bad_metric: dict, desc: str):
    """metric_definition 구조 오류 → 422 (AC3)."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/stories", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(ORG_ID),
                "title": "Test",
                "metric_definition": bad_metric,
            })
        assert resp.status_code == 422, f"expected 422 for {desc}"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_story_invalid_metric_definition_422():
    """update metric_definition 구조 오류 → 422 (AC3)."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.patch(f"/api/v2/stories/{STORY_ID}", json={
                "metric_definition": {"bad": "structure"},
            })
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_story_outcome_fields_ignored():
    """create 시 outcome_status/outcome_result는 무시 — 채점잡 전용 (AC4)."""
    client, session, app = await _client()
    try:
        story = _mock_story()
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = story

            async with client as c:
                resp = await c.post("/api/v2/stories", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Test",
                    "outcome_status": "achieved",
                    "outcome_result": {"score": 90},
                })

        assert resp.status_code == 201
        _, kwargs = mock_create.call_args
        assert "outcome_status" not in kwargs, "outcome_status가 create에 전달되면 안됨"
        assert "outcome_result" not in kwargs, "outcome_result가 create에 전달되면 안됨"
    finally:
        app.dependency_overrides.clear()
