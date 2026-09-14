"""story #3874(customer-zero·BE·응답 계약) — GateResponse 직렬화 단일 통로 회귀가드.

배경(story #3868 AC0 실측): `GateResponse.model_validate(gate)` 직접 호출 15곳 中 risk_grade
enrich(`resp.risk_grade = derive_risk_grade(...)`)가 있는 곳은 3곳(list_gates·get_gate_endpoint·
create_decision_request)뿐이었다 — 나머지 12곳(transition 포함, 고위험 note 검증 때문에 그 값을
이미 계산해 놓고도 응답엔 안 실었다)은 늘 risk_grade=None을 냈다. 같은 모델을 두 경로로
직렬화하는(twin-system) 클래스 결함이라 개별 12곳 패치 대신 `to_gate_response()`(model_validate+
enrich를 한 자리로 묶은 단일 통로) 하나로 gates.py의 model_validate 호출 15곳 전부를 교체했다.

이 파일의 판정 축 넷:
① AST 정적 스캔 — `to_gate_response` 자신을 뺀 gates.py의 그 어떤 함수도 `GateResponse.
   model_validate(...)`를 직접 안 부른다(재발 시 새 엔드포인트가 또 null을 낼 수 없다).
② 함수 목록째 순회 — GateResponse를 내는 걸로 알려진 라우트 함수 15개(내부 구현 함수
   기준·public wrapper는 얇은 위임이라 제외) 전부가 `to_gate_response`를 직접 호출한다.
③ 실PG 데이터 정확성 — `to_gate_response`가 실제 Gate 행에 대해 derive_risk_grade와 정확히
   같은 값을 낸다(posture 4종 × gate_type 대표 2종).
④ 실PG 라우트 레벨(페드루 CHANGES ③) — ①②는 «호출»만 보고 «반환값»은 안 본다. 원 사고
   자리인 POST /gates/{id}/transition을 실 HTTP 경로로 태워 risk_grade가 non-null이고
   derive_risk_grade와 정확히 같은지 직접 확인한다(test_3868_*_realdb의 override_db_and_read
   패턴 재사용). 양성대조: transition을 model_validate로 되돌리면 ①과 이 케이스 둘 다 RED.
"""
from __future__ import annotations

import ast
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# realdb 섹션이 Base.metadata.create_all을 호출한다 — conftest.py AST 가드(story 8236bbc3) 대응.
pytestmark = pytest.mark.destructive_schema

_APP_ROOT = Path(__file__).resolve().parents[1] / "app"
_GATES_PY_PATH = _APP_ROOT / "routers" / "gates.py"
_STORIES_PY_PATH = _APP_ROOT / "routers" / "stories.py"

# story #3874 AC1 처방 대상 — GateResponse를 내는 걸로 확認된 함수 16개(public `@router.*`
# wrapper는 내부 구현 함수에 얇게 위임할 뿐이라 스코프 밖). 페드루 CHANGES ④(2026-09-14) —
# 같은 결함 클래스가 gates.py 밖에도 1곳 더 있었다: stories.py::request_verification이
# GateResponse.model_validate(gate)를 직접 반환해 risk_grade가 늘 null이었다(가드 ①이
# gates.py만 스캔해 그 자리는 GREEN인 채 남아 있었다 — 지정 경로만 막는 fix는 클래스를
# 남긴다는 교훈. ①의 스캔 범위를 backend/app 전수로 넓힌 이유이기도 하다).
_GATE_RESPONSE_PRODUCING_FUNCTIONS: dict[Path, frozenset[str]] = {
    _GATES_PY_PATH: frozenset({
        "_create_gate_endpoint",
        "create_decision_request",
        "list_gates",
        "get_gate_endpoint",
        "_transition_gate_endpoint",
        "_reevaluate_gate_endpoint",
        "withdraw_gate_endpoint",
        "_void_gate_endpoint",
        "_hold_gate_endpoint",
        "_unhold_gate_endpoint",
        "undo_gate_resolution_endpoint",
        "_request_gate_discussion_endpoint",
        "_delegate_gate_endpoint",
        "_toss_gate_endpoint",
        "_override_gate_endpoint",
    }),
    _STORIES_PY_PATH: frozenset({"request_verification"}),
}


def _parse_module(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _is_model_validate_call(node: ast.AST) -> bool:
    """`GateResponse.model_validate(...)` 형태의 Call만 — 문자열/주석은 AST에 안 실리므로
    docstring 안 리터럴 언급과 오탐 0."""
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "model_validate"
        and isinstance(func.value, ast.Name)
        and func.value.id == "GateResponse"
    )


def _is_to_gate_response_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if isinstance(func, ast.Name):
        return func.id == "to_gate_response"
    if isinstance(func, ast.Attribute):
        return func.attr == "to_gate_response"
    return False


def _functions_in(module: ast.Module) -> dict[str, ast.AST]:
    return {
        node.name: node
        for node in ast.walk(module)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def test_no_bare_model_validate_call_outside_to_gate_response():
    """① — backend/app 전수 스캔(페드루 CHANGES ④ — gates.py만 보던 원래 스코프가
    stories.py:2984의 같은 결함을 놓쳤다). `to_gate_response`(gates.py에 정의된 그 함수
    자신)를 뺀 그 어떤 함수도 GateResponse.model_validate를 직접 안 부른다. ⭐뮤테이션
    표적: 새 엔드포인트가(어느 라우터 파일이든) 이 헬퍼를 안 거치고 직접 model_validate를
    부르면 이 테스트가 즉시 RED(risk_grade 재발 원천 차단)."""
    offenders: list[str] = []
    for path in sorted(_APP_ROOT.rglob("*.py")):
        tree = _parse_module(path)
        for name, fn_node in _functions_in(tree).items():
            if name == "to_gate_response" and path == _GATES_PY_PATH:
                continue
            for node in ast.walk(fn_node):
                if _is_model_validate_call(node):
                    offenders.append(f"{path.relative_to(_APP_ROOT.parent)}::{name}")
                    break
    assert offenders == [], (
        f"GateResponse.model_validate를 직접 호출하는 함수(to_gate_response 밖): {offenders} "
        "— to_gate_response()로 교체할 것(story #3874)."
    )


def test_all_known_gate_response_routes_use_the_single_serializer():
    """② — GateResponse를 내는 걸로 확認된 함수 16개(gates.py 15 + stories.py 1) 전부가
    to_gate_response를 직접 호출한다(목록째 순회). 새 라우트가 이 목록에 추가되고도
    헬퍼를 안 쓰면 이 테스트가 잡지 못하므로(목록 자체가 갱신 안 됐을 수 있어) ①(전수
    AST 스캔)이 최종 안전판."""
    missing: list[str] = []
    for path, names in _GATE_RESPONSE_PRODUCING_FUNCTIONS.items():
        functions = _functions_in(_parse_module(path))
        for name in names:
            assert name in functions, f"함수 {name}이 {path.name}에서 사라졌다(리팩터 확認 필요)"
            fn_node = functions[name]
            calls_helper = any(_is_to_gate_response_call(node) for node in ast.walk(fn_node))
            if not calls_helper:
                missing.append(f"{path.name}::{name}")
    assert missing == [], f"to_gate_response를 안 부르는 함수: {missing}"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_to_gate_response_matches_derive_risk_grade_realdb():
    """③ — 실PG: 실제 Gate 행 + 실제 OrgGatePolicy(또는 없음) 조합에 대해 to_gate_response가
    derive_risk_grade(posture, gate_type)와 정확히 같은 risk_grade를 낸다. posture 4종
    (conservative·permissive·balanced·행 없음) × gate_type 대표 2종(merge·pr_review)."""
    if not _REAL_DB_URL:
        pytest.skip("PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 미설정")

    from app.models.base import Base
    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.routers.gates import to_gate_response
    from app.services.gate_service import derive_risk_grade

    engine = create_async_engine(_REAL_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    org_id = uuid.uuid4()

    async with SessionLocal() as session:
        for posture in ("conservative", "permissive", "balanced", None):
            if posture is not None:
                session.add(OrgGatePolicy(org_id=org_id, posture=posture))
                await session.commit()
            for gate_type in ("merge", "pr_review"):
                gate = Gate(
                    id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(),
                    work_item_type="story", gate_type=gate_type, status="pending",
                )
                session.add(gate)
                await session.commit()
                await session.refresh(gate)

                resp = await to_gate_response(session, org_id, gate)
                expected = derive_risk_grade(posture, gate_type)
                assert resp.risk_grade == expected, (
                    f"posture={posture} gate_type={gate_type}: "
                    f"resp.risk_grade={resp.risk_grade!r} != derive_risk_grade={expected!r}"
                )
            if posture is not None:
                await session.execute(
                    OrgGatePolicy.__table__.delete().where(OrgGatePolicy.org_id == org_id)
                )
                await session.commit()

    await engine.dispose()


@pytest.mark.anyio
async def test_transition_endpoint_returns_non_null_risk_grade_matching_derive_realdb():
    """④(페드루 CHANGES ③) — ①②는 «호출»만 보고 «반환값»은 안 본다. 원 사고 자리인
    POST /gates/{id}/transition을 실 HTTP 경로로 태워(test_3868_*_realdb의
    override_db_and_read 패턴 재사용) risk_grade가 non-null이고 derive_risk_grade와
    정확히 같은지 직접 확인한다. posture=permissive+gate_type=pr_review(→low)를 골라
    고위험 note 강제 분기(story #2027)를 피하고 이 테스트의 관심사(응답 body의
    risk_grade 값 자체)에 집중한다. 양성대조(수동 확認, 커밋본 유지): transition
    끝의 to_gate_response 호출을 GateResponse.model_validate(gate)로 되돌리면
    ①(전수 AST 스캔)과 이 케이스 둘 다 RED."""
    if not _REAL_DB_URL:
        pytest.skip("PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 미설정")

    from httpx import AsyncClient, ASGITransport
    from app.main import app
    from app.models.base import Base
    from app.models.gate import Gate
    from app.models.hitl_config import OrgGatePolicy
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.dependencies.auth import AuthContext, get_current_user
    from app.services.gate_service import derive_risk_grade
    from tests.conftest import override_db_and_read

    engine = create_async_engine(_REAL_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org3874", slug=f"org3874-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()

            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()

            user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
            s.add(user)
            await s.flush()
            om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="owner")
            s.add(om)
            await s.flush()
            member = Member(id=om.id, org_id=org.id, type="human", user_id=user.id, name="caller")
            s.add(member)
            await s.flush()
            s.add(ProjectAccess(project_id=project.id, org_member_id=om.id, member_id=member.id, role="member"))
            await s.commit()

            s.add(OrgGatePolicy(org_id=org.id, posture="permissive"))
            await s.commit()

            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=uuid.uuid4(),
                work_item_type="story", gate_type="pr_review", status="pending",
            )
            s.add(gate)
            await s.commit()
            await s.refresh(gate)

        async def _db():
            async with Session() as s2:
                try:
                    yield s2
                    await s2.commit()
                except Exception:
                    await s2.rollback()
                    raise

        async def _auth():
            return AuthContext(
                user_id=str(user.id), email="human@test",
                claims={"app_metadata": {"org_id": str(org.id)}},
            )

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth

        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            resp = await client.post(
                f"/api/v2/gates/{gate.id}/transition", json={"status": "approved"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            expected = derive_risk_grade("permissive", "pr_review")
            assert body["risk_grade"] is not None, f"risk_grade가 null — story #3874 재발: {body}"
            assert body["risk_grade"] == expected, (
                f"risk_grade={body['risk_grade']!r} != derive_risk_grade={expected!r}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
