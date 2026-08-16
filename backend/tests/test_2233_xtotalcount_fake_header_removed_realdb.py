"""story #2233([결함] X-Total-Count가 len(items) 위조값) — PO 판정 ㉢(2026-08-16) 회귀 가드.

그라운딩(judgment efdeeb8c) 결론: X-Total-Count를 싣는 엔드포인트는 전수 4곳뿐 —
goals.py(2곳)·stories.py(2곳)는 이미 `func.count().select_from(...)`(필터 後·limit 前)
실 COUNT였다(양성대조). hypotheses.py·loops.py 2곳만 `len(items)`(이 페이지에 온 개수)를
"전체"라 위조하고 있었는데, FE+MCP 전수 확인 결과 **아무도 안 읽는 값**이었다(FE
`/api/hypotheses` 프록시는 raw passthrough가 아니라 서비스 재구성이라 헤더 자체가
브라우저까지 안 감·`/api/loops`는 raw passthrough라 브라우저까진 가지만 유일 소비자
loops-client.tsx가 res.json()만 읽음·MCP 둘 다 headers 참조 0). PO 판정: 헤더를 그냥
뺀다(has_more/cursor 인프라는 실사용자 생기면 그때 그 화면과 같이 설계 — 미리 안 지음).

AC6(회귀 가드) 두 축:
  ①hypotheses·loops가 X-Total-Count를 다시 싣지 않는다(헤더 부재 자체를 pin).
  ②살아있는 4곳(goals·stories)은 limit을 넘는 데이터에서 헤더 값이 len(items)와
    달라야 한다(진짜 COUNT라는 실증 — «헤더가 len(items)와 같아지면 실패»하는 형태).
    stories.py 쪽은 이미 test_2537_unattached_generic_xtotalcount_realdb.py(제네릭 분기)·
    test_2532_hypothesis_goal_attachment_realdb.py(board 분기)가 이 정확한 모양으로
    고정해 뒀다(재검증 안 함, 여기선 goals.py만 추가 — 기존엔 그 축이 없었다).

AC7: goals.py/stories.py 소스는 이 스토리에서 무변경(이미 진짜라 손 안 댐) — 위 judgment에
근거 기록.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


# ─── ① hypotheses/loops — 헤더 부재 pin(mock 기반, 라우터 레벨 — svc는 실동작 무관) ──

async def _mock_client(*, org_id: uuid.UUID):
    from app.dependencies.auth import get_current_user
    from app.main import app
    from tests.conftest import override_db_and_read

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(org_id)}}
    mock_session = AsyncMock()

    async def _db():
        yield mock_session

    async def _user():
        return ctx

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _user
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


async def test_hypotheses_list_no_longer_sets_x_total_count_header():
    from app.dependencies.auth import get_project_scoped_org_id

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    now = datetime(2026, 7, 15, tzinfo=timezone.utc)
    fake_hyp = {
        "id": str(uuid.uuid4()), "org_id": str(org_id), "project_id": str(project_id),
        "owner_member_id": str(uuid.uuid4()), "statement": "s",
        "metric_definition": {"metric": "x", "source": "manual", "target": 1, "direction": "up"},
        "measure_after": now.isoformat(), "status": "proposed",
        "human_accounting": {}, "gate_contract": {},
        "created_at": now.isoformat(), "updated_at": now.isoformat(),
    }
    client, app = await _mock_client(org_id=org_id)
    try:
        app.dependency_overrides[get_project_scoped_org_id] = lambda: org_id
        from app.schemas.hypothesis import HypothesisResponse
        with patch(
            "app.routers.hypotheses.svc.list_hypotheses",
            new=AsyncMock(return_value=[HypothesisResponse.model_validate(fake_hyp)]),
        ):
            async with client as c:
                resp = await c.get(f"/api/v2/hypotheses?project_id={project_id}")
        assert resp.status_code == 200, resp.text
        assert "x-total-count" not in {k.lower() for k in resp.headers}, (
            f"hypotheses list가 X-Total-Count를 다시 싣는다(#2233 회귀): {dict(resp.headers)}"
        )
    finally:
        app.dependency_overrides.clear()


async def test_loops_list_no_longer_sets_x_total_count_header():
    from app.dependencies.auth import get_project_scoped_org_id

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    now = datetime(2026, 7, 15, tzinfo=timezone.utc)
    fake_loop = {
        "id": str(uuid.uuid4()), "org_id": str(org_id), "project_id": str(project_id),
        "title": "t", "status": "draft", "goal_tags": [],
        "created_by_member_id": str(uuid.uuid4()),
        "created_at": now.isoformat(), "updated_at": now.isoformat(),
    }
    client, app = await _mock_client(org_id=org_id)
    try:
        app.dependency_overrides[get_project_scoped_org_id] = lambda: org_id
        from app.schemas.loop import LoopResponse
        with patch(
            "app.routers.loops.svc.list_loops",
            new=AsyncMock(return_value=[LoopResponse.model_validate(fake_loop)]),
        ):
            async with client as c:
                resp = await c.get(f"/api/v2/loops?project_id={project_id}")
        assert resp.status_code == 200, resp.text
        assert "x-total-count" not in {k.lower() for k in resp.headers}, (
            f"loops list가 X-Total-Count를 다시 싣는다(#2233 회귀): {dict(resp.headers)}"
        )
    finally:
        app.dependency_overrides.clear()


# ─── ② goals.py — 살아있는 진짜 COUNT의 회귀 가드(limit 넘는 데이터, header != len(items)) ──

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")


@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_goals_list_x_total_count_differs_from_len_items_when_truncated_realdb():
    """goals.py의 X-Total-Count가 진짜 COUNT라는 실증 — limit=1보다 목표가 많을 때 바디는
    1건이지만 헤더는 실제 전체 건수(3)여야 한다(stories.py test_2537의 동형 원칙).
    이 테스트가 «헤더가 len(items)로 되돌아가면» 정확히 실패한다(회귀 가드 본질)."""
    from tests.test_1994_backlink_api_realdb import (
        _client_for, _make_human_member, _make_org, _make_project, _session_factory,
    )
    from app.models.pm import Goal

    async def _setup_app_human_with_read(app, Session, user_id, org_id):
        # test_1994._setup_app_human은 get_read_db를 안 건다(story #2451 이전 헬퍼,
        # grandfathered) — goals.py list_goals는 _get_repo_read(get_read_db 의존)라
        # 그 헬퍼를 그대로 쓰면 실 기본 엔진(port 54322)으로 새 버린다. override_db_and_read
        # (get_db+get_read_db 동시 오버라이드)로 직접 건다.
        from app.dependencies.auth import AuthContext, get_current_user
        from tests.conftest import override_db_and_read

        async def _db():
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        async def _auth():
            return AuthContext(
                user_id=str(user_id), email="human@test",
                claims={"app_metadata": {"org_id": str(org_id)}},
            )

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            for title in ("g1", "g2", "g3"):
                s.add(Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title=title))
            await s.commit()

        from app.main import app
        await _setup_app_human_with_read(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/goals?project_id={project.id}&limit=1")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body) == 1
            assert resp.headers.get("x-total-count") == "3", (
                f"바디는 limit=1로 잘려도 헤더는 필터 後 전체(3)여야 하는데 "
                f"{resp.headers.get('x-total-count')!r} (len(items)={len(body)}와 같아지면 회귀)"
            )
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
