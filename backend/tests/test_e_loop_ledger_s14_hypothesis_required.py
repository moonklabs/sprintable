"""E-LOOP-LEDGER S14(story ad1604de·P2): loop 생성 시 hypothesis 필수 + FSM 게이트.

AC(BE): `POST /loops`가 goal+metric_definition+measure_after(또는 hypothesis_id) 없으면 거부.
FSM: hypothesis `active`(인간 confirm) 전엔 loop `briefing→generating` 차단. loop 경계에서만
(보드 전역 hypothesis 필수화 아님).

⭐비-tautological 핵심: 까심 QA가 E2E에서 실제로 재현한 갭 — **proposed 상태 hypothesis를 가진
loop이 executing까지 진행**됐던 그 시나리오를 그대로 박아 넣는다(briefing→generating 시도가
차단되는지, 그 결과 executing까지 아예 도달 불가능한지). fix 제거 시 이 테스트가 실제로 통과
(=버그 재현)하는 것을 확인 후 복원.

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.routers import loops as r
from app.schemas.loop import LoopCreate, LoopTransitionRequest

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── 유닛(DB 불요) — 신규 오류 code 등록 ────────────────────────────────────────

def test_error_status_map_covers_s14_codes():
    expected = {"LOOP_HYPOTHESIS_REQUIRED", "HYPOTHESIS_NOT_ACTIVE"}
    assert expected <= set(r._ERROR_STATUS)
    assert r._ERROR_STATUS["LOOP_HYPOTHESIS_REQUIRED"] == 400
    assert r._ERROR_STATUS["HYPOTHESIS_NOT_ACTIVE"] == 422


# ── realdb ───────────────────────────────────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("14000000-0000-0000-0000-000000000001")
USER = uuid.UUID("14000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("14000000-0000-0000-0000-0000000000b1")
AGENT = uuid.UUID("14000000-0000-0000-0000-0000000000d1")
PROJ_A = uuid.UUID("14000000-0000-0000-0000-000000000002")


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
        f"DELETE FROM hypotheses WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ_A}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S14','s14org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@s14.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{AGENT}','{ORG}','agent','Ag',true)",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
        f"INSERT INTO project_access (id,project_id,org_member_id,member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}',NULL,'{AGENT}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_hypothesis(s, *, status="active") -> uuid.UUID:
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=ORG, project_id=PROJ_A, owner_member_id=uuid.uuid4(),
        statement="s", metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
        measure_after=datetime(2026, 1, 1, tzinfo=timezone.utc), status=status,
    )
    s.add(hyp)
    await s.commit()
    return hyp.id


async def _seed_loop(s, status, hypothesis_id=None) -> uuid.UUID:
    from app.repositories.loop import LoopRunRepository
    repo = LoopRunRepository(s, ORG)
    loop = await repo.create(
        project_id=PROJ_A, title="L", goal_tags=[], status=status,
        hypothesis_id=hypothesis_id, created_by_member_id=uuid.uuid4(),
    )
    await s.commit()
    return loop.id


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ── ① POST /loops — hypothesis_id 또는 trio 필수 ───────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_neither_hypothesis_id_nor_trio_rejected_400():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop(
                    body=LoopCreate(project_id=PROJ_A, title="bare"),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 400
            assert ei.value.detail["code"] == "LOOP_HYPOTHESIS_REQUIRED"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_partial_trio_still_rejected_400():
    """goal+metric_definition만 있고 measure_after가 빠지면 여전히 거부(셋 다 필수)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop(
                    body=LoopCreate(
                        project_id=PROJ_A, title="partial",
                        goal="개선 목표", metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
                    ),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 400
            assert ei.value.detail["code"] == "LOOP_HYPOTHESIS_REQUIRED"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_full_trio_human_caller_auto_creates_proposed_hypothesis():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            out = await r.create_loop(
                body=LoopCreate(
                    project_id=PROJ_A, title="trio-loop", goal="가입 전환율 개선",
                    metric_definition={"metric": "signup_rate", "source": "manual", "target": 10, "direction": "up"},
                    measure_after=datetime(2026, 8, 1, tzinfo=timezone.utc),
                ),
                session=s, auth=_auth(), org_id=ORG,
            )
            await s.commit()
            assert out.hypothesis_id is not None

        async with Session() as s:
            from sqlalchemy import select
            from app.models.hypothesis import Hypothesis
            row = (await s.execute(select(Hypothesis).where(Hypothesis.id == out.hypothesis_id))).scalar_one()
            assert row.statement == "가입 전환율 개선"
            assert row.status == "proposed"
            assert row.owner_member_id == OM  # 휴먼 caller 기본값(자기 자신)
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_full_trio_agent_caller_without_owner_rejected_400():
    """agent가 trio 경로를 타는데 owner_member_id 미지정 — 기존 hypothesis.create_hypothesis
    정책(HUMAN_OWNER_REQUIRED)이 그대로 관통해야 한다(새 코드가 이 검증을 우회하지 않음)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop(
                    body=LoopCreate(
                        project_id=PROJ_A, title="agent-trio", goal="g",
                        metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
                        measure_after=datetime(2026, 8, 1, tzinfo=timezone.utc),
                    ),
                    session=s, auth=_agent_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 400
            assert ei.value.detail["code"] == "HUMAN_OWNER_REQUIRED"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_full_trio_agent_caller_with_owner_succeeds():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            out = await r.create_loop(
                body=LoopCreate(
                    project_id=PROJ_A, title="agent-trio-owned", goal="g",
                    metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
                    measure_after=datetime(2026, 8, 1, tzinfo=timezone.utc),
                    owner_member_id=OM,
                ),
                session=s, auth=_agent_auth(), org_id=ORG,
            )
            assert out.hypothesis_id is not None
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_existing_hypothesis_id_path_unaffected():
    """기존 hypothesis_id-only 경로는 S14 전과 동일하게 동작(회귀0)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            hyp_id = await _seed_hypothesis(s, status="proposed")
        async with Session() as s:
            out = await r.create_loop(
                body=LoopCreate(project_id=PROJ_A, title="existing-hyp", hypothesis_id=hyp_id),
                session=s, auth=_auth(), org_id=ORG,
            )
            assert out.hypothesis_id == hyp_id
    finally:
        await eng.dispose()


# ── ② FSM: briefing→generating은 active hypothesis 전제 (까심 E2E 재현) ───────────

@pytestmark_db
@pytest.mark.anyio
async def test_briefing_to_generating_blocked_when_hypothesis_proposed_422():
    """⭐까심 E2E 재현 그대로 — hypothesis가 아직 proposed(인간 미확인)인데 generating 진입 시도
    → 422 HYPOTHESIS_NOT_ACTIVE. 이게 막히면 deciding/executing엔 원천적으로 도달 불가(FSM
    화이트리스트상 generating을 거치지 않고는 deciding으로 못 감 — S22 스킵전이 차단 재확인)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            hyp_id = await _seed_hypothesis(s, status="proposed")
            loop_id = await _seed_loop(s, "briefing", hypothesis_id=hyp_id)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.transition_loop(
                    loop_id=loop_id, body=LoopTransitionRequest(status="generating"),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "HYPOTHESIS_NOT_ACTIVE"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_briefing_to_generating_blocked_when_hypothesis_missing_422():
    """loop.hypothesis_id가 아예 None(레거시 데이터 등)인 경우도 동일하게 차단."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, "briefing", hypothesis_id=None)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.transition_loop(
                    loop_id=loop_id, body=LoopTransitionRequest(status="generating"),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "HYPOTHESIS_NOT_ACTIVE"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_briefing_to_generating_succeeds_when_hypothesis_active():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            hyp_id = await _seed_hypothesis(s, status="active")
            loop_id = await _seed_loop(s, "briefing", hypothesis_id=hyp_id)
        async with Session() as s:
            out = await r.transition_loop(
                loop_id=loop_id, body=LoopTransitionRequest(status="generating"),
                session=s, auth=_auth(), org_id=ORG,
            )
            assert out.status == "generating"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_briefing_to_generating_other_hypothesis_statuses_still_blocked():
    """active 외 어떤 상태(verified/falsified/killed/archived/measuring)도 진행 불가 —
    'active'만 명시적으로 허용하는 whitelist 성격(오탈자/향후 새 상태 추가에도 fail-closed)."""
    eng, Session = await _engine()
    try:
        for status in ("verified", "falsified", "killed", "archived", "measuring"):
            async with Session() as s:
                await _seed(s)
                hyp_id = await _seed_hypothesis(s, status=status)
                loop_id = await _seed_loop(s, "briefing", hypothesis_id=hyp_id)
            async with Session() as s:
                with pytest.raises(HTTPException) as ei:
                    await r.transition_loop(
                        loop_id=loop_id, body=LoopTransitionRequest(status="generating"),
                        session=s, auth=_auth(), org_id=ORG,
                    )
                assert ei.value.status_code == 422, f"status={status} 인데 통과됨"
    finally:
        await eng.dispose()
