"""story #4725d9c0(BE·Trust·라이브 결함, 유나 배포 53 라이브 발견) — workforce 실행 목록/상세
읽기 계약 2구멍, 실 PG.

① AgentRunResponse에 agent_name이 없어 목록 전 행이 「알 수 없는 에이전트」로 렌더됐다(서버는
agent_id로 실재 멤버를 아는데 응답에 이름을 안 실었다) — team_members 조인으로 채운다(additive,
못 찾으면 null).
② GET /agent-runs/{id}가 아예 없어(GET ""·POST ""·PATCH "/{id}"만 존재) 상세 화면이 405였다
(BFF는 이미 이 경로를 호출 중 — 구조적 미도달). PATCH와 동일 인가축(org 검증 후
has_project_access) — 존재하지 않거나 타org·무접근권은 전부 404.

세팅은 test_agent_runs_story_id_filter_realdb.py의 `_seed`/`_client_for`/`_setup_app` 재사용
(중복 재발명 금지, 이 파일과 동형 관례)."""
from __future__ import annotations

import os

import pytest

from tests.test_agent_runs_story_id_filter_realdb import (
    _client_for,
    _seed,
    _session_factory,
    _setup_app,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_list_fills_agent_name_from_team_members():
    """목록 응답의 각 행이 agent_id에 해당하는 실 멤버 이름을 싣는다(더 이상 「알 수 없는
    에이전트」로 값을 못 채우는 상태가 아니다)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs?project_id={seeded['project_a_id']}")
            assert resp.status_code == 200, resp.text
            rows = resp.json()
            assert len(rows) == 2
            assert all(r["agent_name"] == "Agent A" for r in rows)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_detail_returns_200_not_405_with_agent_name():
    """카디르 재현 — 이 엔드포인트가 없어 405였다. 신설 후 caller가 접근권 있는 project의
    run은 200 + agent_name까지 채워서 온다."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs/{seeded['run_a1_id']}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["id"] == str(seeded["run_a1_id"])
            assert body["agent_name"] == "Agent A"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_detail_cross_project_no_access_is_404():
    """PATCH와 동형 인가축 — caller는 project_a에만 접근권. project_b 소속 run(run_b1)을
    id로 직접 조회하면(같은 org라 org 검증만으론 안 걸림) 404(비노출, 403 아님)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs/{seeded['run_b1_id']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_detail_unknown_id_is_404():
    from app.main import app
    import uuid

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs/{uuid.uuid4()}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_get_route_reproduces_405(monkeypatch):
    """뮤테이션 표적 — get_agent_run이 실제로 app에 라우팅되고 있다는 증거. include_router가
    이미 app.routes에 route 객체를 이식해 둔 뒤라(자식 router.routes를 나중에 고쳐도 app은
    안 흔들린다), app.router.routes 자체에서 이 GET route를 지워야 405 사각지대가 재현된다."""
    from app.main import app

    original_routes = list(app.router.routes)
    app.router.routes = [
        r for r in original_routes
        if not (getattr(r, "path", None) == "/api/v2/agent-runs/{id}" and "GET" in getattr(r, "methods", set()))
    ]
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/agent-runs/{seeded['run_a1_id']}")
            assert resp.status_code == 405, resp.text
        finally:
            await client.aclose()
    finally:
        app.router.routes = original_routes
        app.dependency_overrides.clear()
        await engine.dispose()
