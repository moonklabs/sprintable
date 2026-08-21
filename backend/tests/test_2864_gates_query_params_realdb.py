"""story #2864(P2, 침묵 스왈로) — GET /api/v2/gates가 gate_type·limit·offset 쿼리 파라미터를
FastAPI 시그니처에 아예 등재하지 않아 조용히 무시했다(#2863 zod dead-code와 동일 결함
클래스 — 「있다≠지금 쓰는 것」). 이 파일은 세 파라미터가 실제로 배선됐음을 값으로 실측한다:
  ① gate_type이 실제로 필터한다(다른 gate_type 섞어 심고 한쪽만 필터링돼 나오는지 값 대조).
  ② 미지 gate_type은 422(침묵 무시 대신 명시 거부) — GATE_TYPES SSOT 재사용 확認.
  ③ limit이 실제로 절단한다(N건 심고 limit<N 요청 시 정확히 limit건).
  ④ offset이 실제로 건너뛴다(limit+offset 조합으로 페이지 2가 페이지 1과 겹치지 않음).

#2853/#2845/#2857과 동일 정신 — 격리 로컬 throwaway realdb만 사용(라이브 배포 시스템 무접촉).
"""
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

ORG = uuid.UUID("28640000-0000-0000-0000-000000000001")
OWNER_USER = uuid.UUID("28640000-0000-0000-0000-0000000000a1")
OWNER_OM = uuid.UUID("28640000-0000-0000-0000-0000000000b1")
PROJ = uuid.UUID("28640000-0000-0000-0000-0000000000c1")
STORY = uuid.UUID("28640000-0000-0000-0000-0000000000d1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth_human(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s, *, n_merge: int = 1, n_qa: int = 1) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
    """ORG · PROJ · STORY(project_id=PROJ) · human owner(project_access). n_merge건의
    gate_type='merge' + n_qa건의 gate_type='qa' 게이트를 created_at을 벌려 심는다(offset
    페이지네이션 결정성 확보 — created_at desc 정렬이 새 기본 순서라 나중에 심을수록 앞).
    (merge_ids, qa_ids) 반환 — created_at 순서(먼저 심은 것부터).
    """
    for sql in [
        f"DELETE FROM gate WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{OWNER_USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S2864','s2864-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{OWNER_USER}','owner@s2864.test','x','Owner',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OWNER_OM}','{ORG}','{OWNER_USER}','member')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','s2864-proj','warn')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{OWNER_OM}','granted','owner')",
        f"INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES "
        f"('{STORY}','{ORG}','{PROJ}','S','backlog','medium')",
    ]:
        await s.execute(text(sql))
    from app.models.gate import Gate

    merge_ids: list[uuid.UUID] = []
    qa_ids: list[uuid.UUID] = []
    seq = 0
    for _ in range(n_merge):
        gid = uuid.uuid4()
        seq += 1
        await s.execute(text(
            "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,status,"
            "neutral_facts,created_at) VALUES "
            f"('{gid}','{ORG}','{STORY}','story','merge','pending','{{}}',"
            f"now() + interval '{seq} seconds')"
        ))
        merge_ids.append(gid)
    for _ in range(n_qa):
        gid = uuid.uuid4()
        seq += 1
        await s.execute(text(
            "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,status,"
            "neutral_facts,created_at) VALUES "
            f"('{gid}','{ORG}','{STORY}','story','qa','pending','{{}}',"
            f"now() + interval '{seq} seconds')"
        ))
        qa_ids.append(gid)
    await s.commit()
    return merge_ids, qa_ids


# ───────────────────────── ① gate_type 실 필터 ─────────────────────────

@pytest.mark.anyio
async def test_gate_type_filters_to_matching_type_only():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            merge_ids, qa_ids = await _seed(s, n_merge=2, n_qa=3)

        async with Session() as s:
            listed = await list_gates(
                work_item_id=None, work_item_type=None, status=None, gate_type="merge",
                sort=None, assigned_to_me=False, limit=100, offset=0,
                session=s, org_id=ORG, auth=_auth_human(OWNER_USER),
            )
        got_ids = {g.id for g in listed}
        assert got_ids == set(merge_ids), (
            f"gate_type=merge가 실제로 필터하지 않으면 qa 게이트도 섞여 나온다: {got_ids}"
        )
        assert all(g.gate_type == "merge" for g in listed)
    finally:
        await eng.dispose()


# ───────────────────────── ② 미지 gate_type = 422 ─────────────────────────

@pytest.mark.anyio
async def test_unknown_gate_type_rejected_422():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, n_merge=1, n_qa=1)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await list_gates(
                    work_item_id=None, work_item_type=None, status=None, gate_type="bogus_type_xyz",
                    sort=None, assigned_to_me=False, limit=100, offset=0,
                    session=s, org_id=ORG, auth=_auth_human(OWNER_USER),
                )
        assert exc_info.value.status_code == 422
    finally:
        await eng.dispose()


# ───────────────────────── ③ limit 실 절단 ─────────────────────────

@pytest.mark.anyio
async def test_limit_actually_truncates_result_count():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            merge_ids, _qa_ids = await _seed(s, n_merge=5, n_qa=0)

        async with Session() as s:
            listed = await list_gates(
                work_item_id=None, work_item_type=None, status=None, gate_type=None,
                sort=None, assigned_to_me=False, limit=2, offset=0,
                session=s, org_id=ORG, auth=_auth_human(OWNER_USER),
            )
        assert len(listed) == 2, (
            f"limit=2인데 {len(listed)}건 반환 — limit이 배선 안 됐으면 전체 5건이 나온다"
        )
    finally:
        await eng.dispose()


# ───────────────────────── ④ offset 실 페이지네이션 ─────────────────────────

@pytest.mark.anyio
async def test_offset_paginates_without_overlap():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            merge_ids, _qa_ids = await _seed(s, n_merge=5, n_qa=0)
        # created_at desc 기본 정렬 — 나중에 심은(seq 큰) 게이트가 앞에 온다.
        expected_order = list(reversed(merge_ids))

        async with Session() as s:
            page1 = await list_gates(
                work_item_id=None, work_item_type=None, status=None, gate_type=None,
                sort=None, assigned_to_me=False, limit=2, offset=0,
                session=s, org_id=ORG, auth=_auth_human(OWNER_USER),
            )
        async with Session() as s:
            page2 = await list_gates(
                work_item_id=None, work_item_type=None, status=None, gate_type=None,
                sort=None, assigned_to_me=False, limit=2, offset=2,
                session=s, org_id=ORG, auth=_auth_human(OWNER_USER),
            )

        page1_ids = [g.id for g in page1]
        page2_ids = [g.id for g in page2]
        assert page1_ids == expected_order[0:2]
        assert page2_ids == expected_order[2:4]
        assert set(page1_ids).isdisjoint(page2_ids), "페이지 겹침 — offset이 배선 안 됐다면 두 페이지가 동일해진다"
    finally:
        await eng.dispose()
