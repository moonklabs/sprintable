"""story #3680(Trust·workforce, 페드루 PO 確定 2026-09-07) — GET /api/v2/agent-runs
`status`/`from`/`to` 필터 realdb 검증.

그라운딩(2026-09-07) — 이 엔드포인트가 지금껏 이 세 파라미터를 아예 안 받았다.
FastAPI가 미선언 쿼리를 조용히 버려 `?status=failed`가 200으로 completed 행을
그대로 돌려주는 "오타로 써도 통과하나" 클래스였다(별개로 FE `agent-runs-list.tsx`가
`project_id`를 애초에 안 보내던 게 실제 「0행」 근본원인 — 그건 FE 테스트 몫).

`status`는 `agent_runs_status_check`(alembic 0207) DB CHECK 7값을 Literal로
못박아 FastAPI가 불명값을 자동 422(신규 판정 로직 0).

세팅은 test_agent_runs_story_id_filter_realdb.py의 `_seed`/`_client_for`/
`_setup_app` 재사용(중복 재발명 금지, 이 파일과 동형 관례)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.anyio
async def test_status_filter_returns_only_matching_status():
    """_seed()의 project_a는 run_a1(completed)·run_a2(running) 하나씩 — status=running
    필터가 run_a2만 골라낸다(옛 결함이면 200으로 둘 다 돌아왔을 것)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/agent-runs?project_id={seeded['project_a_id']}&status=running"
            )
            assert resp.status_code == 200, resp.text
            ids = {r["id"] for r in resp.json()}
            assert ids == {str(seeded["run_a2_id"])}
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_status_unknown_value_rejected_422():
    """AC1 — 유효값 밖(오타·미지 값)은 조용히 삼키지 않고 422(FastAPI Literal 자동 판정)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/agent-runs?project_id={seeded['project_a_id']}&status=bogus"
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_from_to_filters_narrow_by_created_at():
    """from/to가 created_at 경계로 걸러낸다 — run_a1을 미래로 밀어 from으로 배제되는지,
    run_a2는 창 안에 남는지를 실측(고정 스냅샷이 아니라 실제 UPDATE로 시간축을 벌린다)."""
    from sqlalchemy import text

    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            # run_a1은 옛날(어제), run_a2는 방금(지금) — 창을 "오늘"로 좁히면 run_a1만 배제.
            yesterday = datetime.now(timezone.utc) - timedelta(days=1)
            await s.execute(
                text("UPDATE agent_runs SET created_at = :ts WHERE id = :id"),
                {"ts": yesterday, "id": seeded["run_a1_id"]},
            )
            await s.commit()

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            resp = await client.get(
                "/api/v2/agent-runs",
                params={"project_id": str(seeded["project_a_id"]), "from": today_start.isoformat()},
            )
            assert resp.status_code == 200, resp.text
            ids = {r["id"] for r in resp.json()}
            assert ids == {str(seeded["run_a2_id"])}, "from이 어제 run(run_a1)을 배제하지 못했다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_from_after_to_rejected_422():
    """입력 자체가 모순(from>to)이면 422 — 「빈 결과」로 조용히 넘기지 않는다."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/agent-runs?project_id={seeded['project_a_id']}"
                "&from=2026-09-07T00:00:00Z&to=2026-01-01T00:00:00Z"
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_status_filter_loses_narrowing(monkeypatch):
    """뮤테이션 — repo.list()가 status를 무시하면(옛 사각지대 재현) status=running 필터가
    completed 행까지 함께 돌려주는 것을 고정(이 필터가 실제로 쿼리에 반영된다는 증거)."""
    import app.repositories.agent_run as repo_mod

    original_list = repo_mod.AgentRunRepository.list

    async def _list_ignoring_status(self, *args, **kwargs):
        kwargs.pop("status", None)
        return await original_list(self, *args, **kwargs)

    monkeypatch.setattr(repo_mod.AgentRunRepository, "list", _list_ignoring_status)

    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/agent-runs?project_id={seeded['project_a_id']}&status=running"
            )
            assert resp.status_code == 200, resp.text
            ids = {r["id"] for r in resp.json()}
            assert ids == {str(seeded["run_a1_id"]), str(seeded["run_a2_id"])}, (
                "뮤테이션이 걸리지 않았다(status 필터가 여전히 완전 좁히고 있다)"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
