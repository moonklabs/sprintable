"""story #2542(v4 «가설 축척» ②첫 가설, 유나 SSOT ae75a8ff) — guided 3부 폼(statement·
metric·target·direction) → 가설 생성·status=measuring까지 1콜을 실PG로 검증한다.

_CREATE_STATUSES는 그대로(proposed|active만) — measuring은 create_hypothesis(active,
게이트 오버레이 없음) → transition_hypothesis(active→measuring, 단순 전이) 두 단계
합성으로 도달한다. 이 파일은 그 합성이 실제로 끝까지 도는지 pin한다."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_org,
    _make_project,
    _session_factory,
)
from tests.test_2288_command_center_gate_type_waiting_realdb import (
    _make_member,
    _setup_app_human,
)
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def test_guided_create_reaches_measuring_with_manual_source_realdb():
    """⭐핵심 — guided 3부만 보내면 status=measuring까지 도달·source는 서버가 "manual"로
    보완·measure_after는 서버 기본값(+14일 근방)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _caller_id, caller_user_id = await _make_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/hypotheses/guided",
                json={
                    "project_id": str(project.id),
                    "statement": "리뷰 에이전트를 붙이면 결함이 준다",
                    "metric": "결함 건수",
                    "target": 5,
                    "direction": "down",
                },
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["status"] == "measuring"
            assert body["statement"] == "리뷰 에이전트를 붙이면 결함이 준다"
            assert body["metric_definition"] == {
                "metric": "결함 건수", "source": "manual", "target": 5.0, "direction": "down",
            }
            measure_after = datetime.fromisoformat(body["measure_after"])
            expected = datetime.now(UTC) + timedelta(days=14)
            assert abs((measure_after - expected).total_seconds()) < 60, (
                f"measure_after가 +14일 기본값과 어긋난다: {measure_after}"
            )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_guided_create_rejects_invalid_direction_realdb():
    """AC — direction이 up/down이 아니면 422(스키마 레벨 거부, 서비스까지 안 감)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _caller_id, caller_user_id = await _make_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/hypotheses/guided",
                json={
                    "project_id": str(project.id),
                    "statement": "S",
                    "metric": "M",
                    "target": 1,
                    "direction": "increase",  # up/down 아님
                },
            )
            assert resp.status_code == 422, resp.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_guided_create_rejects_agent_caller_realdb():
    """AC — guided 생성은 휴먼 전용(빈 지도 초대는 사람 온보딩 흐름) — agent caller는
    HUMAN_ONLY로 거부. `_setup_app_agent`(api_key_id 클레임)로 is_api_key 분기를 태운다
    (bare AuthContext.user_id만으론 legacy resolver가 human으로 fail-closed 취급 —
    실측으로 확認됨, actor_type fail-closed 관례와 동형)."""
    from app.main import app
    from tests.test_1994_backlink_api_realdb import _make_agent_member, _setup_app_agent

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_agent = await _make_agent_member(s, org.id, project.id)

        await _setup_app_agent(app, Session, caller_agent, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/hypotheses/guided",
                json={
                    "project_id": str(project.id),
                    "statement": "S", "metric": "M", "target": 1, "direction": "up",
                },
            )
            assert resp.status_code == 403, resp.text
            assert resp.json()["error"]["code"] == "HUMAN_ONLY"
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
