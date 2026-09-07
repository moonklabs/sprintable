"""story #3685(Trust·customer-zero, 페드루 PO 確定 2026-09-07) — 에이전트 run을 "지침"이
아니라 "메커니즘"으로 기록한다. claim_story/in-progress 전이에서 자동 시작, in-review/
done 전이·unclaim에서 자동 종료 realdb 검증.

3683 그라운딩 — run 생성 경로는 전수 1곳(POST /api/v2/agent-runs)뿐이고 fleet 아무도
착수/PR/완료 어디서도 그 경로(MCP emit_event/update_run_status)를 부른 적이 없었다.
이 스토리는 코드가 아니라 지침 의존이던 그 배선을 claim_story/status 전이 훅으로
대체한다 — 여기서는 그 훅들이 실제로 agent_runs 행을 쓰는지 HTTP 계층째로 검증한다.

세팅은 test_2266_story_backlinks_realdb.py(_session_factory/_client_for)·
test_agent_runs_story_id_filter_realdb.py(Member type="agent" + ProjectAccess 시드
패턴) 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select

from tests.test_2266_story_backlinks_realdb import _client_for, _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

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


async def _seed(session):
    """org+project+agent(team_member)+story. participation 기본 role도 심어(claim_story의
    ensure_implementation_participation이 best-effort로 스킵돼도 이 스토리의 관심사(run)와
    무관 — 그래도 실물과 같은 모양으로 시드해 둔다)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.participation import ParticipationRole
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.flush()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    ))
    session.add(ParticipationRole(
        id=uuid.uuid4(), org_id=org.id, key="implementation", label="구현", is_default=True,
    ))
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="backlog")
    session.add(story)
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id, "story_id": story.id}


async def _setup_app_agent(app, Session, agent_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

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
            user_id=str(agent_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-key"}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _agent_runs_for(session, *, agent_id, story_id):
    from app.models.agent_run import AgentRun

    return list((await session.execute(
        select(AgentRun).where(AgentRun.agent_id == agent_id, AgentRun.story_id == story_id)
    )).scalars().all())


@pytest.mark.anyio
async def test_claim_story_creates_running_agent_run():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/team-members/{seeded['agent_id']}/claim",
                json={"story_id": str(seeded["story_id"])},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            runs = await _agent_runs_for(s, agent_id=seeded["agent_id"], story_id=seeded["story_id"])
            assert len(runs) == 1
            assert runs[0].status == "running"
            assert runs[0].finished_at is None
            assert runs[0].project_id == seeded["project_id"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_status_to_in_review_closes_run_as_completed():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            claim_resp = await client.post(
                f"/api/v2/team-members/{seeded['agent_id']}/claim",
                json={"story_id": str(seeded["story_id"])},
            )
            assert claim_resp.status_code == 200, claim_resp.text
            # 착수 표시 — claim만으로는 story.status가 안 바뀐다(3414b6d7 결정, board 무변경).
            for target in ("in-progress", "in-review"):
                status_resp = await client.patch(
                    f"/api/v2/stories/{seeded['story_id']}/status", json={"status": target},
                )
                assert status_resp.status_code == 200, status_resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            runs = await _agent_runs_for(s, agent_id=seeded["agent_id"], story_id=seeded["story_id"])
            assert len(runs) == 1
            assert runs[0].status == "completed"
            assert runs[0].finished_at is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reclaim_does_not_duplicate_run():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            for _ in range(2):
                resp = await client.post(
                    f"/api/v2/team-members/{seeded['agent_id']}/claim",
                    json={"story_id": str(seeded["story_id"])},
                )
                assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            runs = await _agent_runs_for(s, agent_id=seeded["agent_id"], story_id=seeded["story_id"])
            assert len(runs) == 1, "재claim이 중복 run을 냈다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_preexisting_emit_event_run_deduped_by_claim():
    """emit_event(MCP)로 이미 만들어진 열린 run이 있으면 claim_story가 새로 안 만든다 —
    (agent_id, story_id)+finished_at IS NULL 축이 두 생성 경로를 하나로 묶는다."""
    from datetime import datetime, timedelta, timezone

    from app.main import app
    from app.models.agent_run import AgentRun

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            # emit_event가 직접 만든 것과 동형 — trigger="manual"(POST /api/v2/agent-runs 기본값).
            pre_existing = AgentRun(
                id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                agent_id=seeded["agent_id"], story_id=seeded["story_id"], trigger="manual",
                status="running", deadline_at=datetime.now(timezone.utc) + timedelta(hours=1),
            )
            s.add(pre_existing)
            await s.commit()
            pre_existing_id = pre_existing.id

        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/team-members/{seeded['agent_id']}/claim",
                json={"story_id": str(seeded["story_id"])},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            runs = await _agent_runs_for(s, agent_id=seeded["agent_id"], story_id=seeded["story_id"])
            assert len(runs) == 1, "emit_event 선행 run과 claim_story가 중복을 냈다"
            assert runs[0].id == pre_existing_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unclaim_marks_run_abandoned():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            claim_resp = await client.post(
                f"/api/v2/team-members/{seeded['agent_id']}/claim",
                json={"story_id": str(seeded["story_id"])},
            )
            assert claim_resp.status_code == 200, claim_resp.text
            unclaim_resp = await client.post(f"/api/v2/team-members/{seeded['agent_id']}/unclaim")
            assert unclaim_resp.status_code == 200, unclaim_resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            runs = await _agent_runs_for(s, agent_id=seeded["agent_id"], story_id=seeded["story_id"])
            assert len(runs) == 1
            assert runs[0].status == "abandoned"
            assert runs[0].finished_at is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_claim_hook_leaves_zero_runs(monkeypatch):
    """뮤테이션 — claim_story의 ensure_agent_run_started 호출을 무력화하면(옛 사각지대
    재현) claim이 성공해도 agent_runs가 0건인 것을 고정(이 훅이 실제로 값을 만든다는
    증거)."""
    import app.services.agent_run_tracking as mod

    async def _noop_start(*args, **kwargs):
        return None

    monkeypatch.setattr(mod, "ensure_agent_run_started", _noop_start)

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/team-members/{seeded['agent_id']}/claim",
                json={"story_id": str(seeded["story_id"])},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            runs = await _agent_runs_for(s, agent_id=seeded["agent_id"], story_id=seeded["story_id"])
            assert len(runs) == 0, "뮤테이션이 걸리지 않았다(훅을 지웠는데도 run이 생겼다)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
