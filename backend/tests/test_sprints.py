"""S13 AC5: Sprint router + repository 단위 테스트 (8건 이상)."""
import uuid
from datetime import date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
SPRINT_ID = uuid.uuid4()
VALID_TOKEN = "Bearer valid.jwt.token"


def _mock_sprint(status: str = "planning") -> MagicMock:
    s = MagicMock()
    s.id = SPRINT_ID
    s.org_id = ORG_ID
    s.project_id = PROJECT_ID
    s.title = "Sprint 1"
    s.status = status
    s.start_date = date(2026, 5, 1)
    s.end_date = date(2026, 5, 14)
    s.velocity = None
    s.team_size = None
    s.duration = 14
    s.report_doc_id = None
    # E-OUTCOME-LOOP: 신규 필드 (MagicMock 반환 객체가 Pydantic 검증 실패하므로 명시 세팅)
    s.success_hypothesis = None
    s.metric_definition = None
    s.measure_after = None
    s.outcome_status = "n_a"
    s.outcome_result = None
    from datetime import datetime, timezone
    s.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    s.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return s


def _auth_patch():
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    return patch("app.routers.sprints.get_current_user", return_value=lambda: ctx)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── helpers ────────────────────────────────────────────────────────────────────

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


# ── GET list ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_sprints_200():
    client, session, app = await _client()
    try:
        sprint = _mock_sprint()
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [sprint]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/sprints")

        assert resp.status_code == 200
        assert isinstance(resp.json(), list)
    finally:
        app.dependency_overrides.clear()


# ── POST create ───────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_sprint_201():
    client, session, app = await _client()
    try:
        sprint = _mock_sprint()
        session.add = MagicMock()
        session.flush = AsyncMock()
        session.refresh = AsyncMock()

        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = sprint

            async with client as c:
                resp = await c.post("/api/v2/sprints", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Sprint 1",
                    "start_date": "2026-05-01",
                    "end_date": "2026-05-14",
                })

        assert resp.status_code == 201
        assert resp.json()["title"] == "Sprint 1"
    finally:
        app.dependency_overrides.clear()


# ── GET detail ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_sprint_200():
    client, session, app = await _client()
    try:
        sprint = _mock_sprint()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = sprint
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/sprints/{SPRINT_ID}")

        assert resp.status_code == 200
        assert resp.json()["id"] == str(SPRINT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_sprint_404():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/sprints/{uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ── PATCH update ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_update_sprint_200():
    client, session, app = await _client()
    try:
        sprint = _mock_sprint()
        sprint.title = "Updated Sprint"
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = sprint
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(f"/api/v2/sprints/{SPRINT_ID}", json={"title": "Updated Sprint"})

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


# ── DELETE ────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_delete_sprint_200():
    client, session, app = await _client()
    try:
        sprint = _mock_sprint()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = sprint
        session.execute = AsyncMock(return_value=mock_result)
        session.delete = AsyncMock()
        session.flush = AsyncMock()

        async with client as c:
            resp = await c.delete(f"/api/v2/sprints/{SPRINT_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


# ── activate ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_activate_sprint_200():
    client, session, app = await _client()
    try:
        planning_sprint = _mock_sprint("planning")
        active_sprint = _mock_sprint("active")

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                # get sprint
                result.scalar_one_or_none.return_value = planning_sprint
            elif call_count == 2:
                # check active sprint — none
                result.scalar_one_or_none.return_value = None
            else:
                # update + re-get
                result.scalar_one_or_none.return_value = active_sprint
            result.scalars.return_value.all.return_value = []
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.post(f"/api/v2/sprints/{SPRINT_ID}/activate")

        assert resp.status_code == 200
        assert resp.json()["status"] == "active"
    finally:
        app.dependency_overrides.clear()


# ── close ─────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_close_sprint_200():
    client, session, app = await _client()
    try:
        active_sprint = _mock_sprint("active")
        closed_sprint = _mock_sprint("closed")
        closed_sprint.velocity = 10

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = active_sprint
            elif call_count == 2:
                # done stories
                done_story = MagicMock()
                done_story.story_points = 5
                done_story2 = MagicMock()
                done_story2.story_points = 5
                result.scalars.return_value.all.return_value = [done_story, done_story2]
            else:
                result.scalar_one_or_none.return_value = closed_sprint
            return result

        session.execute = mock_execute

        async with client as c:
            resp = await c.post(f"/api/v2/sprints/{SPRINT_ID}/close")

        assert resp.status_code == 200
        assert resp.json()["status"] == "closed"
    finally:
        app.dependency_overrides.clear()


# ── kickoff ───────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_kickoff_sprint_200():
    client, session, app = await _client()
    try:
        sprint = _mock_sprint("active")
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = sprint
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.post(f"/api/v2/sprints/{SPRINT_ID}/kickoff", json={"message": "Let's go!"})

        assert resp.status_code == 200
        body = resp.json()
        assert body["notified"] == 0
        assert body["sprint_id"] == str(SPRINT_ID)
    finally:
        app.dependency_overrides.clear()


# ── E-OUTCOME-LOOP S2: 의도필드 + metric_definition 검증 ──────────────────────

_VALID_METRIC = {"metric": "retention", "source": "internal_ops", "target": 0.8, "direction": "up"}


@pytest.mark.anyio
async def test_create_sprint_with_intent_fields_201():
    """create에 의도필드 전달 → 201 + repo.create에 의도필드 전달 확인 (AC1/AC2)."""
    client, session, app = await _client()
    try:
        sprint = _mock_sprint()
        sprint.success_hypothesis = "Retention 80% 달성"
        sprint.metric_definition = _VALID_METRIC
        sprint.measure_after = None

        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = sprint

            async with client as c:
                resp = await c.post("/api/v2/sprints", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Outcome Sprint",
                    "success_hypothesis": "Retention 80% 달성",
                    "metric_definition": _VALID_METRIC,
                })

        assert resp.status_code == 201
        _, kwargs = mock_create.call_args
        assert kwargs.get("success_hypothesis") == "Retention 80% 달성"
        assert kwargs.get("metric_definition") == _VALID_METRIC
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
@pytest.mark.parametrize("bad_metric,desc", [
    ({"source": "manual", "target": 0.8, "direction": "up"}, "metric 키 누락"),
    ({"metric": "retention", "source": "unknown", "target": 0.8, "direction": "up"}, "source 비정상값"),
    ({"metric": "retention", "source": "manual", "target": 0.8, "direction": "flat"}, "direction 비정상값"),
])
async def test_create_sprint_invalid_metric_definition_422(bad_metric: dict, desc: str):
    """metric_definition 구조 오류 → 422 (AC3)."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/sprints", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(ORG_ID),
                "title": "Test Sprint",
                "metric_definition": bad_metric,
            })
        assert resp.status_code == 422, f"expected 422 for {desc}"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_sprint_invalid_metric_definition_422():
    """update metric_definition 구조 오류 → 422 (AC3)."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.patch(f"/api/v2/sprints/{SPRINT_ID}", json={
                "metric_definition": {"bad": "structure"},
            })
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


# ── E-OUTCOME-LOOP S3: 채점 로직 테스트 ──────────────────────────────────────

from app.services.outcome_scorer import score_sprint_outcome


class TestScoreSprintOutcome:
    """outcome_scorer.score_sprint_outcome 단위 테스트."""

    def test_no_metric_definition_returns_none(self):
        """metric_definition 없음 → None (n_a 유지)."""
        assert score_sprint_outcome(None, 30) is None
        assert score_sprint_outcome({}, 30) is None

    def test_external_source_returns_pending(self):
        """external source(ga4/manual) → pending."""
        for src in ("ga4", "manual"):
            r = score_sprint_outcome(
                {"source": src, "metric": "m", "target": 100, "direction": "up"}, 50
            )
            assert r is not None
            assert r["outcome_status"] == "pending"
            assert r["outcome_result"] is None

    def test_up_direction_hit_when_actual_ge_target(self):
        """direction='up', actual >= target → hit."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "velocity", "target": 30, "direction": "up"},
            velocity=30,
        )
        assert r is not None
        assert r["outcome_status"] == "hit"
        assert r["outcome_result"]["actual"] == 30.0
        assert r["outcome_result"]["target"] == 30.0
        assert "scored_at" in r["outcome_result"]

    def test_up_direction_miss_when_actual_lt_target(self):
        """direction='up', actual < target → miss."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "velocity", "target": 50, "direction": "up"},
            velocity=30,
        )
        assert r is not None
        assert r["outcome_status"] == "miss"

    def test_down_direction_hit_when_actual_le_target(self):
        """direction='down', actual <= target → hit."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "backlog", "target": 5, "direction": "down"},
            velocity=3,
        )
        assert r is not None
        assert r["outcome_status"] == "hit"

    def test_down_direction_miss_when_actual_gt_target(self):
        """direction='down', actual > target → miss."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "backlog", "target": 5, "direction": "down"},
            velocity=8,
        )
        assert r is not None
        assert r["outcome_status"] == "miss"

    def test_boundary_exact_target_up_is_hit(self):
        """경계값: actual == target, direction='up' → hit."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "velocity", "target": 42, "direction": "up"},
            velocity=42,
        )
        assert r is not None
        assert r["outcome_status"] == "hit"

    def test_boundary_exact_target_down_is_hit(self):
        """경계값: actual == target, direction='down' → hit."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "backlog", "target": 10, "direction": "down"},
            velocity=10,
        )
        assert r is not None
        assert r["outcome_status"] == "hit"

    def test_zero_velocity_with_up_direction(self):
        """velocity=0, direction='up', target>0 → miss."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "velocity", "target": 10, "direction": "up"},
            velocity=0,
        )
        assert r is not None
        assert r["outcome_status"] == "miss"

    def test_outcome_result_contains_required_fields(self):
        """outcome_result에 metric·target·actual·direction·scored_at 포함."""
        md = {"source": "internal_ops", "metric": "velocity", "target": 20, "direction": "up"}
        r = score_sprint_outcome(md, velocity=25)
        assert r is not None
        result = r["outcome_result"]
        for key in ("metric", "target", "actual", "direction", "scored_at"):
            assert key in result, f"outcome_result에 {key} 없음"


@pytest.mark.anyio
async def test_close_sprint_scores_outcome_hit():
    """sprint close 시 metric_definition 있으면 채점 → outcome_status hit/miss 반영."""
    client, session, app = await _client()
    try:
        sprint = _mock_sprint("active")
        sprint.metric_definition = {
            "metric": "velocity", "source": "internal_ops", "target": 10, "direction": "up"
        }
        sprint.outcome_status = "n_a"

        closed = _mock_sprint("closed")
        closed.outcome_status = "hit"
        closed.outcome_result = {"metric": "velocity", "target": 10.0, "actual": 14.0, "direction": "up", "scored_at": "2026-05-30T00:00:00+00:00"}

        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = sprint
        session.execute = AsyncMock(return_value=mock_result)

        with patch("app.repositories.sprint.SprintRepository.close", new_callable=AsyncMock) as mock_close:
            mock_close.return_value = closed

            async with client as c:
                resp = await c.post(f"/api/v2/sprints/{SPRINT_ID}/close")

        assert resp.status_code == 200
        data = resp.json()
        assert data["outcome_status"] == "hit"
    finally:
        app.dependency_overrides.clear()
