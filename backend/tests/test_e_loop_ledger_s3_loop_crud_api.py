"""E-LOOP-LEDGER S3(story fb70a775): /api/v2/loops CRUD API 검증.

S3 고유 가치(비-tautological — 까심 QA 사전 요구 컨벤션):
ⓐ cross-project GET 거부 실증(같은-org·타-project caller가 대상 loop project 접근 없이 GET
   시도 → 403, has_project_access grant가 없는 세팅으로 실 재현. docs.py
   test_doc_mutation_project_scope_idor_realdb.py와 동형 패턴).
ⓑ 서버 actor 해소 — client가 created_by_member_id를 보낼 수 없는 스키마임을 증명하고, 실제
   caller(resolve_member 해소 id)가 persisted row에 정확히 기록됨을 realdb로 검증.
ⓒ v2 에러 엔벨로프 계약 — 서비스 도메인 오류 code→HTTP status 매핑 + dict-detail 계약(라우터
   유닛, DB 불요).

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.routers import loops as r
from app.schemas.loop import LoopCreate
from app.services.loop import LoopServiceError

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── ⓒ 오류 code→status 매핑(라우터 유닛, DB 불요) ────────────────────────────────

def test_error_status_map_covers_service_codes():
    expected = {"LOOP_NOT_FOUND", "LOOP_PROJECT_ACCESS_DENIED"}
    assert expected <= set(r._ERROR_STATUS)


@pytest.mark.parametrize("code,status", [
    ("LOOP_NOT_FOUND", 404),
    ("LOOP_PROJECT_ACCESS_DENIED", 403),
])
def test_raise_maps_code_to_status(code, status):
    with pytest.raises(HTTPException) as ei:
        r._raise(LoopServiceError(code, "msg"))
    assert ei.value.status_code == status
    assert ei.value.detail == {"code": code, "message": "msg"}


def test_raise_unknown_code_defaults_400():
    with pytest.raises(HTTPException) as ei:
        r._raise(LoopServiceError("WHATEVER", "m"))
    assert ei.value.status_code == 400


def test_loop_create_schema_has_no_created_by_member_id_field():
    # ⓑ client 입력 스키마에 actor 필드가 아예 없다 — 실수로 들어온 request body 값이 있어도
    # LoopCreate가 그 필드를 정의하지 않으므로 Pydantic이 무시(extra 무시가 기본 ConfigDict).
    assert "created_by_member_id" not in LoopCreate.model_fields


# ── realdb ───────────────────────────────────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("1c000000-0000-0000-0000-000000000001")
USER = uuid.UUID("1c000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("1c000000-0000-0000-0000-0000000000b1")
AGENT = uuid.UUID("1c000000-0000-0000-0000-0000000000d1")  # PROJ_A 스코프 agent(까심 재현 시나리오)
PROJ_A = uuid.UUID("1c000000-0000-0000-0000-0000000000c1")  # USER/AGENT grant(접근 O)
PROJ_B = uuid.UUID("1c000000-0000-0000-0000-0000000000c2")  # USER/AGENT 접근 X(IDOR 축)


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


def _agent_auth():
    """까심 QA CRITICAL(#1815) 재현 시나리오용 — API키 agent 호출자.

    eb1eb21b(resolve_member root-fix)가 develop에 머지된 뒤 이 브랜치가 rebase되며 딸려온
    보호(_resolve_member_legacy/_resolve_member_anchor 두 분기 모두 has_project_access 검증)를
    loops 표면에서도 직접 실증한다 — S3 자체 코드 변경은 없음(루트 fix가 이미 막음)."""
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AGENT), email=None,
        claims={"app_metadata": {"api_key_id": "ak_test", "org_id": str(ORG)}},
        org_id=str(ORG),
    )


async def _seed(s):
    """ORG·USER(member·非owner/admin)·AGENT(PROJ_A만 grant)·PROJ_A(grant)·PROJ_B(no grant) 시드."""
    for sql in [
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C1C','c1corg','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@c1c.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{AGENT}','{ORG}','agent','Ag',true)",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        # USER/AGENT는 PROJ_A에만 grant(PROJ_B 접근 없음 — IDOR 테스트축).
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
        f"INSERT INTO project_access (id,project_id,org_member_id,member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}',NULL,'{AGENT}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ── ⓐ GET-by-id cross-project IDOR ────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_get_loop_cross_project_forbidden_same_project_ok():
    from app.repositories.loop import LoopRunRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            repo = LoopRunRepository(s, ORG)
            loop_b = await repo.create(
                project_id=PROJ_B, title="B loop", goal_tags=[], status="draft",
                created_by_member_id=uuid.uuid4(),
            )
            loop_a = await repo.create(
                project_id=PROJ_A, title="A loop", goal_tags=[], status="draft",
                created_by_member_id=uuid.uuid4(),
            )
            await s.commit()
            loop_b_id, loop_a_id = loop_b.id, loop_a.id

        # cross-project(PROJ_B·USER 무접근) → 403
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.get_loop(loop_id=loop_b_id, session=s, auth=_auth(), org_id=ORG)
            assert ei.value.status_code == 403
            assert ei.value.detail["code"] == "LOOP_PROJECT_ACCESS_DENIED"

        # same-project(PROJ_A·grant) → 통과
        async with Session() as s:
            out = await r.get_loop(loop_id=loop_a_id, session=s, auth=_auth(), org_id=ORG)
            assert out.id == loop_a_id
            assert out.project_id == PROJ_A
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_get_loop_not_found_returns_404():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.get_loop(loop_id=uuid.uuid4(), session=s, auth=_auth(), org_id=ORG)
            assert ei.value.status_code == 404
            assert ei.value.detail["code"] == "LOOP_NOT_FOUND"
    finally:
        await eng.dispose()


# ── ⓑ create — cross-project 생성 거부 + 서버 actor 해소 ─────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_cross_project_forbidden_via_resolve_member():
    """resolve_member(project_id=PROJ_B)가 USER의 PROJ_B 무접근을 검증해 거부한다 —
    create_loop 서비스가 아니라 라우터의 resolve_member 호출이 이 가드를 선행한다."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop(
                    body=LoopCreate(project_id=PROJ_B, title="hack"),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code in (400, 403)
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_agent_cross_project_forbidden_403():
    """까심 QA CRITICAL(#1814 S3 QA, root-fix #1815) 재현 시나리오 — agent가 PROJ_A에만 grant된
    상태에서 body.project_id=PROJ_B로 POST하면 403이어야 한다. 이 방어는 eb1eb21b(develop 머지된
    resolve_member root-fix)가 이미 제공 — loops.py 자체엔 변경 불요. same-project(PROJ_A) 성공까지
    양방향 실증해 fix가 정당한 요청을 막지 않음도 확인."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        # cross-project(PROJ_B·agent grant 없음) → 403(취약점 있었다면 여기서 통과했을 것).
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop(
                    body=LoopCreate(project_id=PROJ_B, title="agent-idor-attempt"),
                    session=s, auth=_agent_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
        # same-project(PROJ_A·agent grant 있음) → 통과 + created_by_member_id=agent id.
        # S14: hypothesis_id 필수화됐으므로(이 테스트의 관심사는 IDOR 아님) 시드해서 우회.
        async with Session() as s:
            hyp_id = await _seed_hypothesis(s, org_id=ORG, project_id=PROJ_A)
        async with Session() as s:
            out = await r.create_loop(
                body=LoopCreate(project_id=PROJ_A, title="agent-legit", hypothesis_id=hyp_id),
                session=s, auth=_agent_auth(), org_id=ORG,
            )
            await s.commit()
            assert out.project_id == PROJ_A
            assert out.created_by_member_id == AGENT
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_persists_server_resolved_actor_not_arbitrary_value():
    """생성된 row의 created_by_member_id는 resolve_member가 해소한 caller.id(=OM, USER의
    org_member.id)와 정확히 일치한다 — LoopCreate에 그 필드가 없으므로 client가 다른 값을
    주입할 방법이 애초에 없다는 것을 실 persist 값으로 증명."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            hyp_id = await _seed_hypothesis(s, org_id=ORG, project_id=PROJ_A)  # S14: hypothesis 필수
        async with Session() as s:
            out = await r.create_loop(
                body=LoopCreate(
                    project_id=PROJ_A, title="A loop", goal_tags=["retention"], hypothesis_id=hyp_id,
                ),
                session=s, auth=_auth(), org_id=ORG,
            )
            await s.commit()
            created_id = out.id

        async with Session() as s:
            from app.models.loop import LoopRun
            row = (await s.execute(select(LoopRun).where(LoopRun.id == created_id))).scalar_one()
            assert row.created_by_member_id == OM
            assert row.status == "draft"
            assert row.goal_tags == ["retention"]
    finally:
        await eng.dispose()


# ── list ─────────────────────────────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_list_loops_filters_by_status_and_project():
    from app.repositories.loop import LoopRunRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            repo = LoopRunRepository(s, ORG)
            await repo.create(
                project_id=PROJ_A, title="draft-loop", goal_tags=[], status="draft",
                created_by_member_id=uuid.uuid4(),
            )
            await repo.create(
                project_id=PROJ_A, title="briefing-loop", goal_tags=[], status="briefing",
                created_by_member_id=uuid.uuid4(),
            )
            await repo.create(
                project_id=PROJ_B, title="other-project-loop", goal_tags=[], status="draft",
                created_by_member_id=uuid.uuid4(),
            )
            await s.commit()

        async with Session() as s:
            from unittest.mock import MagicMock
            items = await r.list_loops(
                response=MagicMock(headers={}),
                project_id=PROJ_A, status_filter="draft", parent_loop_id=None, goal_tag=None,
                limit=100, session=s, org_id=ORG,
            )
            assert len(items) == 1
            assert items[0].title == "draft-loop"
    finally:
        await eng.dispose()


# ── 까심 QA CRITICAL(#1818 S7 QA) — hypothesis_id 소유검증(cross-org 데이터 유출 근본 차단) ──

async def _seed_hypothesis(s, *, org_id, project_id) -> uuid.UUID:
    from datetime import datetime, timezone
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, owner_member_id=uuid.uuid4(),
        statement="s", metric_definition={"metric": "m", "source": "manual", "target": 1, "direction": "up"},
        measure_after=datetime(2026, 1, 1, tzinfo=timezone.utc), status="active",
    )
    s.add(hyp)
    await s.commit()
    return hyp.id


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_cross_org_hypothesis_forbidden_404():
    """까심 재현 시나리오 — 타 org의 hypothesis_id로 loop 생성 시도. FK만으론 존재 검증뿐이라
    통과했을 것(fix 前) — org 스코프 조회로 404(같은 org 안에서 못 찾음, 존재 여부 오라클 최소화)."""
    other_org = uuid.UUID("1c000000-0000-0000-0000-0000000000ee")
    other_project = uuid.UUID("1c000000-0000-0000-0000-0000000000ef")
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            for sql in [
                f"DELETE FROM projects WHERE org_id='{other_org}'",
                f"DELETE FROM organizations WHERE id='{other_org}'",
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{other_org}','OTH','othorg-1c','free')",
                f"INSERT INTO projects (id,org_id,name) VALUES ('{other_project}','{other_org}','OTH-P')",
            ]:
                await s.execute(text(sql))
            await s.commit()
            other_org_hyp_id = await _seed_hypothesis(s, org_id=other_org, project_id=other_project)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop(
                    body=LoopCreate(
                        project_id=PROJ_A, title="leak-attempt", hypothesis_id=other_org_hyp_id,
                    ),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 404
            assert ei.value.detail["code"] == "HYPOTHESIS_NOT_FOUND"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_cross_project_same_org_hypothesis_forbidden_403():
    """같은 org 내에서도 hypothesis가 loop과 다른 project 소속이면 403(S4 asset 패턴과 동일 축)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            hyp_in_proj_b = await _seed_hypothesis(s, org_id=ORG, project_id=PROJ_B)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await r.create_loop(
                    body=LoopCreate(
                        project_id=PROJ_A, title="mismatch-attempt", hypothesis_id=hyp_in_proj_b,
                    ),
                    session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
            assert ei.value.detail["code"] == "HYPOTHESIS_PROJECT_MISMATCH"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_loop_same_project_hypothesis_succeeds():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            hyp_id = await _seed_hypothesis(s, org_id=ORG, project_id=PROJ_A)

        async with Session() as s:
            out = await r.create_loop(
                body=LoopCreate(project_id=PROJ_A, title="ok", hypothesis_id=hyp_id),
                session=s, auth=_auth(), org_id=ORG,
            )
            assert out.hypothesis_id == hyp_id
    finally:
        await eng.dispose()
