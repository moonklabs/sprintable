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
    # E-BOARD-SCHEMA S4: 신규 2필드
    s.goal = None
    s.capacity = None
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
    # E-DG S26: activate 가 transition_sprint(active) 단일경로 경유 → 200 검증. transition_sprint 내부
    # (FSM·overlay·1-active 위임)는 test_edg_s26 가 커버. 엔드포인트 계약(routing+200)만 단정.
    from app.services.member_resolver import ResolvedMember
    client, session, app = await _client()
    try:
        active_sprint = _mock_sprint("active")
        caller = ResolvedMember(
            id=uuid.uuid4(), user_id=None, name="h", type="human", role="member", org_id=ORG_ID)
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = active_sprint
        session.execute = AsyncMock(return_value=mock_result)
        with patch("app.services.sprint.transition_sprint", AsyncMock(return_value=active_sprint)), \
             patch("app.services.member_resolver.resolve_member", AsyncMock(return_value=caller)):
            async with client as c:
                resp = await c.post(f"/api/v2/sprints/{SPRINT_ID}/activate")
        assert resp.status_code == 200
        assert resp.json()["status"] == "active"
    finally:
        app.dependency_overrides.clear()


# ── close ─────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_close_sprint_200():
    # E-DG S26: close 가 transition_sprint(closed) 단일경로 경유 → 200 검증. velocity/notification 로직
    # 보존. transition_sprint 내부(repo.close 위임·active|review 수용)는 test_edg_s26 커버.
    from app.services.member_resolver import ResolvedMember
    client, session, app = await _client()
    try:
        closed_sprint = _mock_sprint("closed")
        closed_sprint.velocity = 10
        caller = ResolvedMember(
            id=uuid.uuid4(), user_id=None, name="h", type="human", role="member", org_id=ORG_ID)
        # notification 분기: TeamMember 조회 빈 결과(멤버 0 → dispatch 없음·contract만 검증).
        _empty = MagicMock()
        _empty.all.return_value = []
        session.execute = AsyncMock(return_value=_empty)
        with patch("app.services.sprint.transition_sprint", AsyncMock(return_value=closed_sprint)), \
             patch("app.services.member_resolver.resolve_member", AsyncMock(return_value=caller)):
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

_V = 0  # velocity placeholder
_B = 0  # backlog_remaining placeholder
_T = 0  # total_points placeholder


class TestScoreSprintOutcome:
    """outcome_scorer.score_sprint_outcome 단위 테스트 (metric 이름 ↔ actual 분기 포함)."""

    def test_no_metric_definition_returns_none(self):
        """metric_definition 없음 → None (n_a 유지)."""
        assert score_sprint_outcome(None, 30, 5, 100) is None
        assert score_sprint_outcome({}, 30, 5, 100) is None

    def test_external_source_returns_pending(self):
        """external source(ga4/manual) → pending."""
        for src in ("ga4", "manual"):
            r = score_sprint_outcome(
                {"source": src, "metric": "velocity", "target": 100, "direction": "up"},
                velocity=50, backlog_remaining=2, total_points=100,
            )
            assert r is not None
            assert r["outcome_status"] == "pending"
            assert r["outcome_result"] is None

    def test_unknown_metric_returns_pending(self):
        """지원하지 않는 metric → pending (오채점 차단)."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "custom_metric", "target": 50, "direction": "up"},
            velocity=60, backlog_remaining=0, total_points=100,
        )
        assert r is not None
        assert r["outcome_status"] == "pending"

    # ── velocity metric ──────────────────────────────────────────────────────

    def test_velocity_up_hit(self):
        """metric=velocity, direction='up', actual >= target → hit."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "velocity", "target": 30, "direction": "up"},
            velocity=30, backlog_remaining=0, total_points=30,
        )
        assert r is not None
        assert r["outcome_status"] == "hit"
        assert r["outcome_result"]["actual"] == 30.0
        assert r["outcome_result"]["metric"] == "velocity"

    def test_velocity_up_miss(self):
        """metric=velocity, direction='up', actual < target → miss."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "velocity", "target": 50, "direction": "up"},
            velocity=30, backlog_remaining=0, total_points=50,
        )
        assert r is not None
        assert r["outcome_status"] == "miss"

    def test_velocity_boundary_exact_target_is_hit(self):
        """경계값: velocity == target, direction='up' → hit."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "velocity", "target": 42, "direction": "up"},
            velocity=42, backlog_remaining=0, total_points=42,
        )
        assert r is not None
        assert r["outcome_status"] == "hit"

    def test_zero_velocity_miss(self):
        """velocity=0, direction='up', target>0 → miss."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "velocity", "target": 10, "direction": "up"},
            velocity=0, backlog_remaining=5, total_points=10,
        )
        assert r is not None
        assert r["outcome_status"] == "miss"

    # ── backlog_remaining metric ─────────────────────────────────────────────

    def test_backlog_remaining_down_hit(self):
        """metric=backlog_remaining, direction='down', backlog<=target → hit."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "backlog_remaining", "target": 3, "direction": "down"},
            velocity=20, backlog_remaining=2, total_points=25,
        )
        assert r is not None
        assert r["outcome_status"] == "hit"
        assert r["outcome_result"]["actual"] == 2.0
        assert r["outcome_result"]["metric"] == "backlog_remaining"

    def test_backlog_remaining_down_miss(self):
        """metric=backlog_remaining, direction='down', backlog>target → miss."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "backlog_remaining", "target": 0, "direction": "down"},
            velocity=20, backlog_remaining=1, total_points=25,
        )
        assert r is not None
        assert r["outcome_status"] == "miss"
        assert r["outcome_result"]["actual"] == 1.0

    def test_backlog_remaining_dogfood_zero_target(self):
        """dogfood: backlog_remaining=0 → target=0, down → hit."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "backlog_remaining", "target": 0, "direction": "down"},
            velocity=30, backlog_remaining=0, total_points=30,
        )
        assert r is not None
        assert r["outcome_status"] == "hit"

    def test_backlog_remaining_does_not_use_velocity(self):
        """backlog_remaining metric은 velocity가 아닌 backlog_remaining을 actual로 사용."""
        # velocity=999 지만 backlog_remaining=5 → target=3 초과 → miss
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "backlog_remaining", "target": 3, "direction": "down"},
            velocity=999, backlog_remaining=5, total_points=999,
        )
        assert r is not None
        assert r["outcome_status"] == "miss"
        assert r["outcome_result"]["actual"] == 5.0

    # ── progress metric ──────────────────────────────────────────────────────

    def test_progress_up_hit(self):
        """metric=progress, direction='up', progress>=target → hit."""
        # velocity=80 / total_points=100 → progress=80.0
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "progress", "target": 80, "direction": "up"},
            velocity=80, backlog_remaining=2, total_points=100,
        )
        assert r is not None
        assert r["outcome_status"] == "hit"
        assert r["outcome_result"]["actual"] == 80.0

    def test_progress_zero_total_points(self):
        """total_points=0 → progress=0.0, target>0 → miss (zero division safe)."""
        r = score_sprint_outcome(
            {"source": "internal_ops", "metric": "progress", "target": 50, "direction": "up"},
            velocity=0, backlog_remaining=0, total_points=0,
        )
        assert r is not None
        assert r["outcome_status"] == "miss"
        assert r["outcome_result"]["actual"] == 0.0

    # ── output 필드 ──────────────────────────────────────────────────────────

    def test_outcome_result_contains_required_fields(self):
        """outcome_result에 metric·target·actual·direction·scored_at 포함."""
        md = {"source": "internal_ops", "metric": "velocity", "target": 20, "direction": "up"}
        r = score_sprint_outcome(md, velocity=25, backlog_remaining=0, total_points=25)
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


# ── E-OUTCOME-LOOP S5: GA4 채점 테스트 ───────────────────────────────────────

from app.services.outcome_scorer import score_ga4_outcome


class TestScoreGa4Outcome:
    """score_ga4_outcome 단위 테스트 (GA4 클라이언트 mock)."""

    def test_ga4_hit_when_actual_ge_target(self):
        """GA4 회수값 >= target, direction='up' → hit."""
        md = {
            "source": "ga4", "metric": "MAU", "target": 1000, "direction": "up",
            "property_id": "291556226", "ga4_metric": "activeUsers", "date_range_days": 30,
        }
        with patch("app.services.ga4_client.fetch_ga4_metric", return_value=1500.0):
            r = score_ga4_outcome(md)
        assert r["outcome_status"] == "hit"
        assert r["outcome_result"]["actual"] == 1500.0
        assert r["outcome_result"]["metric"] == "MAU"

    def test_ga4_miss_when_actual_lt_target(self):
        """GA4 회수값 < target, direction='up' → miss."""
        md = {
            "source": "ga4", "metric": "MAU", "target": 1000, "direction": "up",
            "property_id": "291556226", "ga4_metric": "activeUsers", "date_range_days": 30,
        }
        with patch("app.services.ga4_client.fetch_ga4_metric", return_value=800.0):
            r = score_ga4_outcome(md)
        assert r["outcome_status"] == "miss"

    def test_ga4_down_hit(self):
        """GA4 회수값 <= target, direction='down' → hit."""
        md = {
            "source": "ga4", "metric": "bounce", "target": 50, "direction": "down",
            "property_id": "291556226", "ga4_metric": "sessions", "date_range_days": 7,
        }
        with patch("app.services.ga4_client.fetch_ga4_metric", return_value=40.0):
            r = score_ga4_outcome(md)
        assert r["outcome_status"] == "hit"

    def test_ga4_fetch_failure_returns_pending(self):
        """GA4 회수 실패(None) → pending (인증 불가 등)."""
        md = {
            "source": "ga4", "metric": "MAU", "target": 1000, "direction": "up",
            "property_id": "291556226", "ga4_metric": "activeUsers", "date_range_days": 30,
        }
        with patch("app.services.ga4_client.fetch_ga4_metric", return_value=None):
            r = score_ga4_outcome(md)
        assert r["outcome_status"] == "pending"
        assert r["outcome_result"] is None

    def test_ga4_boundary_exact_target(self):
        """경계값: actual == target, direction='up' → hit."""
        md = {
            "source": "ga4", "metric": "users", "target": 500, "direction": "up",
            "property_id": "291556226", "ga4_metric": "newUsers", "date_range_days": 14,
        }
        with patch("app.services.ga4_client.fetch_ga4_metric", return_value=500.0):
            r = score_ga4_outcome(md)
        assert r["outcome_status"] == "hit"


class TestGa4MetricDefinitionValidation:
    """GA4 metric_definition 구조 검증 테스트."""

    def _validate(self, v):
        from app.schemas.story import _validate_metric_definition
        return _validate_metric_definition(v)

    def test_ga4_valid_passes(self):
        """GA4 필수 필드 모두 있으면 통과."""
        md = {
            "source": "ga4", "metric": "MAU", "target": 1000, "direction": "up",
            "property_id": "291556226", "ga4_metric": "activeUsers", "date_range_days": 30,
        }
        assert self._validate(md) is not None

    def test_ga4_missing_property_id_raises(self):
        """property_id 없으면 ValueError."""
        md = {
            "source": "ga4", "metric": "MAU", "target": 1000, "direction": "up",
            "ga4_metric": "activeUsers", "date_range_days": 30,
        }
        with pytest.raises(ValueError, match="property_id"):
            self._validate(md)

    def test_ga4_unknown_metric_raises(self):
        """지원하지 않는 ga4_metric → ValueError (garbage-in 차단)."""
        md = {
            "source": "ga4", "metric": "m", "target": 10, "direction": "up",
            "property_id": "123", "ga4_metric": "customBadMetric", "date_range_days": 30,
        }
        with pytest.raises(ValueError, match="ga4_metric"):
            self._validate(md)

    def test_ga4_invalid_date_range_days_raises(self):
        """date_range_days <= 0 → ValueError."""
        md = {
            "source": "ga4", "metric": "m", "target": 10, "direction": "up",
            "property_id": "123", "ga4_metric": "activeUsers", "date_range_days": 0,
        }
        with pytest.raises(ValueError, match="date_range_days"):
            self._validate(md)

    def test_ga4_source_in_score_sprint_returns_pending(self):
        """close() 호출 시 GA4 source → pending (지연 채점 cron으로)."""
        md = {
            "source": "ga4", "metric": "MAU", "target": 1000, "direction": "up",
            "property_id": "291556226", "ga4_metric": "activeUsers", "date_range_days": 30,
        }
        r = score_sprint_outcome(md, velocity=30, backlog_remaining=0, total_points=30)
        assert r is not None
        assert r["outcome_status"] == "pending"


# ── E-BOARD-SCHEMA S4: goal/capacity round-trip 테스트 ────────────────────────

@pytest.mark.anyio
async def test_create_sprint_with_goal_capacity_201():
    """sprint create 시 goal·capacity 필드가 라우터→repo.create까지 실제 전달됨을 검증."""
    sprint = _mock_sprint()
    sprint.goal = "유저 온보딩 플로우 완성"
    sprint.capacity = 40

    client, session, app = await _client()
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = sprint
            async with client as c:
                resp = await c.post("/api/v2/sprints", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Sprint 1",
                    "goal": "유저 온보딩 플로우 완성",
                    "capacity": 40,
                })
        assert resp.status_code == 201
        assert resp.json()["goal"] == "유저 온보딩 플로우 완성"
        assert resp.json()["capacity"] == 40
        # 라우터가 실제로 goal/capacity를 repo.create에 전달했는지 검증
        call_kwargs = mock_create.call_args[1]
        assert call_kwargs.get("goal") == "유저 온보딩 플로우 완성"
        assert call_kwargs.get("capacity") == 40
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_sprint_goal_capacity_200():
    """sprint update 시 goal·capacity 업데이트 검증."""
    updated = _mock_sprint()
    updated.goal = "API 안정화"
    updated.capacity = 30

    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = updated
        session.execute = AsyncMock(return_value=mock_result)
        with patch("app.repositories.base.BaseRepository.update", new_callable=AsyncMock) as mock_update, \
             patch("app.services.project_auth.has_project_access", new=AsyncMock(return_value=True)):
            mock_update.return_value = updated
            async with client as c:
                resp = await c.patch(f"/api/v2/sprints/{SPRINT_ID}", json={
                    "goal": "API 안정화",
                    "capacity": 30,
                })
        assert resp.status_code == 200
        assert resp.json()["goal"] == "API 안정화"
        assert resp.json()["capacity"] == 30
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_sprint_goal_independent_from_success_hypothesis():
    """goal(실행목표)과 success_hypothesis(효과가설)가 독립 필드임을 검증."""
    sprint = _mock_sprint()
    sprint.goal = "온보딩 완성"
    sprint.success_hypothesis = "DAU 20% 증가 기대"
    sprint.capacity = 35

    client, session, app = await _client()
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = sprint
            async with client as c:
                resp = await c.post("/api/v2/sprints", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Sprint 1",
                    "goal": "온보딩 완성",
                    "success_hypothesis": "DAU 20% 증가 기대",
                    "capacity": 35,
                })
        assert resp.status_code == 201
        body = resp.json()
        assert body["goal"] == "온보딩 완성"
        assert body["success_hypothesis"] == "DAU 20% 증가 기대"
        assert body["goal"] != body["success_hypothesis"]
        assert body["capacity"] == 35
    finally:
        app.dependency_overrides.clear()
