"""story 5040: POST /api/v2/sprints/{id}/cancel — 시작 안 한(planning) 스프린트만 접는 비파괴 길.

허용 여부는 도구 이름이 아니라 «스프린트 상태»로 서버가 강제한다: planning → closed(velocity 0·채점 없음),
active · review · closed 는 409 + 행 불변, 다른 project 의 sprint 는 close/activate 와 같이 403 + 행 불변.
실 Postgres(PARITY/ALEMBIC_DATABASE_URL) 필요."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e_security_sec_s8_cc_sprint_project_scope_realdb import (
    _client_for,
    _seed_base,
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


async def _seed_sprint(session, org_id, project_id, status, velocity=None):
    from app.models.pm import Sprint
    sprint = Sprint(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="Sprint",
        status=status, duration=14, velocity=velocity,
    )
    session.add(sprint)
    await session.commit()
    return sprint.id


async def _reload(Session, sprint_id):
    from sqlalchemy import select
    from app.models.pm import Sprint
    async with Session() as s:
        return (await s.execute(select(Sprint).where(Sprint.id == sprint_id))).scalar_one()


@pytest.mark.anyio
async def test_cancel_planning_sprint_closes_with_velocity_zero():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"], "planning")

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/sprints/{sprint_a}/cancel")
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "closed"
            assert resp.json()["velocity"] == 0
        finally:
            await client.aclose()

        reloaded = await _reload(Session, sprint_a)
        assert reloaded.status == "closed"
        assert reloaded.velocity == 0
        # discard 경로 — 한 번도 안 뛴 스프린트를 가설 채점하지 않는다.
        assert reloaded.outcome_status == "n_a"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("status,velocity", [("active", 7), ("review", 5), ("closed", 3)])
async def test_cancel_non_planning_sprint_409_row_unchanged(status, velocity):
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"], status, velocity)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/sprints/{sprint_a}/cancel")
            assert resp.status_code == 409, resp.text
            assert "planning" in resp.json()["error"]["message"]
        finally:
            await client.aclose()

        reloaded = await _reload(Session, sprint_a)
        assert reloaded.status == status, "planning 이 아닌 스프린트는 상태가 그대로여야 함"
        assert reloaded.velocity == velocity, "planning 이 아닌 스프린트는 velocity 가 그대로여야 함"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_cross_project_blocked_no_mutation():
    """close/activate 와 같은 project-scope 봉인 — 접근권 없는 project 의 planning sprint 는 접히지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_b = await _seed_sprint(s, seeded["org_id"], seeded["project_b_id"], "planning")

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/sprints/{sprint_b}/cancel")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()

        reloaded = await _reload(Session, sprint_b)
        assert reloaded.status == "planning", "무권한 project sprint가 접히면 안 됨"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("flip_to", ["active", "review"])
async def test_cancel_waits_on_concurrent_flip_then_409_row_untouched(flip_to):
    """codex BLOCKER 회귀 — 두 세션: A 가 행을 FOR UPDATE 로 쥐고 planning→active/review 로 바꾸는 동안 B 의 cancel 은
    잠금에서 기다리고, A 가 commit 한 뒤 «신선한» 행을 보고 409 를 돌려준다(잠금이 없으면 낡은 planning 을 보고 접어 버림)."""
    import asyncio

    from sqlalchemy import select
    from app.main import app
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"], "planning", velocity=None)

        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])

        holder = Session()
        try:
            # A: 행 잠금을 쥔다(아직 planning · 미커밋).
            locked = (await holder.execute(
                select(Sprint).where(Sprint.id == sprint_a).with_for_update()
            )).scalar_one()
            assert locked.status == "planning"

            client = _client_for(app)
            try:
                cancel_task = asyncio.create_task(client.post(f"/api/v2/sprints/{sprint_a}/cancel"))
                # B 가 잠금에서 막혀 있어야 한다(끝나면 안 됨).
                done, _ = await asyncio.wait({cancel_task}, timeout=1.5)
                assert not done, "cancel 이 행 잠금을 기다리지 않고 끝남(FOR UPDATE 없음)"

                # A: 동시 활성화/검토 전환을 커밋 → 잠금 해제.
                locked.status = flip_to
                locked.velocity = 11
                await holder.commit()

                resp = await asyncio.wait_for(cancel_task, timeout=15)
            finally:
                await client.aclose()
        finally:
            await holder.close()

        assert resp.status_code == 409, resp.text
        reloaded = await _reload(Session, sprint_a)
        assert reloaded.status == flip_to, "동시 전환된 스프린트는 접히면 안 됨"
        assert reloaded.velocity == 11, "velocity 가 0 으로 덮이면 안 됨"
        assert reloaded.outcome_status == "n_a"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _hypothesis_for(Session, seeded, sprint_id):
    """activate 게이트(생존 가설 ≥1)를 통과시키는 가설 링크 — 활성화 쪽이 «잠금 대기»까지 가려면 필요."""
    from datetime import datetime, timedelta, timezone
    from app.models.hypothesis import Hypothesis, HypothesisSprintLink
    async with Session() as s:
        hyp = Hypothesis(
            id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_a_id"], owner_member_id=uuid.uuid4(),
            statement="s", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
            measure_after=datetime.now(timezone.utc) + timedelta(days=14), status="proposed",
            human_accounting={}, gate_contract={},
        )
        s.add(hyp)
        await s.flush()
        s.add(HypothesisSprintLink(id=uuid.uuid4(), hypothesis_id=hyp.id, sprint_id=sprint_id, link_type="declared"))
        await s.commit()


@pytest.mark.anyio
async def test_activate_that_read_planning_before_cancel_commits_is_refused_and_row_stays_closed():
    """codex R2 HIGH 회귀 — A: planning 행을 FOR UPDATE 로 쥐고 접기(closed·velocity 0)를 아직 커밋하지 않음. 그 사이
    B 의 /activate 는 이미 planning 을 읽었고(라우트 앞단 비잠금 읽기) 잠금에서 기다린다. A commit 뒤 B 는 «신선한» closed 를 보고
    불법 전이로 거절돼야 한다(잠금 · 재검증이 없으면 id 만으로 UPDATE 해 closed 를 active 로 덮는다)."""
    import asyncio

    from sqlalchemy import select
    from app.main import app
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"], "planning", velocity=None)
        await _hypothesis_for(Session, seeded, sprint_a)
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])

        holder = Session()
        try:
            locked = (await holder.execute(
                select(Sprint).where(Sprint.id == sprint_a).with_for_update()
            )).scalar_one()
            assert locked.status == "planning"

            client = _client_for(app)
            try:
                activate_task = asyncio.create_task(client.post(f"/api/v2/sprints/{sprint_a}/activate"))
                done, _ = await asyncio.wait({activate_task}, timeout=1.5)
                assert not done, "activate 가 행 잠금을 기다리지 않고 끝남(transition_sprint 가 잠금 없이 읽음)"

                # A: 접기(planning→closed · velocity 0)를 커밋 → 잠금 해제.
                locked.status = "closed"
                locked.velocity = 0
                await holder.commit()

                resp = await asyncio.wait_for(activate_task, timeout=15)
            finally:
                await client.aclose()
        finally:
            await holder.close()

        assert 400 <= resp.status_code < 500, resp.text
        reloaded = await _reload(Session, sprint_a)
        assert reloaded.status == "closed", "접힌 스프린트가 동시 활성화로 active 로 덮이면 안 됨"
        assert reloaded.velocity == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_http_vs_activate_http_concurrent_one_wins_never_both():
    """실제 두 HTTP 요청이 겹쳐도 끝 상태는 «접힘(closed·0)» 또는 «활성(active)» 중 하나이고, 응답 성공은 정확히 그 승자 하나."""
    import asyncio

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"], "planning", velocity=None)
        await _hypothesis_for(Session, seeded, sprint_a)
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])

        client = _client_for(app)
        try:
            r_cancel, r_act = await asyncio.gather(
                client.post(f"/api/v2/sprints/{sprint_a}/cancel"),
                client.post(f"/api/v2/sprints/{sprint_a}/activate"),
            )
        finally:
            await client.aclose()

        reloaded = await _reload(Session, sprint_a)
        oks = [r.status_code == 200 for r in (r_cancel, r_act)]
        assert sum(oks) == 1, (r_cancel.text, r_act.text)
        if r_cancel.status_code == 200:
            assert reloaded.status == "closed" and reloaded.velocity == 0
        else:
            assert reloaded.status == "active"
            assert r_cancel.status_code == 409
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_after_activate_is_409_row_stays_active():
    """반대 순서 — 활성화가 먼저 끝났으면 cancel 은 409 이고 행은 active 그대로."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_base(s)
            sprint_a = await _seed_sprint(s, seeded["org_id"], seeded["project_a_id"], "planning", velocity=None)
        await _hypothesis_for(Session, seeded, sprint_a)
        await _setup_app(app, Session, seeded["human_user_id"], seeded["org_id"])

        client = _client_for(app)
        try:
            r_act = await client.post(f"/api/v2/sprints/{sprint_a}/activate")
            assert r_act.status_code == 200, r_act.text
            r_cancel = await client.post(f"/api/v2/sprints/{sprint_a}/cancel")
            assert r_cancel.status_code == 409, r_cancel.text
        finally:
            await client.aclose()

        reloaded = await _reload(Session, sprint_a)
        assert reloaded.status == "active"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
