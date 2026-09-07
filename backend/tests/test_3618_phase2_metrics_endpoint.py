"""story #3618(Phase2·BE+FE·실측) 조각② — GET .../insights/phase2-metrics HTTP
라우터. test_3502_insights_board_endpoints.py와 동형 관례(app.main 1회 import
비용 분리, 세팅 헬퍼는 test_3471_org_content_rules_lint.py 재사용)."""
from __future__ import annotations

import os

import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for,
    _seed_agent,
    _seed_org,
    _session_factory,
    _setup_org_scoped_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.anyio
async def test_get_phase2_metrics_endpoint_agent_200_all_unmeasured():
    """GET(read)이라 에이전트도 가능 — insights-board 라우터와 동형 권한 폭. 빈
    org이라 3종 다 「—」(reason_code 채워짐)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/insights/phase2-metrics", params={"days": 7})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["utm_attribution_rate"]["value"] is None
        assert body["utm_attribution_rate"]["reason_code"] == "NO_PAGEVIEWS"
        assert body["comment_miss_rate"]["reason_code"] == "NO_COMMENT_DATA"
        assert body["follow_up_creation_rate"]["reason_code"] == "NO_SNAPSHOTS"
        assert body["computed_at"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_phase2_metrics_endpoint_invalid_days_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/insights/phase2-metrics", params={"days": 14})
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "PHASE2_METRICS_INVALID_DAYS"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_phase2_metrics_endpoint_org_mismatch_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            other_org_id, _ = await _seed_org(s)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{other_org_id}/insights/phase2-metrics", params={"days": 7})
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
