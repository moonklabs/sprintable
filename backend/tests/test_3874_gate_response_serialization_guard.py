"""story #3874(customer-zero·BE·응답 계약) — GateResponse 직렬화 단일 통로 회귀가드.

배경(story #3868 AC0 실측): `GateResponse.model_validate(gate)` 직접 호출 17곳 中 risk_grade
enrich(`resp.risk_grade = derive_risk_grade(...)`)가 있는 곳은 3곳(list_gates·get_gate_endpoint·
create_decision_request)뿐이었다 — 나머지 12곳(transition 포함, 고위험 note 검증 때문에 그 값을
이미 계산해 놓고도 응답엔 안 실었다)은 늘 risk_grade=None을 냈다. 같은 모델을 두 경로로
직렬화하는(twin-system) 클래스 결함이라 개별 12곳 패치 대신 `to_gate_response()`(model_validate+
enrich를 한 자리로 묶은 단일 통로) 하나로 gates.py의 model_validate 호출 17곳 전부를 교체했다.

이 파일의 판정 축 셋:
① AST 정적 스캔 — `to_gate_response` 자신을 뺀 gates.py의 그 어떤 함수도 `GateResponse.
   model_validate(...)`를 직접 안 부른다(재발 시 새 엔드포인트가 또 null을 낼 수 없다).
② 함수 목록째 순회 — GateResponse를 내는 걸로 알려진 라우트 함수 15개(내부 구현 함수
   기준·public wrapper는 얇은 위임이라 제외) 전부가 `to_gate_response`를 직접 호출한다.
③ 실PG 데이터 정확성 — `to_gate_response`가 실제 Gate 행에 대해 derive_risk_grade와 정확히
   같은 값을 낸다(posture 4종 × gate_type 대표 2종).
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

_GATES_PY_PATH = Path(__file__).resolve().parents[1] / "app" / "routers" / "gates.py"

# story #3874 AC1 처방 대상 — GateResponse를 내는 걸로 확認된 내부 구현 함수 15개(public
# `@router.*` wrapper는 이 함수들에 얇게 위임할 뿐이라 스코프 밖 — 실제 model_validate 호출은
# 전부 아래 함수들 안에 있었다).
_GATE_RESPONSE_PRODUCING_FUNCTIONS = frozenset({
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
})


def _parse_gates_module() -> ast.Module:
    return ast.parse(_GATES_PY_PATH.read_text(encoding="utf-8"), filename=str(_GATES_PY_PATH))


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


def _top_level_functions(module: ast.Module) -> dict[str, ast.AsyncFunctionDef]:
    return {
        node.name: node
        for node in ast.walk(module)
        if isinstance(node, ast.AsyncFunctionDef)
    }


def test_no_bare_model_validate_call_outside_to_gate_response():
    """① — `to_gate_response` 자신을 뺀 그 어떤 함수도 GateResponse.model_validate를
    직접 안 부른다. ⭐뮤테이션 표적: 새 엔드포인트가 이 헬퍼를 안 거치고 직접
    model_validate를 부르면 이 테스트가 즉시 RED(risk_grade 재발 원천 차단)."""
    module = _parse_gates_module()
    functions = _top_level_functions(module)
    assert "to_gate_response" in functions, "to_gate_response 헬퍼 자체가 없다(파일 구조 변경?)"

    offenders: list[str] = []
    for name, fn_node in functions.items():
        if name == "to_gate_response":
            continue
        for node in ast.walk(fn_node):
            if _is_model_validate_call(node):
                offenders.append(name)
                break
    assert offenders == [], (
        f"GateResponse.model_validate를 직접 호출하는 함수(to_gate_response 밖): {offenders} "
        "— to_gate_response()로 교체할 것(story #3874)."
    )


def test_all_known_gate_response_routes_use_the_single_serializer():
    """② — GateResponse를 내는 걸로 확認된 함수 15개 전부가 to_gate_response를 직접
    호출한다(목록째 순회). 새 라우트가 이 목록에 추가되고도 헬퍼를 안 쓰면 이 테스트가
    잡지 못하므로(목록 자체가 갱신 안 됐을 수 있어) ①(전수 AST 스캔)이 최종 안전판."""
    module = _parse_gates_module()
    functions = _top_level_functions(module)

    missing: list[str] = []
    for name in _GATE_RESPONSE_PRODUCING_FUNCTIONS:
        assert name in functions, f"함수 {name}이 gates.py에서 사라졌다(리팩터 확認 필요)"
        fn_node = functions[name]
        calls_helper = any(_is_to_gate_response_call(node) for node in ast.walk(fn_node))
        if not calls_helper:
            missing.append(name)
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
