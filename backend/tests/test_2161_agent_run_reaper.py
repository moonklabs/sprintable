"""story #2161(2026-07-24, 오르테가군 판정) — agent_runs 'running' 영구정체 방지, 실 Postgres 검증.

핵심 축: ⓐ 능동 스위퍼(폴링 무관)가 기한 초과 'running' run을 'abandoned'으로 승격
ⓑ 레거시 행(deadline_at NULL)도 started_at 폴백으로 정상 처리 ⓒ CAS가 진짜 완료 레이스를
보호(까심 QA HIGH C, story 2a57dc0f와 동일 근본 선제방지) ⓓ POST가 deadline_at을 즉시 기록
ⓔ PATCH가 종단 상태 전이 시 finished_at을 서버가 채움(클라 미제공 시) — duration_ms GENERATED
가 정상 종료에서도 살아나는지. story 8236bbc3 컨벤션: create_all 자체 스키마 관리."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
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


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2161", slug=f"org2161-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _make_run(session, org_id, project_id, *, status="running", deadline_at=None,
                     started_at=None):
    from app.models.agent_run import AgentRun
    from sqlalchemy import update

    run = AgentRun(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=uuid.uuid4(),
        trigger="manual", status=status, deadline_at=deadline_at,
    )
    session.add(run)
    await session.flush()
    if started_at is not None:
        # server_default=now()를 과거값으로 덮어써야 레거시-행 시나리오 재현(0168/a2a 동형).
        await session.execute(update(AgentRun).where(AgentRun.id == run.id).values(started_at=started_at))
    await session.commit()
    await session.refresh(run)
    return run


@pytest.mark.anyio
async def test_sweeper_abandons_expired_running_run_with_explicit_deadline():
    from app.services.agent_run_lifecycle import sweep_expired_agent_runs
    from app.models.agent_run import AgentRun
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            past_deadline = datetime.now(timezone.utc) - timedelta(minutes=1)
            run = await _make_run(s, org_id, project_id, deadline_at=past_deadline)

            result = await sweep_expired_agent_runs(s)
            assert result["swept_count"] == 1
            assert str(run.id) in result["run_ids"]

            reloaded = (await s.execute(select(AgentRun).where(AgentRun.id == run.id))).scalar_one()
            assert reloaded.status == "abandoned"
            assert reloaded.finished_at is not None
            assert reloaded.error_message is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweeper_leaves_not_yet_expired_run_running():
    from app.services.agent_run_lifecycle import sweep_expired_agent_runs
    from app.models.agent_run import AgentRun
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            future_deadline = datetime.now(timezone.utc) + timedelta(hours=1)
            run = await _make_run(s, org_id, project_id, deadline_at=future_deadline)

            result = await sweep_expired_agent_runs(s)
            assert result["swept_count"] == 0

            reloaded = (await s.execute(select(AgentRun).where(AgentRun.id == run.id))).scalar_one()
            assert reloaded.status == "running"
            assert reloaded.finished_at is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweeper_falls_back_to_started_at_for_legacy_null_deadline():
    from app.services.agent_run_lifecycle import sweep_expired_agent_runs, AGENT_RUN_TIMEOUT_HOURS
    from app.models.agent_run import AgentRun
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            old_started_at = datetime.now(timezone.utc) - timedelta(hours=AGENT_RUN_TIMEOUT_HOURS + 1)
            run = await _make_run(s, org_id, project_id, deadline_at=None, started_at=old_started_at)

            result = await sweep_expired_agent_runs(s)
            assert result["swept_count"] == 1

            reloaded = (await s.execute(select(AgentRun).where(AgentRun.id == run.id))).scalar_one()
            assert reloaded.status == "abandoned"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweeper_ignores_non_running_statuses():
    from app.services.agent_run_lifecycle import sweep_expired_agent_runs
    from app.models.agent_run import AgentRun
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            past_deadline = datetime.now(timezone.utc) - timedelta(minutes=1)
            completed = await _make_run(s, org_id, project_id, status="completed", deadline_at=past_deadline)
            failed = await _make_run(s, org_id, project_id, status="failed", deadline_at=past_deadline)
            queued = await _make_run(s, org_id, project_id, status="queued", deadline_at=past_deadline)

            result = await sweep_expired_agent_runs(s)
            assert result["swept_count"] == 0

            for rid, expected in ((completed.id, "completed"), (failed.id, "failed"), (queued.id, "queued")):
                reloaded = (await s.execute(select(AgentRun).where(AgentRun.id == rid))).scalar_one()
                assert reloaded.status == expected
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cas_prevents_sweeper_from_clobbering_concurrently_completed_run():
    """까심 QA HIGH C 회귀 선제방지(story 2a57dc0f 동일 근본) — 실 PG 2세션 레이스 재현. 스위퍼가
    후보를 SELECT한 *이후*, 다른 트랜잭션(진짜 PATCH 완료 경로 시뮬레이션)이 먼저 그 run을
    completed로 커밋하면, 스위퍼의 CAS UPDATE는 `WHERE status='running'`에 걸려 영향행 0 →
    skip해야 한다. CAS 없이 무조건 덮어쓰면 정상 완료된 run이 가짜 abandoned로 오염된다."""
    from app.models.agent_run import AgentRun
    from app.services.agent_run_lifecycle import abandon_run_if_still_running
    from sqlalchemy import select, update

    engine, Session = await _session()
    try:
        past_deadline = datetime.now(timezone.utc) - timedelta(minutes=1)
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            run = await _make_run(s, org_id, project_id, deadline_at=past_deadline)
            run_id = run.id

        # TxA(스위퍼 시뮬레이션): 후보 SELECT — 이 시점엔 running(TxB 커밋 전).
        session_a = Session()
        candidates = [
            row[0] for row in (await session_a.execute(
                select(AgentRun.id).where(AgentRun.id == run_id, AgentRun.status == "running")
            )).all()
        ]
        assert run_id in candidates

        # TxB(진짜 PATCH 완료 경로): 독립 세션+독립 커밋 — SELECT~UPDATE 사이 윈도우에서
        # 진짜로 먼저 completed 커밋(실 레이스 재현, mock 아님).
        real_finished_at = datetime.now(timezone.utc)
        async with Session() as session_b:
            await session_b.execute(
                update(AgentRun).where(AgentRun.id == run_id).values(
                    status="completed", finished_at=real_finished_at, result_summary="진짜 완료",
                )
            )
            await session_b.commit()

        # TxA: 이제서야 CAS UPDATE 시도 — WHERE status='running'에 이미 안 걸림.
        transitioned = await abandon_run_if_still_running(session_a, run_id, "deadline sweep")
        await session_a.commit()
        await session_a.close()
        assert transitioned is False, "CAS가 이미 completed인 run을 덮어씀 — 회귀"

        async with Session() as s:
            final = (await s.execute(select(AgentRun).where(AgentRun.id == run_id))).scalar_one()
            assert final.status == "completed"
            assert final.result_summary == "진짜 완료"  # 진짜 완료 데이터 보존
    finally:
        await engine.dispose()


# ── HTTP 왕복 — POST가 deadline_at을 기록하는지 + PATCH가 종단 상태에서 finished_at을
#    서버가 채우는지(duration_ms GENERATED가 정상 종료에서도 살아나는지, #2161 인접결함 fix) ──
def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_org_project_owner(session):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.team import TeamMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org2161B", slug=f"org2161b-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="owner")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, permission="granted", role="owner",
    ))
    agent = TeamMember(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="agent", name="agent")
    session.add(agent)
    await session.commit()
    return {"org_id": org.id, "project_id": project.id, "user_id": user.id, "agent_id": agent.id}


@pytest.mark.anyio
async def test_realdb_create_agent_run_sets_deadline_at():
    from app.main import app
    from app.services.agent_run_lifecycle import AGENT_RUN_TIMEOUT_HOURS

    engine, Session = await _session()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_owner(s)
        await _setup_app(app, Session, seeded["org_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"]),
            })
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["status"] == "running"
            deadline = datetime.fromisoformat(body["deadline_at"].replace("Z", "+00:00"))
            expected = datetime.now(timezone.utc) + timedelta(hours=AGENT_RUN_TIMEOUT_HOURS)
            assert abs((deadline - expected).total_seconds()) < 30, (
                f"deadline_at이 now+{AGENT_RUN_TIMEOUT_HOURS}h 근방이어야 — 실제 {deadline}"
            )
        finally:
            await client.aclose()
        app.dependency_overrides.clear()
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_realdb_patch_terminal_status_without_finished_at_is_server_filled():
    """AC — 클라(MCP)가 finished_at을 안 보내도 종단 상태 전이 시 서버가 now()로 채워
    duration_ms(GENERATED)가 살아난다(#2161 인접결함 fix 핵심 회귀가드)."""
    from app.main import app

    engine, Session = await _session()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_owner(s)
        await _setup_app(app, Session, seeded["org_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"]),
            })
            run_id = create_resp.json()["id"]

            patch_resp = await client.patch(
                f"/api/v2/agent-runs/{run_id}", json={"status": "completed"},
            )
            assert patch_resp.status_code == 200, patch_resp.text
            body = patch_resp.json()
            assert body["status"] == "completed"
            assert body["finished_at"] is not None, "종단 상태인데 finished_at이 여전히 NULL — 인접결함 재발"
            assert body["duration_ms"] is not None, "finished_at이 채워졌으면 duration_ms GENERATED도 살아나야"
        finally:
            await client.aclose()
        app.dependency_overrides.clear()
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_realdb_patch_non_terminal_status_does_not_set_finished_at():
    from app.main import app

    engine, Session = await _session()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_owner(s)
        await _setup_app(app, Session, seeded["org_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"]),
            })
            run_id = create_resp.json()["id"]

            patch_resp = await client.patch(f"/api/v2/agent-runs/{run_id}", json={"status": "held"})
            assert patch_resp.status_code == 200, patch_resp.text
            assert patch_resp.json()["finished_at"] is None
        finally:
            await client.aclose()
        app.dependency_overrides.clear()
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.anyio
async def test_realdb_patch_respects_client_provided_finished_at():
    """MCP가 이미 finished_at을 보낼 수 있는 경로(sprintable_mcp update_run_status)를 존중 —
    서버 now()로 덮어쓰지 않는다."""
    from app.main import app

    engine, Session = await _session()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_owner(s)
        await _setup_app(app, Session, seeded["org_id"], seeded["user_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(seeded["agent_id"]), "project_id": str(seeded["project_id"]),
            })
            run_id = create_resp.json()["id"]

            explicit = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
            patch_resp = await client.patch(
                f"/api/v2/agent-runs/{run_id}", json={"status": "completed", "finished_at": explicit},
            )
            assert patch_resp.status_code == 200, patch_resp.text
            got = datetime.fromisoformat(patch_resp.json()["finished_at"].replace("Z", "+00:00"))
            expected = datetime.fromisoformat(explicit)
            assert abs((got - expected).total_seconds()) < 2
        finally:
            await client.aclose()
        app.dependency_overrides.clear()
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


def test_migration_0208_backfills_legacy_null_started_at_and_enforces_not_null():
    """CI real-PG 리뷰(#2478, 2026-07-24) 회귀 재발 방지 — `app/models/agent_run.py`의
    `started_at`은 원래도 `nullable=False, server_default=func.now()`라고 선언돼 있었지만
    실 DB(baseline schema.sql)엔 DEFAULT도 NOT NULL도 없었다. 그래서 `POST /agent-runs`로
    생성되는 모든 run(레거시뿐 아니라)이 started_at=NULL이었고, `AgentRunResponse`가 그
    필드를 노출하자(story #2161) pydantic ValidationError로 실 CI에서 터졌다.

    [[reference_local_migration_verify]] 패턴(env.py 우회·Operations API로 마이그 함수 직구동,
    동기 psycopg2) — create_all로 테이블을 만든 뒤 started_at을 raw SQL로 "0208 이전 상태"
    (NOT NULL/DEFAULT 없음)로 되돌려 레거시 NULL 행을 재현하고, 0208.upgrade()를 실제로
    호출해 ⓐ 백필 ⓑ NOT NULL 강제 ⓒ DEFAULT 동작을 직접 검증한다."""
    import importlib.util
    import sqlalchemy as sa
    from alembic.runtime.migration import MigrationContext
    from alembic.operations import Operations
    from pathlib import Path
    from sqlalchemy.orm import sessionmaker

    sync_url = _REAL_DB_URL
    for prefix in ("postgresql+asyncpg://",):
        if sync_url.startswith(prefix):
            sync_url = "postgresql+psycopg2://" + sync_url[len(prefix):]
            break
    if sync_url.startswith("postgresql://"):
        sync_url = sync_url.replace("postgresql://", "postgresql+psycopg2://", 1)

    from app.core.database import Base
    from app.models.agent_run import AgentRun
    from app.models.organization import Organization
    from app.models.project import Project
    import app.models  # noqa: F401

    engine = sa.create_engine(sync_url)
    Session = sessionmaker(bind=engine)
    try:
        Base.metadata.create_all(engine)
        # 모델은 이미 nullable=False/server_default=func.now()라 create_all이 NOT NULL로 만든다
        # — 0208 "이전" 상태(레거시)를 재현하려면 그 제약을 되돌려야 한다.
        with engine.begin() as conn:
            conn.execute(sa.text("ALTER TABLE agent_runs ALTER COLUMN started_at DROP NOT NULL"))
            conn.execute(sa.text("ALTER TABLE agent_runs ALTER COLUMN started_at DROP DEFAULT"))

        with Session() as s:
            org = Organization(name="T", slug=f"org-2161-mig-{uuid.uuid4().hex[:8]}")
            s.add(org)
            s.flush()
            project = Project(org_id=org.id, name="P")
            s.add(project)
            s.flush()
            # ORM은 Python-level에서 nullable을 검증하지 않는다(DB만 강제) — started_at=None을
            # 명시해 "0208 이전에 만들어진 레거시 run"을 그대로 재현.
            legacy_run = AgentRun(
                org_id=org.id, project_id=project.id, agent_id=uuid.uuid4(), status="completed",
                started_at=None,
            )
            s.add(legacy_run)
            s.commit()
            legacy_run_id, org_id, project_id = legacy_run.id, org.id, project.id

        spec = importlib.util.spec_from_file_location(
            "m0208",
            Path(__file__).resolve().parents[1] / "alembic" / "versions"
            / "0208_agent_runs_started_at_default_backfill.py",
        )
        m0208 = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m0208)

        with engine.begin() as conn:
            ctx = MigrationContext.configure(conn)
            with Operations.context(ctx):
                m0208.upgrade()

        with Session() as s:
            reloaded = s.get(AgentRun, legacy_run_id)
            assert reloaded.started_at is not None, "레거시 NULL 행이 백필 안 됨 — 회귀"
            assert reloaded.started_at == reloaded.created_at, "백필값이 created_at과 달라야 할 이유가 없음"

            # DEFAULT 확認 — started_at 생략(ORM도 이제 Python default로 채우지만, 여기선
            # DB DEFAULT 자체가 살아있는지가 검증 대상이라 raw INSERT로 컬럼째 생략).
            new_started_at = s.execute(sa.text(
                "INSERT INTO agent_runs (id, org_id, project_id, agent_id, trigger, status, "
                "retry_count, max_retries, llm_call_count, metadata) "
                "VALUES (gen_random_uuid(), :org_id, :project_id, gen_random_uuid(), 'manual', "
                "'running', 0, 3, 0, '{}'::jsonb) RETURNING started_at"
            ), {"org_id": org_id, "project_id": project_id}).scalar_one()
            assert new_started_at is not None, "DEFAULT가 새 INSERT에 안 먹음 — 회귀"
            s.commit()

            with pytest.raises(Exception):
                s.execute(sa.text(
                    "INSERT INTO agent_runs (id, org_id, project_id, agent_id, trigger, status, "
                    "retry_count, max_retries, llm_call_count, metadata, started_at) "
                    "VALUES (gen_random_uuid(), :org_id, :project_id, gen_random_uuid(), 'manual', "
                    "'running', 0, 3, 0, '{}'::jsonb, NULL)"
                ), {"org_id": org_id, "project_id": project_id})
                s.commit()
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


# ── 소스 고정 — pinning 테스트(오늘 팀 관례로 채택, 오르테가군 명시 요청) ──────────────
def test_breaking_condition_declared_and_pinned():
    """오르테가군 지시 — "타임아웃보다 오래 걸리는 정상 실행이 실제로 관측되면 하트비트로
    승격" 문장 그대로 소스에 고정. 사라지면 다음 사람이 왜 24시간인지, 언제 재고해야 하는지
    모른 채 넘어간다."""
    import inspect
    import app.services.agent_run_lifecycle as mod

    source = inspect.getsource(mod)
    assert "타임아웃보다 오래 걸리는 정상 실행이 실제로 관측되면" in source
    assert "하트비트" in source


def test_baseline_schema_check_includes_abandoned():
    """[[feedback_baseline_check_ci_sqlite_blindspot]] — CI SQLite/create_all은 실 PG CHECK
    위반을 못 잡는다. 'abandoned'이 baseline schema.sql의 agent_runs_status_check에 실제로
    반영됐는지 소스 고정(migration 0207과 짝)."""
    from pathlib import Path

    schema = (Path(__file__).resolve().parents[1] / "alembic" / "baseline" / "schema.sql").read_text()
    # agent_runs 테이블의 CHECK 라인만 특정 — 다른 테이블의 status CHECK와 혼동 방지.
    assert "CONSTRAINT agent_runs_status_check CHECK ((status = ANY (ARRAY[" in schema
    check_line = next(
        line for line in schema.splitlines() if "agent_runs_status_check" in line
    )
    assert "'abandoned'::text" in check_line


def test_terminal_statuses_include_abandoned_not_completed_disguise():
    """가드②(오르테가군 지시, "completed로 위장 금지") — abandon_run_if_still_running이 실제로
    'abandoned'을 쓰는지, 'completed'를 쓰지 않는지 소스 고정."""
    import inspect
    import app.services.agent_run_lifecycle as mod

    source = inspect.getsource(mod.abandon_run_if_still_running)
    assert 'status="abandoned"' in source
    assert 'status="completed"' not in source
