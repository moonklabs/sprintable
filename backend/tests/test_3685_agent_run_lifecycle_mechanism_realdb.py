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


def _install_check_violating_agent_run(monkeypatch):
    """CHANGES(페드루 PO, 2026-09-07) — PK 충돌은 SQLAlchemy identity map이 SQL을 내보내기
    前에 ORM 층에서 먼저 잡아버려(식별맵에 같은 키가 있으면) 실제로 Postgres에 SQL이
    한 번도 안 나가고, 그래서 asyncpg 트랜잭션도 안 깨지고 세션도 PendingRollback이 안
    된다 — 내 첫 시도(PK 충돌)가 SAVEPOINT 유무 차이를 못 드러낸 이유가 이것이었다.
    세션이 진짜 poison되려면 SQL 자체가 Postgres까지 나가서 거부돼야 한다 —
    `agent_runs_status_check`(alembic 0207) CHECK 제약을 어기는 status 값으로 강제하면
    INSERT가 실제로 Postgres에 도달해 CHECK 위반(asyncpg IntegrityError)으로 터지고,
    그 순간 PG가 트랜잭션을 abort한다(SAVEPOINT 없으면 그 뒤 같은 세션의 어떤 SQL도
    실패)."""
    from app.models.agent_run import AgentRun

    # mod.AgentRun 자체(모듈-레벨 이름)를 바꾸면 dedupe SELECT의 `AgentRun.id`(클래스
    # 속성 접근)도 같이 깨진다(함수엔 .id가 없다) — 생성자(__init__)만 패치해 SELECT는
    # 그대로 두고 INSERT할 인스턴스만 status를 강제로 위반값으로 바꾼다.
    original_init = AgentRun.__init__

    def _init_with_bogus_status(self, **kwargs):
        kwargs["status"] = "bogus"  # agent_runs_status_check가 거부하는 값 — 실 CHECK 위반.
        original_init(self, **kwargs)

    monkeypatch.setattr(AgentRun, "__init__", _init_with_bogus_status)


@pytest.mark.anyio
async def test_run_write_failure_does_not_poison_story_transition_commit(monkeypatch):
    """CHANGES(페드루 PO, 2026-09-07) — ensure_agent_run_started 안에서 flush가 실 DB
    오류(CHECK 위반, PG가 트랜잭션을 실제로 abort)로 터져도 스토리 in-progress 전이
    자체는 여전히 커밋돼야 한다(SAVEPOINT 격리가 실제로 바깥 트랜잭션을 살린다는
    증거) — 응답 200이 아니라(라우터가 다른 예외 경로로 200을 낼 수도 있어 그 자체는
    약한 신호) 새 세션 SELECT로 story.status가 실제로 영속됐는지를 본다."""
    import app.services.agent_run_tracking as mod

    _install_check_violating_agent_run(monkeypatch)

    from app.main import app
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app_agent(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{seeded['story_id']}/status", json={"status": "in-progress"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            story = (await s.execute(
                select(Story).where(Story.id == seeded["story_id"])
            )).scalar_one()
            assert story.status == "in-progress", "run 실패가 스토리 전이 자체를 오염시켰다(세션 poison)"
            runs = await _agent_runs_for(s, agent_id=seeded["agent_id"], story_id=seeded["story_id"])
            assert len(runs) == 0, "CHECK 위반 행이 커밋됐다(있을 수 없음 — DB가 거부했어야)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_run_write_failure_does_not_lose_uncommitted_sibling_write(monkeypatch):
    """페드루 PO 3차 지적(2026-09-07, 서비스 층 직접) — API 경로에선 차이가 안 드러난
    이유는 «잃을 미커밋 형제 쓰기가 없어서»였다: SQLAlchemy 2.0은 flush 실패 시
    세션을 poison(못 쓰게)시키는 게 아니라 루트 트랜잭션을 통째로 롤백하고 다음
    사용에 새 트랜잭션을 autobegin한다 — 실제 증상은 «세션이 죽는다」가 아니라
    «그 앞의 미커밋 쓰기가 조용히 사라진다」. 이 테스트는 서비스 함수를 API 없이
    직접 호출해 그 증상을 정확히 겨냥한다: 같은 세션에서 ① 형제 쓰기(story.title,
    flush 안 함=pending) → ② ensure_agent_run_started를 CHECK 위반으로 실패시킴
    → ③ session.commit() → ④ 새 세션 SELECT로 ①이 살아남았는지."""
    import app.services.agent_run_tracking as mod
    from app.models.pm import Story

    _install_check_violating_agent_run(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        async with Session() as s:
            story = (await s.execute(
                select(Story).where(Story.id == seeded["story_id"])
            )).scalar_one()
            story.title = "형제쓰기-생존확인"  # flush 안 함 — 세션에 pending 상태로만 존재.

            await mod.ensure_agent_run_started(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                agent_id=seeded["agent_id"], story_id=seeded["story_id"],
            )
            await s.commit()

        async with Session() as s2:
            story2 = (await s2.execute(
                select(Story).where(Story.id == seeded["story_id"])
            )).scalar_one()
            assert story2.title == "형제쓰기-생존확인", (
                "형제의 미커밋 쓰기가 사라졌다 — run 기록 실패가 세션을 poison시켰다"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_savepoint_loses_sibling_write(monkeypatch):
    """뮤테이션 — begin_nested() 격리를 빼면(옛 결함 재현) 위 테스트와 똑같은 시나리오에서
    형제의 미커밋 쓰기가 루트 트랜잭션 롤백에 휩쓸려 사라지는 것을 고정(위 테스트가
    실제로 SAVEPOINT 격리를 지키고 있다는 증거)."""

    class _AsyncNullContext:
        async def __aenter__(self):
            return None

        async def __aexit__(self, exc_type, exc, tb):
            return False  # 예외를 그대로 전파(=SAVEPOINT 없음과 동형).

    import app.services.agent_run_tracking as mod
    from app.models.pm import Story

    _install_check_violating_agent_run(monkeypatch)
    monkeypatch.setattr(mod.AsyncSession, "begin_nested", lambda self: _AsyncNullContext())

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        async with Session() as s:
            story = (await s.execute(
                select(Story).where(Story.id == seeded["story_id"])
            )).scalar_one()
            story.title = "형제쓰기-생존확인"

            await mod.ensure_agent_run_started(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                agent_id=seeded["agent_id"], story_id=seeded["story_id"],
            )
            try:
                await s.commit()
            except Exception:  # noqa: BLE001 — SAVEPOINT 없으면 commit 자체가 터질 수도 있다.
                await s.rollback()

        async with Session() as s2:
            story2 = (await s2.execute(
                select(Story).where(Story.id == seeded["story_id"])
            )).scalar_one()
            assert story2.title != "형제쓰기-생존확인", (
                "뮤테이션이 걸리지 않았다(SAVEPOINT 없이도 형제 쓰기가 살아남았다)"
            )
    finally:
        await engine.dispose()


