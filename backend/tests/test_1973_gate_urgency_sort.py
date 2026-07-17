"""story #1973(P1a-S4): ``list_gates ?sort=urgency`` — 결재함 통합 큐(#1960)의 기본 정렬 근거.

배경: ``WorkflowLineStepRun``(gate_id/h1_gate_id로 Gate에 직접 걸림, ``sla_due_at`` nullable
datetime)에서 SLA overdue 여부를 gate당 correlated EXISTS 서브쿼리로 목록 전체에 대해 **단일
SQL statement**로 판정한다(N+1 절대 금지). 우선순위(스토리 AC): 1) SLA overdue 최상위
2) age(created_at) 오래된 순 3) held(향후 만료) 최하단.

테스트 구성:
- ``apply_gate_urgency_sort`` 순수 SQL 조립(mocked/compiled — DB 접근 없이 ORDER BY 절 구조 확인).
- ``list_gates`` 라우트(mocked session) — ``sort=urgency`` 시에만 헬퍼 호출·미지정 시 무호출(회귀 0).
- realdb: 6종 조합(overdue+오래됨/overdue+최근/normal+오래됨/normal+최근/held-future/held-past)
  seed 후 GET /api/v2/gates?sort=urgency 정렬 순서 실측 + gate_id/h1_gate_id 양쪽 경로 커버.
- realdb: sort 파라미터 없는 기존 호출 회귀 없음(무정렬 응답 내용 동일).
- realdb: N+1 방지 — sqlalchemy ``before_cursor_execute`` 이벤트로 실행 SQL statement 수를 세어
  gate 개수가 늘어나도(2건→6건) 고정(list SELECT 1 + org posture 1 = 2)임을 실측.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── apply_gate_urgency_sort: 순수 SQL 조립(ORDER BY 절 구조, DB 접근 없음) ──────────


def test_apply_gate_urgency_sort_order_by_clause_priority_order():
    """컴파일된 SQL의 ORDER BY 절에서 held CASE가 가장 먼저, 그 다음 overdue EXISTS CASE,
    마지막으로 created_at이 나오는지 텍스트 구조로 확인(파이썬 레벨 정렬이 아니라 SQL
    ORDER BY 절임을 실증)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.gate_service import apply_gate_urgency_sort

    q = apply_gate_urgency_sort(select(Gate))
    compiled = str(q.compile(compile_kwargs={"literal_binds": True}))
    upper = compiled.upper()
    order_by_idx = upper.index("ORDER BY")
    order_by_clause = compiled[order_by_idx:]

    assert "held_until" in order_by_clause
    assert "EXISTS" in order_by_clause.upper()
    assert "created_at" in order_by_clause
    # 우선순위 순서: held_until 판정 CASE가 EXISTS(overdue) CASE보다 먼저, EXISTS가 created_at보다 먼저.
    assert order_by_clause.index("held_until") < order_by_clause.index("EXISTS")
    assert order_by_clause.upper().index("EXISTS") < order_by_clause.rindex("created_at")


def test_apply_gate_urgency_sort_no_python_level_sort():
    """반환값이 여전히 SQLAlchemy Select(order_by 추가된)이지 리스트가 아님 — 파이썬 정렬 금지 확인."""
    from sqlalchemy import Select, select

    from app.models.gate import Gate
    from app.services.gate_service import apply_gate_urgency_sort

    q = apply_gate_urgency_sort(select(Gate))
    assert isinstance(q, Select)


# ── list_gates 라우트(mocked session) — sort 파라미터 배선 확인 ──────────────────


def _gate(org, work_item_id, wtype, gate_type="merge", gate_id=None):
    return SimpleNamespace(
        id=gate_id or uuid.uuid4(), org_id=org, work_item_id=work_item_id, work_item_type=wtype,
        gate_type=gate_type, status="pending", resolver_id=None, resolved_at=None,
        resolution_note=None, held_until=None, neutral_facts=None, requires_human=False,
        evidence_status=None, decision_basis=None, auto_decision_reason=None,
        created_at=datetime(2026, 7, 17, tzinfo=timezone.utc),
        updated_at=datetime(2026, 7, 17, tzinfo=timezone.utc),
    )


@pytest.mark.anyio
async def test_list_gates_sort_urgency_calls_helper():
    from app.routers import gates as gates_mod
    from app.routers.gates import list_gates

    org = uuid.uuid4()
    gates = [_gate(org, uuid.uuid4(), "story")]
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = gates
    session = AsyncMock()
    session.execute = AsyncMock(return_value=gates_res)
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "apply_gate_urgency_sort",
                       MagicMock(side_effect=lambda q: q)) as sort_spy, \
         patch.object(gates_mod, "get_org_posture", AsyncMock(return_value=None)):
        await list_gates(work_item_id=None, work_item_type=None, status=None, sort="urgency",
                          session=session, org_id=org, auth=auth)

    sort_spy.assert_called_once()


@pytest.mark.anyio
async def test_list_gates_no_sort_param_skips_urgency_helper():
    """sort 미지정(기본) — apply_gate_urgency_sort 무호출(기존 무정렬/삽입순 회귀 0)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import list_gates

    org = uuid.uuid4()
    gates = [_gate(org, uuid.uuid4(), "story")]
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = gates
    session = AsyncMock()
    session.execute = AsyncMock(return_value=gates_res)
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "apply_gate_urgency_sort",
                       MagicMock(side_effect=AssertionError("호출되면 안 됨"))) as sort_spy, \
         patch.object(gates_mod, "get_org_posture", AsyncMock(return_value=None)):
        out = await list_gates(work_item_id=None, work_item_type=None, status=None, sort=None,
                                session=session, org_id=org, auth=auth)

    assert len(out) == 1
    sort_spy.assert_not_called()


@pytest.mark.anyio
async def test_list_gates_sort_other_value_skips_urgency_helper():
    """sort에 urgency 외 값이 오면 무시(현재 지원 값은 urgency뿐 — 방어적으로 헬퍼 미호출)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import list_gates

    org = uuid.uuid4()
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = []
    session = AsyncMock()
    session.execute = AsyncMock(return_value=gates_res)
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "apply_gate_urgency_sort",
                       MagicMock(side_effect=AssertionError("호출되면 안 됨"))) as sort_spy:
        out = await list_gates(work_item_id=None, work_item_type=None, status=None, sort="created_at",
                                session=session, org_id=org, auth=auth)

    assert out == []
    sort_spy.assert_not_called()


# ── realdb: 정렬 순서 실측 + N+1 방지 실측 ──────────────────────────────────────

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


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


async def _seed_common(session):
    """org + project + caller(project grant, has_project_access True 경로)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    caller = User(id=uuid.uuid4(), email=f"caller-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller.id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller.id}


async def _seed_gate(session, org_id, project_id, *, created_at, held_until=None, status="pending"):
    from app.models.gate import Gate
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=f"s-{uuid.uuid4().hex[:6]}")
    session.add(story)
    await session.flush()
    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story.id, work_item_type="story",
        gate_type="pr_review", status=status, created_at=created_at, held_until=held_until,
    )
    session.add(gate)
    await session.flush()
    return gate


async def _seed_step_run(
    session, org_id, project_id, *, gate_id=None, h1_gate_id=None, sla_due_at,
    status="waiting_gate",
):
    from app.models.workflow_line import WorkflowLineStepRun

    sr = WorkflowLineStepRun(
        org_id=org_id, project_id=project_id, entity_type="story", entity_id=uuid.uuid4(),
        to_status="in_review", status=status, mode="enforcing",
        gate_id=gate_id, h1_gate_id=h1_gate_id, sla_due_at=sla_due_at,
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
    )
    session.add(sr)
    await session.flush()
    return sr


async def _seed_urgency_matrix(session, org_id, project_id, now):
    """6종 조합 — 기대 정렬 순서(오름차순): overdue_old, overdue_recent, normal_old, held_past,
    normal_recent, held_future.

    ⭐순서 근거:
      1차(held future=최하단): held_future만 held_rank=1 — 나머지 전부 held_rank=0.
      2차(overdue=최상위, held_rank=0 그룹 내): overdue_old/overdue_recent만 overdue_rank=0.
      3차(created_at ASC, 각 그룹 내부).
    """
    gates: dict[str, "Gate"] = {}

    # overdue_old: gate_id 경로로 open step_run + sla_due_at 과거(3일 전) — 가장 오래된 overdue.
    gates["overdue_old"] = await _seed_gate(
        session, org_id, project_id, created_at=now - timedelta(days=10),
    )
    await _seed_step_run(
        session, org_id, project_id, gate_id=gates["overdue_old"].id,
        sla_due_at=now - timedelta(days=3), status="gate_pending",
    )

    # overdue_recent: h1_gate_id 경로(양쪽 컬럼 커버) + open + sla_due_at 과거(10분 전).
    gates["overdue_recent"] = await _seed_gate(
        session, org_id, project_id, created_at=now - timedelta(hours=1),
    )
    await _seed_step_run(
        session, org_id, project_id, h1_gate_id=gates["overdue_recent"].id,
        sla_due_at=now - timedelta(minutes=10), status="waiting_gate",
    )

    # normal_old: step_run 있지만 status가 open 집합 밖(approved=closed) → overdue 카운트 안 됨
    # (sla_due_at 자체는 과거인데도 open-status 필터가 걸러내는지 실증).
    gates["normal_old"] = await _seed_gate(
        session, org_id, project_id, created_at=now - timedelta(days=20),
    )
    await _seed_step_run(
        session, org_id, project_id, gate_id=gates["normal_old"].id,
        sla_due_at=now - timedelta(days=1), status="approved",
    )

    # held_past: hold 만료(held_until 과거) → held_rank=0(정상 취급), step_run 없음(overdue 아님).
    gates["held_past"] = await _seed_gate(
        session, org_id, project_id, created_at=now - timedelta(days=15),
        status="held", held_until=now - timedelta(days=1),
    )

    # normal_recent: open step_run이지만 sla_due_at이 미래 → overdue 아님.
    gates["normal_recent"] = await _seed_gate(
        session, org_id, project_id, created_at=now - timedelta(minutes=1),
    )
    await _seed_step_run(
        session, org_id, project_id, gate_id=gates["normal_recent"].id,
        sla_due_at=now + timedelta(days=1), status="waiting_gate",
    )

    # held_future: 가장 오래된 created_at(-100일)이고 open+overdue step_run까지 있지만, held_until이
    # 미래라 held 규칙이 overdue/age 둘 다 이기고 최하단으로 밀려나야 함.
    gates["held_future"] = await _seed_gate(
        session, org_id, project_id, created_at=now - timedelta(days=100),
        status="held", held_until=now + timedelta(days=1),
    )
    await _seed_step_run(
        session, org_id, project_id, gate_id=gates["held_future"].id,
        sla_due_at=now - timedelta(days=5), status="gate_pending",
    )

    await session.commit()
    return gates


_EXPECTED_ORDER = ["overdue_old", "overdue_recent", "normal_old", "held_past", "normal_recent", "held_future"]


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_urgency_sort_matches_expected_priority_order():
    from app.main import app

    now = datetime.now(timezone.utc)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            gates = await _seed_urgency_matrix(s, seeded["org_id"], seeded["project_id"], now)

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates", params={"sort": "urgency"})
            assert resp.status_code == 200, resp.text
            body = resp.json()

            id_to_label = {str(g.id): label for label, g in gates.items()}
            got_order = [id_to_label[row["id"]] for row in body if row["id"] in id_to_label]

            # ⭐done-gate 캡처: 실 게이트 다건 정렬 순서 + 각각의 held_until/created_at 값(PR
            # 코멘트에 이 출력 그대로 첨부).
            print("\n=== realdb urgency sort capture ===")
            for row in body:
                label = id_to_label.get(row["id"], "?")
                print(f"  [{label}] id={row['id']} status={row['status']} "
                      f"held_until={row['held_until']} created_at={row['created_at']}")

            assert got_order == _EXPECTED_ORDER, got_order
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_no_sort_param_returns_unsorted_default_no_regression():
    """sort 파라미터 없는 기존 호출 — 무정렬(삽입순) 응답, 내용(gate id 집합)은 sort=urgency와
    동일(순서만 다를 수 있음) → 회귀 없음."""
    from app.main import app

    now = datetime.now(timezone.utc)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            gates = await _seed_urgency_matrix(s, seeded["org_id"], seeded["project_id"], now)

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            got_ids = {row["id"] for row in body}
            expected_ids = {str(g.id) for g in gates.values()}
            assert got_ids == expected_ids
            assert len(body) == len(gates)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_urgency_sort_query_count_fixed_regardless_of_gate_count():
    """N+1 방지 실측: gate 2건 vs 6건에서 sort=urgency 호출 시 실행 SQL statement 수가 동일
    (list SELECT 1 + org posture 1 = 2)해야 한다 — before_cursor_execute 이벤트로 실측."""
    from sqlalchemy import event

    from app.main import app

    now = datetime.now(timezone.utc)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            # 2건만 seed(overdue 1 + normal 1) — N+1이면 여기서도 이미 쿼리 수가 늘어야 함.
            await _seed_gate(s, seeded["org_id"], seeded["project_id"], created_at=now - timedelta(days=1))
            g2 = await _seed_gate(s, seeded["org_id"], seeded["project_id"], created_at=now - timedelta(days=2))
            await _seed_step_run(
                s, seeded["org_id"], seeded["project_id"], gate_id=g2.id,
                sla_due_at=now - timedelta(hours=1), status="gate_pending",
            )
            await s.commit()

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            statements_2: list[str] = []

            def _capture(stmts):
                def _listener(conn, cursor, statement, parameters, context, executemany):
                    stmts.append(statement)
                return _listener

            listener_2 = _capture(statements_2)
            event.listen(engine.sync_engine, "before_cursor_execute", listener_2)
            try:
                resp = await client.get("/api/v2/gates", params={"sort": "urgency"})
                assert resp.status_code == 200, resp.text
                assert len(resp.json()) == 2
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", listener_2)

            select_stmts_2 = [s for s in statements_2 if s.strip().upper().startswith("SELECT")]

            # 이제 6건으로 늘려 같은 측정을 반복 — SELECT statement 수가 고정이어야 N+1이 아니다.
            async with Session() as s:
                await _seed_urgency_matrix(s, seeded["org_id"], seeded["project_id"], now)

            statements_6: list[str] = []
            listener_6 = _capture(statements_6)
            event.listen(engine.sync_engine, "before_cursor_execute", listener_6)
            try:
                resp = await client.get("/api/v2/gates", params={"sort": "urgency"})
                assert resp.status_code == 200, resp.text
                assert len(resp.json()) == 8  # 2(기존) + 6(matrix)
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", listener_6)

            select_stmts_6 = [s for s in statements_6 if s.strip().upper().startswith("SELECT")]

            print(f"\n=== N+1 실측: gate 2건 SELECT 수={len(select_stmts_2)}, "
                  f"gate 8건 SELECT 수={len(select_stmts_6)} ===")
            assert len(select_stmts_2) == len(select_stmts_6), (
                f"gate 개수 증가로 쿼리 수가 늘었다(N+1 의심): 2건={len(select_stmts_2)} "
                f"8건={len(select_stmts_6)}"
            )
            # 핵심 성능 요구사항: list SELECT(1) + org posture(1) = 고정 2개(1~2개 범위).
            assert len(select_stmts_6) <= 2, select_stmts_6
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
