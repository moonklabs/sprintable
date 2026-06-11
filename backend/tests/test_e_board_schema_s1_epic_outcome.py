"""E-BOARD-SCHEMA S1: Epic outcome 필드 + 자동 채점 편입 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.outcome_scorer import score_epic_outcome


# ── score_epic_outcome 단위 테스트 ─────────────────────────────────────────────

def test_score_epic_outcome_no_metric_returns_none():
    assert score_epic_outcome(None, 50.0) is None
    assert score_epic_outcome({}, 50.0) is None


def test_score_epic_outcome_completion_pct_hit():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"}
    result = score_epic_outcome(md, 100.0)
    assert result is not None
    assert result["outcome_status"] == "hit"
    assert result["outcome_result"]["actual"] == 100.0
    assert result["outcome_result"]["target"] == 80.0


def test_score_epic_outcome_completion_pct_miss():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"}
    result = score_epic_outcome(md, 50.0)
    assert result is not None
    assert result["outcome_status"] == "miss"


def test_score_epic_outcome_direction_down_hit():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 30, "direction": "down"}
    result = score_epic_outcome(md, 20.0)
    assert result is not None
    assert result["outcome_status"] == "hit"


def test_score_epic_outcome_unknown_metric_pending():
    md = {"source": "internal_ops", "metric": "velocity", "target": 50, "direction": "up"}
    result = score_epic_outcome(md, 80.0)
    assert result is not None
    assert result["outcome_status"] == "pending"
    assert result["outcome_result"] is None


def test_score_epic_outcome_ga4_source_pending():
    md = {"source": "ga4", "property_id": "123", "ga4_metric": "sessions", "target": 1000, "direction": "up"}
    result = score_epic_outcome(md, 80.0)
    assert result is not None
    assert result["outcome_status"] == "pending"


def test_score_epic_outcome_unknown_source_pending():
    md = {"source": "manual", "metric": "completion_pct", "target": 80, "direction": "up"}
    result = score_epic_outcome(md, 90.0)
    assert result is not None
    assert result["outcome_status"] == "pending"


def test_score_epic_outcome_bad_target_pending():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": "not_a_number", "direction": "up"}
    result = score_epic_outcome(md, 80.0)
    assert result is not None
    assert result["outcome_status"] == "pending"


def test_score_epic_outcome_unknown_direction_pending():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "sideways"}
    result = score_epic_outcome(md, 90.0)
    assert result is not None
    assert result["outcome_status"] == "pending"


def test_score_epic_outcome_zero_pct_miss():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"}
    result = score_epic_outcome(md, 0.0)
    assert result is not None
    assert result["outcome_status"] == "miss"


# ── n_a→pending 전이 테스트 (create/update API 경로) ─────────────────────────

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
EPIC_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _base_epic_mock(outcome_status: str = "n_a") -> MagicMock:
    e = MagicMock()
    e.id = EPIC_ID
    e.org_id = ORG_ID
    e.project_id = PROJECT_ID
    e.assignee_id = None
    e.title = "Epic with intent"
    e.status = "active"
    e.priority = "medium"
    e.description = None
    e.objective = None
    e.success_criteria = None
    e.target_sp = None
    e.target_date = None
    e.success_hypothesis = "완료율 80% 달성"
    e.metric_definition = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"}
    e.measure_after = datetime(2026, 6, 1, tzinfo=timezone.utc)
    e.outcome_status = outcome_status
    e.outcome_result = None
    # E1 S8b: EpicResponse 신규 집계 필드 — MagicMock auto-attr ValidationError 방지.
    e.hypothesis_count = 0
    e.risky_status = None
    e.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    e.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return e


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


@pytest.mark.anyio
async def test_create_epic_with_intent_sets_pending():
    """create_epic에서 metric_definition+measure_after 선언 시 outcome_status=pending으로 전이."""
    mock_session = AsyncMock()
    client, app = await _make_client(mock_session)

    pending_epic = _base_epic_mock(outcome_status="pending")

    with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
        mock_create.return_value = pending_epic
        try:
            async with client as c:
                resp = await c.post("/api/v2/epics", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Epic with intent",
                    "metric_definition": {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"},
                    "measure_after": "2026-06-01T00:00:00Z",
                })
            assert resp.status_code == 201
            # create 호출 시 outcome_status="pending" 전달됐는지 검증
            call_kwargs = mock_create.call_args[1]
            assert call_kwargs.get("outcome_status") == "pending"
            assert call_kwargs.get("metric_definition") is not None
            assert call_kwargs.get("measure_after") is not None
        finally:
            app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_epic_without_intent_stays_na():
    """metric_definition 없이 create → outcome_status=n_a 유지."""
    mock_session = AsyncMock()
    client, app = await _make_client(mock_session)

    na_epic = _base_epic_mock(outcome_status="n_a")
    na_epic.metric_definition = None
    na_epic.measure_after = None

    with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
        mock_create.return_value = na_epic
        try:
            async with client as c:
                resp = await c.post("/api/v2/epics", json={
                    "project_id": str(PROJECT_ID),
                    "org_id": str(ORG_ID),
                    "title": "Epic without intent",
                })
            assert resp.status_code == 201
            call_kwargs = mock_create.call_args[1]
            assert call_kwargs.get("outcome_status") == "n_a"
        finally:
            app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_epic_intent_triggers_pending_transition():
    """update_epic에서 intent 완성 시 n_a→pending 전이."""
    mock_session = AsyncMock()
    client, app = await _make_client(mock_session)

    # 현재 에픽: metric_definition 없음(n_a)
    current = _base_epic_mock(outcome_status="n_a")
    current.metric_definition = None
    current.measure_after = None

    # 업데이트 후: pending으로 전이된 에픽
    updated = _base_epic_mock(outcome_status="pending")

    with patch("app.repositories.epic.EpicRepository.get", new_callable=AsyncMock) as mock_get, \
         patch("app.repositories.base.BaseRepository.update", new_callable=AsyncMock) as mock_update:
        mock_get.return_value = current
        mock_update.return_value = updated
        try:
            async with client as c:
                resp = await c.patch(f"/api/v2/epics/{EPIC_ID}", json={
                    "metric_definition": {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"},
                    "measure_after": "2026-06-01T00:00:00Z",
                })
            assert resp.status_code == 200
            # update 호출 시 outcome_status="pending" 포함됐는지 검증
            call_kwargs = mock_update.call_args[1]
            assert call_kwargs.get("outcome_status") == "pending"
        finally:
            app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_epic_does_not_downgrade_from_hit():
    """이미 hit인 에픽은 update로 pending 재전이 안 됨."""
    mock_session = AsyncMock()
    client, app = await _make_client(mock_session)

    current = _base_epic_mock(outcome_status="hit")
    updated = _base_epic_mock(outcome_status="hit")

    with patch("app.repositories.epic.EpicRepository.get", new_callable=AsyncMock) as mock_get, \
         patch("app.repositories.base.BaseRepository.update", new_callable=AsyncMock) as mock_update:
        mock_get.return_value = current
        mock_update.return_value = updated
        try:
            async with client as c:
                resp = await c.patch(f"/api/v2/epics/{EPIC_ID}", json={
                    "metric_definition": {"source": "internal_ops", "metric": "completion_pct", "target": 90, "direction": "up"},
                    "measure_after": "2026-07-01T00:00:00Z",
                })
            assert resp.status_code == 200
            # outcome_status는 업데이트 data에 포함되지 않음 (hit 유지)
            call_kwargs = mock_update.call_args[1]
            assert "outcome_status" not in call_kwargs
        finally:
            app.dependency_overrides.clear()


# ── cron score-ga4-outcomes Epic 채점 테스트 ─────────────────────────────────

def _pending_epic_obj(metric_definition=None):
    """cron 테스트용 — 이미 pending 상태인 에픽 (전이는 별도 테스트에서 검증)."""
    e = MagicMock()
    e.id = EPIC_ID
    e.org_id = ORG_ID
    e.metric_definition = metric_definition
    e.outcome_status = "pending"
    e.outcome_result = None
    e.measure_after = datetime(2026, 5, 1, tzinfo=timezone.utc)
    e.status = "active"
    return e


@pytest.mark.anyio
async def test_cron_epic_internal_ops_hit():
    """pending 에픽 + 하위 스토리 75% 완료 → completion_pct=75 → hit(target=50)."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    md = {"source": "internal_ops", "metric": "completion_pct", "target": 50, "direction": "up"}
    epic = _pending_epic_obj(metric_definition=md)
    original_status = epic.status

    call_count = 0

    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count <= 2:
            result.scalars.return_value.all.return_value = []
        elif call_count == 3:
            result.scalars.return_value.all.return_value = [epic]
        else:
            result.scalars.return_value.all.return_value = ["done", "done", "done", "backlog"]
        return result

    mock_session = AsyncMock()
    mock_session.execute = mock_execute
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post(
                "/api/v2/internal/cron/score-ga4-outcomes",
                headers={"Authorization": "Bearer "},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"]["total"] == 1
        assert body["data"]["scored"][0]["type"] == "epic"
        assert body["data"]["scored"][0]["outcome_status"] == "hit"
        # epic.status는 cron이 건드리지 않음
        assert epic.status == original_status
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_cron_epic_does_not_change_epic_status():
    """채점 후 epic.status(active/done 등)는 절대 변경되지 않음."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"}
    epic = _pending_epic_obj(metric_definition=md)
    epic.status = "active"

    call_count = 0

    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count <= 2:
            result.scalars.return_value.all.return_value = []
        elif call_count == 3:
            result.scalars.return_value.all.return_value = [epic]
        else:
            result.scalars.return_value.all.return_value = ["done", "done"]
        return result

    mock_session = AsyncMock()
    mock_session.execute = mock_execute
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            await c.post(
                "/api/v2/internal/cron/score-ga4-outcomes",
                headers={"Authorization": "Bearer "},
            )
        assert epic.status == "active"
    finally:
        app.dependency_overrides.clear()
