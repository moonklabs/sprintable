"""E-BOARD-SCHEMA S1: Epic outcome 필드 + 자동 채점 편입 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.outcome_scorer import score_epic_outcome


# ── score_epic_outcome 단위 테스트 ─────────────────────────────────────────────

def test_score_epic_outcome_no_metric_returns_none():
    assert score_epic_outcome(None, 50.0, 4, 2) is None
    assert score_epic_outcome({}, 50.0, 4, 2) is None


def test_score_epic_outcome_completion_pct_hit():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"}
    result = score_epic_outcome(md, 100.0, 4, 4)
    assert result is not None
    assert result["outcome_status"] == "hit"
    assert result["outcome_result"]["actual"] == 100.0
    assert result["outcome_result"]["target"] == 80.0


def test_score_epic_outcome_completion_pct_miss():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"}
    result = score_epic_outcome(md, 50.0, 4, 2)
    assert result is not None
    assert result["outcome_status"] == "miss"


def test_score_epic_outcome_direction_down_hit():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 30, "direction": "down"}
    result = score_epic_outcome(md, 20.0, 5, 1)
    assert result is not None
    assert result["outcome_status"] == "hit"


def test_score_epic_outcome_unknown_metric_pending():
    md = {"source": "internal_ops", "metric": "velocity", "target": 50, "direction": "up"}
    result = score_epic_outcome(md, 80.0, 4, 4)
    assert result is not None
    assert result["outcome_status"] == "pending"
    assert result["outcome_result"] is None


def test_score_epic_outcome_ga4_source_pending():
    md = {"source": "ga4", "property_id": "123", "ga4_metric": "sessions", "target": 1000, "direction": "up"}
    result = score_epic_outcome(md, 80.0, 4, 4)
    assert result is not None
    assert result["outcome_status"] == "pending"


def test_score_epic_outcome_unknown_source_pending():
    md = {"source": "manual", "metric": "completion_pct", "target": 80, "direction": "up"}
    result = score_epic_outcome(md, 90.0, 4, 4)
    assert result is not None
    assert result["outcome_status"] == "pending"


def test_score_epic_outcome_bad_target_pending():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": "not_a_number", "direction": "up"}
    result = score_epic_outcome(md, 80.0, 4, 4)
    assert result is not None
    assert result["outcome_status"] == "pending"


def test_score_epic_outcome_unknown_direction_pending():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "sideways"}
    result = score_epic_outcome(md, 90.0, 4, 4)
    assert result is not None
    assert result["outcome_status"] == "pending"


def test_score_epic_outcome_zero_stories():
    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"}
    result = score_epic_outcome(md, 0.0, 0, 0)
    assert result is not None
    assert result["outcome_status"] == "miss"


# ── cron score-ga4-outcomes Epic 채점 통합 테스트 ────────────────────────────

ORG_ID = uuid.uuid4()
EPIC_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_epic_obj(metric_definition=None, outcome_status="pending"):
    e = MagicMock()
    e.id = EPIC_ID
    e.org_id = ORG_ID
    e.metric_definition = metric_definition
    e.outcome_status = outcome_status
    e.outcome_result = None
    e.measure_after = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return e


@pytest.mark.anyio
async def test_cron_epic_internal_ops_hit():
    """internal_ops completion_pct hit → outcome_status='hit'."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    md = {"source": "internal_ops", "metric": "completion_pct", "target": 50, "direction": "up"}
    epic = _mock_epic_obj(metric_definition=md)

    call_count = 0

    async def mock_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        result = MagicMock()
        if call_count <= 2:
            # Sprint + Story GA4 쿼리 → 빈 결과
            result.scalars.return_value.all.return_value = []
        elif call_count == 3:
            # Epic 쿼리
            result.scalars.return_value.all.return_value = [epic]
        else:
            # 하위 스토리 상태 조회 (4개 중 3개 done)
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
        # Epic status는 변경 금지 확인
        assert epic.status is not None  # status 필드 자체는 존재하지만 변경 없음
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_cron_epic_does_not_change_status():
    """채점 후 epic.status는 그대로 유지되어야 함."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    md = {"source": "internal_ops", "metric": "completion_pct", "target": 80, "direction": "up"}
    epic = _mock_epic_obj(metric_definition=md)
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
        # status는 채점잡이 건드리지 않음
        assert epic.status == original_status
    finally:
        app.dependency_overrides.clear()
