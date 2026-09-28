"""story #4080(E-RECIPE-1, PO 라이브 실측 2026-09-20·PO 方向정정) — `GET /api/v2/gates?
gate_type=...` 필터가 `hitl_config.GATE_TYPES`("generic POST /api/v2/gates로 생성 허용"
세트)를 조회 값 SSOT로 재사용해, 그 관문을 안 거치고 만들어지는 gate_type(전용 서비스코드가
`create_gate()`를 직접 호출하는 자리)을 전부 422로 거부했다 — 실사고: 레시피 예산 게이트
(gate_type="generation_budget")를 필터로 못 골랐다.

더 깊게는 recipe_gate_hooks.py의 `gate_decl["type"]`(stage_metadata[stage].gate.type)가
org가 직접 짓는 완전 개방 문자열이라(validate_stage_metadata는 "비어있지 않은 문자열"만
강제, 닫힌 어휘 아님) "실존 gate_type 전수"는 코드 레벨 고정 enum으로 못 담는다 — 그래서
처방은 소속 검사를 걷고 형식(lower_snake_case, 길이 상한)만 본다(routers/gates.py::
list_gates, `_GATE_TYPE_FILTER_PATTERN`).

AC3 — realdb에 (a) generation_budget (b) support_escalation_review (c) org가 직접 지은
recipe gate.type(예: "campaign_review") 3종을 심고 각각 필터로 정확히 매칭되는지(200+
정확 집합) 확認. 뮤테이션 pin: 필터를 다시 GATE_TYPES 소속 검사로 되돌리면 이 세 케이스가
전부(GATE_TYPES 밖이므로) 422로 RED가 된다."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("40800000-0000-0000-0000-000000000001")
OWNER_USER = uuid.UUID("40800000-0000-0000-0000-0000000000a1")
OWNER_OM = uuid.UUID("40800000-0000-0000-0000-0000000000b1")
PROJ = uuid.UUID("40800000-0000-0000-0000-0000000000c1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth_human(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> dict[str, uuid.UUID]:
    """ORG·PROJ·human owner(project_access) + gate_type 3종(generation_budget·
    support_escalation_review·org 자작 recipe gate.type "campaign_review") 각 1건 —
    work_item(story)마다 새로 만들어 uq_gate_work_item_gate_type 유니크 제약을 피한다
    (test_2864의 _insert_gate와 동형 관례). {gate_type: gate_id} 반환."""
    for sql in [
        f"DELETE FROM gate WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{OWNER_USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S4080','s4080-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{OWNER_USER}','owner@s4080.test','x','Owner',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OWNER_OM}','{ORG}','{OWNER_USER}','member')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','s4080-proj','warn')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{OWNER_OM}','granted','owner')",
    ]:
        await s.execute(text(sql))

    gate_ids: dict[str, uuid.UUID] = {}
    for i, gate_type in enumerate(("generation_budget", "support_escalation_review", "campaign_review"), start=1):
        story_id = uuid.uuid4()
        gid = uuid.uuid4()
        await s.execute(text(
            "INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES "
            f"('{story_id}','{ORG}','{PROJ}','S','backlog','medium')"
        ))
        await s.execute(text(
            "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,status,"
            "neutral_facts,created_at) VALUES "
            f"('{gid}','{ORG}','{story_id}','story','{gate_type}','pending','{{}}',"
            f"now() + interval '{i} seconds')"
        ))
        gate_ids[gate_type] = gid
    await s.commit()
    return gate_ids


@pytest.mark.anyio
@pytest.mark.parametrize("gate_type", ["generation_budget", "support_escalation_review", "campaign_review"])
async def test_non_generic_and_org_custom_gate_types_are_filterable(gate_type: str):
    """⭐AC3 핵심 — GATE_TYPES(generic POST 생성 허용 세트) 밖인 세 gate_type 전부 200+
    정확히 그 게이트 하나만 반환한다. `campaign_review`는 어떤 코드 상수 목록에도 없는
    org 자작 recipe gate.type 대역(닫힌 소속 검사로는 원천적으로 못 미리 등재하는 값)."""
    from app.routers.gates import list_gates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_ids = await _seed(s)

        async with Session() as s:
            listed = await list_gates(
                work_item_id=None, work_item_type=None, status=None, gate_type=gate_type,
                sort=None, assigned_to_me=False, limit=100, offset=0,
                session=s, org_id=ORG, auth=_auth_human(OWNER_USER),
            )
        assert {g.id for g in listed} == {gate_ids[gate_type]}, (
            f"gate_type={gate_type!r} 필터가 정확히 그 게이트 1건만 못 돌려줌 — {listed}"
        )
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_format_violating_gate_type_rejected_422_even_for_open_vocab():
    """소속 검사는 걷었지만 형식 검사는 산다 — 명백한 오입력(대문자·공백)은 여전히 422."""
    from app.routers.gates import list_gates

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await list_gates(
                    work_item_id=None, work_item_type=None, status=None, gate_type="Campaign Review!",
                    sort=None, assigned_to_me=False, limit=100, offset=0,
                    session=s, org_id=ORG, auth=_auth_human(OWNER_USER),
                )
        assert exc_info.value.status_code == 422
    finally:
        await eng.dispose()
