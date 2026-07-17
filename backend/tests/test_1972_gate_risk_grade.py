"""story #1972(P1a-S4): 게이트 위험도 UX 등급 파생.

SSOT: doc `gate-risk-ux-classification-criteria` §2 판정표(1차 축=posture, 2차 축=gate_type,
폴백=보수적 고위험). ⚠️핵심 원칙(models/hitl_config.py:3 철학 준수): 새 risk_level 판정 필드/로직이
아니다 — 기존 신호(OrgGatePolicy.posture + Gate.gate_type)를 UX 등급으로 **파생**하는 순수 함수일
뿐. `resolve_disposition()`(gate_resolver.py)은 member/org override 전체 precedence를 태우는 완전히
별개의 HITL 정책 해소 함수라 호출하지 않는다 — `get_org_posture()`가 org_id 하나로 org_gate_policy
단일 쿼리만 수행한다(doc §4 "경계 명확화").

테스트 구성:
- derive_risk_grade 순수 함수 매트릭스(posture 4종 × gate_type 6종 = 24 조합, doc §2 표 그대로
  literal 명시 — 구현 로직을 그대로 미러링하지 않고 스펙을 직접 기술).
- get_org_posture 쿼리 형태(단일 쿼리·OrgGatePolicy만 대상) + resolve_disposition 비호출 구조 확인.
- list_gates/get_gate_endpoint 라우트(mocked session) risk_grade enrich 배선.
- realdb 통합: 고위험(posture=conservative)·저위험(posture=permissive가 merge gate_type을
  오버라이드) 각 1건을 GET /{id}·GET "" 둘 다에서 실측. balanced+axis2 폴백도 실측.
  member_gate_override가 있어도(disposition 축) risk_grade(별개 축)가 무관함을 realdb로 실증.
"""
from __future__ import annotations

import inspect
import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar_result(value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = value
    return r


# ── derive_risk_grade 순수 함수 매트릭스(doc §2 표 그대로) ──────────────────────

# doc §2.1(1차 축=posture)·§2.2(2차 축=gate_type, posture 미확定일 때만)·§2.3(폴백=보수적 고위험)을
# 표 그대로 옮긴 literal 매트릭스. gate_type 5종(pr_review/qa/merge/deploy/workflow_config_publish) +
# 신규/미분류 gate_type 대리값("doc_approval")으로 폴백 케이스까지 커버 = posture 4종(conservative/
# permissive/balanced/None) × gate_type 6종 = 24 조합.
_RISK_GRADE_MATRIX: list[tuple[str | None, str, str]] = [
    # posture=conservative → 항상 high(gate_type 무관, §2.1)
    ("conservative", "pr_review", "high"),
    ("conservative", "qa", "high"),
    ("conservative", "merge", "high"),
    ("conservative", "deploy", "high"),
    ("conservative", "workflow_config_publish", "high"),
    ("conservative", "doc_approval", "high"),
    # posture=permissive → 항상 low(gate_type 무관, §2.1)
    ("permissive", "pr_review", "low"),
    ("permissive", "qa", "low"),
    ("permissive", "merge", "low"),
    ("permissive", "deploy", "low"),
    ("permissive", "workflow_config_publish", "low"),
    ("permissive", "doc_approval", "low"),
    # posture=balanced → 2차 축(gate_type, §2.2) + 폴백(§2.3)
    ("balanced", "pr_review", "low"),
    ("balanced", "qa", "low"),
    ("balanced", "merge", "high"),
    ("balanced", "deploy", "high"),
    ("balanced", "workflow_config_publish", "high"),
    ("balanced", "doc_approval", "high"),  # 폴백: 미분류 gate_type → 보수적 고위험
    # posture=None(미설정 row 없음) → 2차 축(gate_type, §2.2) + 폴백(§2.3)
    (None, "pr_review", "low"),
    (None, "qa", "low"),
    (None, "merge", "high"),
    (None, "deploy", "high"),
    (None, "workflow_config_publish", "high"),
    (None, "doc_approval", "high"),  # 폴백: 미분류 gate_type → 보수적 고위험
]


@pytest.mark.parametrize("posture,gate_type,expected", _RISK_GRADE_MATRIX)
def test_derive_risk_grade_matrix(posture, gate_type, expected):
    from app.services.gate_service import derive_risk_grade

    assert derive_risk_grade(posture, gate_type) == expected


def test_derive_risk_grade_matrix_covers_all_gate_types():
    """GATE_TYPES(5종) 전부가 매트릭스에 등장하는지 자기표면화(신규 gate_type 확장 시 매트릭스
    drift 방지 — feedback_one_directional_check_vacuous_pass 교훈: EXPECTED-actual 방향도 확인)."""
    from app.models.hitl_config import GATE_TYPES

    covered = {gt for _, gt, _ in _RISK_GRADE_MATRIX}
    assert GATE_TYPES <= covered  # 5종 전부 매트릭스에 있어야 함
    assert "doc_approval" in covered  # 폴백(미분류) 대리값도 있어야 함


# ── get_org_posture 쿼리 형태 + resolve_disposition 비호출 구조 확인 ─────────────


@pytest.mark.anyio
async def test_get_org_posture_single_query_returns_posture():
    from app.services.gate_service import get_org_posture

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result("conservative"))
    org_id = uuid.uuid4()

    result = await get_org_posture(session, org_id)

    assert result == "conservative"
    assert session.execute.await_count == 1  # 단일 쿼리(member/org override 추가조회 없음)


@pytest.mark.anyio
async def test_get_org_posture_none_when_no_row():
    from app.services.gate_service import get_org_posture

    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(None))

    result = await get_org_posture(session, uuid.uuid4())

    assert result is None
    assert session.execute.await_count == 1


def test_get_org_posture_does_not_reference_resolve_disposition():
    """구조적 확인: get_org_posture 함수 **바이트코드**가 resolve_disposition을 이름으로 참조하지
    않는다(import·호출 어느 쪽도 없음) — HITL 정책 해소(member/org override precedence)와 위험도
    UX 등급 파생이 코드 레벨에서 완전히 분리된 경로임을 실제 실행 그래프로 확인. ``co_names``는
    바이트코드가 로드하는 전역/속성 이름만 담아 docstring 문자열 리터럴은 섞이지 않는다(순수
    substring 검사의 오탐 방지)."""
    from app.services import gate_service

    referenced_names = gate_service.get_org_posture.__code__.co_names
    assert "resolve_disposition" not in referenced_names


def test_derive_risk_grade_does_not_reference_resolve_disposition():
    """derive_risk_grade(순수 함수)도 동일하게 resolve_disposition 바이트코드 참조가 없어야 한다."""
    from app.services import gate_service

    referenced_names = gate_service.derive_risk_grade.__code__.co_names
    assert "resolve_disposition" not in referenced_names


def test_derive_risk_grade_is_pure_no_session_param():
    """derive_risk_grade 시그니처에 session 파라미터가 없다 — 순수 함수(DB 접근 0)임을 구조로 확인."""
    from app.services.gate_service import derive_risk_grade

    params = list(inspect.signature(derive_risk_grade).parameters)
    assert params == ["posture", "gate_type"]


# ── list_gates/get_gate_endpoint 라우트(mocked session) risk_grade enrich 배선 ──


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
async def test_get_gate_endpoint_populates_risk_grade():
    from app.routers import gates as gates_mod
    from app.routers.gates import get_gate_endpoint

    org_id, gate_id, story_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    gate = _gate(org_id, story_id, "story", gate_type="merge", gate_id=gate_id)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(gate))
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "resolve_work_item_project_id",
                       AsyncMock(return_value=project_id)), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)), \
         patch.object(gates_mod, "_resolve_work_item_summary", AsyncMock(return_value=None)), \
         patch.object(gates_mod, "get_org_posture", AsyncMock(return_value="balanced")) as posture_spy:
        result = await get_gate_endpoint(id=gate_id, session=session, org_id=org_id, auth=auth)

    assert result.risk_grade == "high"  # balanced + merge(2차 축) → high
    posture_spy.assert_awaited_once_with(session, org_id)


@pytest.mark.anyio
async def test_get_gate_endpoint_risk_grade_low_permissive():
    from app.routers import gates as gates_mod
    from app.routers.gates import get_gate_endpoint

    org_id, gate_id, story_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    # gate_type=merge(2차 축이면 high)인데 posture=permissive(1차 축)가 이겨 low여야 함.
    gate = _gate(org_id, story_id, "story", gate_type="merge", gate_id=gate_id)
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_scalar_result(gate))
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "resolve_work_item_project_id",
                       AsyncMock(return_value=project_id)), \
         patch.object(gates_mod, "has_project_access", AsyncMock(return_value=True)), \
         patch.object(gates_mod, "_resolve_work_item_summary", AsyncMock(return_value=None)), \
         patch.object(gates_mod, "get_org_posture", AsyncMock(return_value="permissive")):
        result = await get_gate_endpoint(id=gate_id, session=session, org_id=org_id, auth=auth)

    assert result.risk_grade == "low"  # 1차 축(posture)이 2차 축(gate_type)을 이김


@pytest.mark.anyio
async def test_list_gates_populates_risk_grade_for_all_rows():
    from app.routers import gates as gates_mod
    from app.routers.gates import list_gates

    org = uuid.uuid4()
    gates = [
        _gate(org, uuid.uuid4(), "story", gate_type="merge"),
        _gate(org, uuid.uuid4(), "task", gate_type="qa"),
    ]
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = gates
    session = AsyncMock()
    session.execute = AsyncMock(return_value=gates_res)
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "get_org_posture", AsyncMock(return_value=None)) as posture_spy:
        out = await list_gates(work_item_id=None, work_item_type=None, status=None,
                                session=session, org_id=org, auth=auth)

    assert out[0].risk_grade == "high"  # posture=None(미설정) + merge → 2차 축 high
    assert out[1].risk_grade == "low"   # posture=None + qa → 2차 축 low
    posture_spy.assert_awaited_once_with(session, org)  # 목록 전체에 org posture 1회만 조회(N+1 0)


@pytest.mark.anyio
async def test_list_gates_empty_skips_posture_query():
    """gate 0건이면 org posture 조회 자체를 스킵(불필요한 쿼리 0)."""
    from app.routers import gates as gates_mod
    from app.routers.gates import list_gates

    org = uuid.uuid4()
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = []
    session = AsyncMock()
    session.execute = AsyncMock(return_value=gates_res)
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "get_org_posture",
                       AsyncMock(side_effect=AssertionError("호출되면 안 됨"))) as posture_spy:
        out = await list_gates(work_item_id=None, work_item_type=None, status=None,
                                session=session, org_id=org, auth=auth)

    assert out == []
    posture_spy.assert_not_called()


@pytest.mark.anyio
async def test_list_gates_risk_grade_independent_of_member_gate_override_disposition():
    """같은 posture인데 (테스트 상) member_gate_override류 disposition 신호가 섞여도 risk_grade는
    영향받지 않음을 보이는 구조 확인 — get_org_posture는 OrgGatePolicy만 조회하므로 gate의 다른
    필드(status 등, disposition 해소 결과로 정해짐)와 무관하게 risk_grade가 gate_type/posture만의
    함수로 결정된다."""
    from app.routers import gates as gates_mod
    from app.routers.gates import list_gates

    org = uuid.uuid4()
    # 두 gate 모두 gate_type=merge·posture=balanced 로 동일 risk_grade(high) 여야 하는데,
    # 하나는 status=auto_passed(disposition=allow_auto 로 해소된 것처럼 시뮬레이션), 하나는
    # status=pending(disposition=ask 로 해소된 것처럼 시뮬레이션) — disposition 차이가 있어도
    # risk_grade는 동일해야 함(별개 축).
    g1 = _gate(org, uuid.uuid4(), "story", gate_type="merge")
    g1.status = "auto_passed"
    g2 = _gate(org, uuid.uuid4(), "story", gate_type="merge")
    g2.status = "pending"
    gates_res = MagicMock()
    gates_res.scalars.return_value.all.return_value = [g1, g2]
    session = AsyncMock()
    session.execute = AsyncMock(return_value=gates_res)
    auth = SimpleNamespace(user_id=str(uuid.uuid4()))

    with patch.object(gates_mod, "get_org_posture", AsyncMock(return_value="balanced")):
        out = await list_gates(work_item_id=None, work_item_type=None, status=None,
                                session=session, org_id=org, auth=auth)

    assert out[0].risk_grade == "high"
    assert out[1].risk_grade == "high"
    assert out[0].status != out[1].status  # disposition 축(status)은 다르지만
    assert out[0].risk_grade == out[1].risk_grade  # risk_grade(별개 축)는 동일


# ── realdb 통합 ──────────────────────────────────────────────────────────────

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401 — 전 모델 메타데이터 로드

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


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_high_risk_gate_conservative_posture_get_and_list():
    """posture=conservative → gate_type 무관 항상 high. GET /{id}·GET "" 둘 다에서 실측."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            s.add(OrgGatePolicy(org_id=seeded["org_id"], posture="conservative"))
            await s.commit()
            # gate_type=pr_review(2차 축이면 원래 low)인데 posture=conservative가 이겨 high여야 함.
            story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                          title="고위험 대상 스토리")
            s.add(story)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                        work_item_type="story", gate_type="pr_review", status="pending")
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["risk_grade"] == "high", body
            assert body["gate_type"] == "pr_review"

            resp_list = await client.get("/api/v2/gates", params={"work_item_id": str(story.id)})
            assert resp_list.status_code == 200, resp_list.text
            list_body = resp_list.json()
            assert len(list_body) == 1
            assert list_body[0]["risk_grade"] == "high", list_body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_low_risk_gate_permissive_posture_overrides_gate_type_get_and_list():
    """posture=permissive → gate_type=merge(2차 축이면 원래 high)여도 1차 축이 이겨 low.
    GET /{id}·GET "" 둘 다에서 실측 + member_gate_override(disposition 축)가 있어도 risk_grade
    (별개 축)엔 무영향임을 같은 실측에서 확인."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.hitl_config import MemberGateOverride, OrgGatePolicy
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            s.add(OrgGatePolicy(org_id=seeded["org_id"], posture="permissive"))
            await s.commit()
            story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                          title="저위험 대상 스토리")
            s.add(story)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                        work_item_type="story", gate_type="merge", status="pending")
            s.add(gate)
            await s.commit()
            gate_id = gate.id
            # member_gate_override(disposition=deny) 존재 — resolve_disposition() 경로였다면
            # gate 생성 disposition/status에 영향을 줬을 신호지만, risk_grade는 posture만 직접
            # 조회하므로 이 override와 완전 무관해야 한다.
            s.add(MemberGateOverride(
                id=uuid.uuid4(), org_id=seeded["org_id"], member_id=seeded["caller_id"],
                gate_type="merge", disposition="deny",
            ))
            await s.commit()

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["risk_grade"] == "low", body  # 1차 축(permissive)이 2차 축(merge)을 이김
            assert body["gate_type"] == "merge"

            resp_list = await client.get("/api/v2/gates", params={"work_item_id": str(story.id)})
            assert resp_list.status_code == 200, resp_list.text
            list_body = resp_list.json()
            assert len(list_body) == 1
            assert list_body[0]["risk_grade"] == "low", list_body
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_balanced_posture_falls_to_gate_type_axis():
    """posture=balanced(2차 축 위임) → gate_type=qa면 low, gate_type=deploy면 high. 두 게이트를
    한 목록에서 실측(GET "")."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            s.add(OrgGatePolicy(org_id=seeded["org_id"], posture="balanced"))
            await s.commit()
            story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                          title="balanced 대상 스토리")
            s.add(story)
            await s.commit()
            gate_low = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                             work_item_type="story", gate_type="qa", status="pending")
            gate_high = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                              work_item_type="story", gate_type="deploy", status="pending")
            s.add_all([gate_low, gate_high])
            await s.commit()

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp_list = await client.get("/api/v2/gates", params={"work_item_id": str(story.id)})
            assert resp_list.status_code == 200, resp_list.text
            by_type = {row["gate_type"]: row["risk_grade"] for row in resp_list.json()}
            assert by_type == {"qa": "low", "deploy": "high"}, by_type

            resp_qa = await client.get(f"/api/v2/gates/{gate_low.id}")
            assert resp_qa.json()["risk_grade"] == "low"
            resp_deploy = await client.get(f"/api/v2/gates/{gate_high.id}")
            assert resp_deploy.json()["risk_grade"] == "high"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_no_org_policy_row_falls_to_gate_type_axis():
    """OrgGatePolicy row 자체가 없을 때(미설정) posture=None 취급 → 2차 축(gate_type)으로 판정."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.pm import Story

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_common(s)
            # ⚠️OrgGatePolicy row 의도적으로 미생성 — org당 1행 미설정 케이스.
            story = Story(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                          title="정책 미설정 스토리")
            s.add(story)
            await s.commit()
            gate = Gate(id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=story.id,
                        work_item_type="story", gate_type="workflow_config_publish", status="pending")
            s.add(gate)
            await s.commit()
            gate_id = gate.id

        await _setup_app(app, Session, seeded["org_id"], seeded["caller_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["risk_grade"] == "high"  # 미설정 → 2차 축(workflow_config_publish→high)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
