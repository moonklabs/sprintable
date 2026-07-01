"""E-LOOP-LEDGER S22(story 6844837b): POST /api/v2/loops/{loop_id}/transition 검증.

S22 고유 가치(비-tautological):
ⓐ 합법 전이 5종(화이트리스트 대상) 성공 + 역전이/스킵전이 409(is_valid_transition SSOT).
ⓑ ⭐executing/closed 직접요청 422(S5/S7 전제 우회 차단 — 이 스토리의 핵심 안전장치).
ⓒ terminal(closed/abandoned) 상태에서 전 target 거부.
ⓓ cross-project 403(root-fix 재확인) + agent 통과(human-only 아님, S5와 대비).

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.routers import loops as r
from app.schemas.loop import LoopTransitionRequest
from app.services.loop import LOOP_TRANSITION_ALLOWED_TARGETS, LoopServiceError

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 유닛(DB 불요) ────────────────────────────────────────────────────────────

def test_error_status_map_covers_transition_codes():
    expected = {"TRANSITION_NOT_ALLOWED", "INVALID_LOOP_TRANSITION"}
    assert expected <= set(r._ERROR_STATUS)


def test_allowed_targets_excludes_executing_and_closed():
    """S5/S7 전용 전이는 화이트리스트에 구조적으로 없다 — 이게 이 스토리의 핵심 안전장치."""
    assert "executing" not in LOOP_TRANSITION_ALLOWED_TARGETS
    assert "closed" not in LOOP_TRANSITION_ALLOWED_TARGETS
    assert LOOP_TRANSITION_ALLOWED_TARGETS == {
        "briefing", "generating", "deciding", "measuring", "abandoned",
    }


@pytest.mark.parametrize("code,status", [
    ("TRANSITION_NOT_ALLOWED", 422),
    ("INVALID_LOOP_TRANSITION", 409),
])
def test_raise_maps_transition_code_to_status(code, status):
    with pytest.raises(HTTPException) as ei:
        r._raise(LoopServiceError(code, "msg"))
    assert ei.value.status_code == status


# ── realdb ───────────────────────────────────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("21000000-0000-0000-0000-000000000001")
USER = uuid.UUID("21000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("21000000-0000-0000-0000-0000000000b1")
AGENT = uuid.UUID("21000000-0000-0000-0000-0000000000d1")
PROJ_A = uuid.UUID("21000000-0000-0000-0000-000000000002")
PROJ_B = uuid.UUID("21000000-0000-0000-0000-000000000003")


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


def _agent_auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AGENT), email=None,
        claims={"app_metadata": {"api_key_id": "ak_test", "org_id": str(ORG)}},
        org_id=str(ORG),
    )


async def _seed(s):
    for sql in [
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C21','c21org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@c21.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{AGENT}','{ORG}','agent','Ag',true)",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
        f"INSERT INTO project_access (id,project_id,org_member_id,member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}',NULL,'{AGENT}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_loop(s, status, project_id=PROJ_A) -> uuid.UUID:
    from app.repositories.loop import LoopRunRepository
    repo = LoopRunRepository(s, ORG)
    loop = await repo.create(
        project_id=project_id, title="L", goal_tags=[], status=status,
        created_by_member_id=uuid.uuid4(),
    )
    await s.commit()
    return loop.id


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ── ⓐ 합법 전이 5종 ────────────────────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
@pytest.mark.parametrize("from_status,target", [
    ("draft", "briefing"),
    ("briefing", "generating"),
    ("generating", "deciding"),
    ("executing", "measuring"),
    ("draft", "abandoned"),
])
async def test_legal_transitions_succeed(from_status, target):
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, from_status)
        async with Session() as s:
            out = await r.transition_loop(
                loop_id=loop_id, body=LoopTransitionRequest(status=target),
                session=s, auth=_auth(), org_id=ORG,
            )
            assert out.status == target
    finally:
        await eng.dispose()


# ── ⓐ 역전이/스킵전이 거부 ──────────────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
@pytest.mark.parametrize("from_status,target", [
    ("measuring", "briefing"),   # 역전이
    ("draft", "deciding"),       # 스킵(briefing/generating 건너뜀)
    ("generating", "briefing"),  # 역전이(둘 다 화이트리스트 안 — FSM 게이트 자체를 검증)
])
async def test_illegal_transitions_rejected_409(from_status, target):
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, from_status)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.transition_loop(
                    loop_id=loop_id, body=LoopTransitionRequest(status=target),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 409
            assert ei.value.detail["code"] == "INVALID_LOOP_TRANSITION"
    finally:
        await eng.dispose()


# ── ⓑ executing/closed 직접요청 422(핵심 안전장치) ───────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_direct_executing_request_blocked_422():
    """deciding→executing은 FSM상 합법이지만, 이 제네릭 엔드포인트로는 화이트리스트가
    먼저 막는다 — S5의 '전 슬롯 결정됨' 전제를 우회하지 못하게."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, "deciding")
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.transition_loop(
                    loop_id=loop_id, body=LoopTransitionRequest(status="executing"),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "TRANSITION_NOT_ALLOWED"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_direct_closed_request_blocked_422():
    """measuring→closed도 FSM상 합법이지만 화이트리스트가 막는다 — S7의 'hypothesis 해소됨'
    전제를 우회하지 못하게(결정 없이 loop을 그냥 종료 못 함)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, "measuring")
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.transition_loop(
                    loop_id=loop_id, body=LoopTransitionRequest(status="closed"),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "TRANSITION_NOT_ALLOWED"
    finally:
        await eng.dispose()


# ── ⓒ terminal 상태 전 target 거부 ────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
@pytest.mark.parametrize("terminal", ["closed", "abandoned"])
async def test_terminal_state_rejects_all_targets(terminal):
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, terminal)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.transition_loop(
                    loop_id=loop_id, body=LoopTransitionRequest(status="briefing"),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 409
            assert ei.value.detail["code"] == "INVALID_LOOP_TRANSITION"
    finally:
        await eng.dispose()


# ── ⓓ cross-project 차단 + agent 통과(human-only 아님) ───────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_transition_cross_project_forbidden_403():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, "draft", project_id=PROJ_B)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.transition_loop(
                    loop_id=loop_id, body=LoopTransitionRequest(status="briefing"),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_transition_agent_allowed_not_human_only():
    """S5(결정)와 대비 — 진행 전이는 agent도 가능(HITL 판단점 아님). agent는 PROJ_A grant만 있음."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, "draft", project_id=PROJ_A)
        async with Session() as s:
            out = await r.transition_loop(
                loop_id=loop_id, body=LoopTransitionRequest(status="briefing"),
                session=s, auth=_agent_auth(), org_id=ORG,
            )
            assert out.status == "briefing"
    finally:
        await eng.dispose()
