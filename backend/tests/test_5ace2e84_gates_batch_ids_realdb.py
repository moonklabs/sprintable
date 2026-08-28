"""story #5ace2e84 — 채팅 결재카드 N+1 처방. PO 실측(웜 dev·로그인 세션): 대화 하나 진입 시
`GET /api/gates/{id}` 단건 호출이 최대 51발(고유 38·중복 13) 붙어 1.08s→8.56s 스팬을 먹었다
(p50 894ms·max 7,470ms) — approval-request-card.tsx 인스턴스마다 독립 fetchGate()가 원인.

처방: `GET /api/gates`에 `ids=`(comma-separated) 배치 앵커 조회를 얹는다(stories.py list_stories
`ids`와 동형 계약) — FE는 로드된 메시지 창의 approval_target.gate_id를 모아 1콜로 수렴시킨다
(뒤따르는 stories/스토리 참고 SID#5ace2e84 FE PR).

이 파일이 실측하는 것:
  ① ids로 요청한 게이트가 그대로(project 접근권 있는 것만) 돌아온다.
  ② project 접근권이 없는 게이트는 목록에서 조용히 빠진다(단건 GET /{id}의 404-존재비노출과
     동일 판정 — 배치라고 더 느슨해지면 #2042와 같은 authz 비대칭 재발).
  ③ ids에 없는 uuid(잘못된 형식)는 422.
  ④ ids 200개 초과는 422(stories.py 과대 IN 방어와 동형).
  ⑤ ids에 같은 id를 중복으로 넣어도 결과는 1건(IN절 자연 dedup — FE 중복 13발의 근본 처방).

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

ORG = uuid.UUID("5ace2e84-0000-0000-0000-000000000001")
PROJ_A = uuid.UUID("5ace2e84-0000-0000-0000-0000000000a1")  # caller가 접근권을 가진 project
PROJ_B = uuid.UUID("5ace2e84-0000-0000-0000-0000000000b1")  # caller가 접근권이 없는 project
STORY_A1 = uuid.UUID("5ace2e84-0000-0000-0000-0000000000c1")
STORY_A2 = uuid.UUID("5ace2e84-0000-0000-0000-0000000000c2")
STORY_B1 = uuid.UUID("5ace2e84-0000-0000-0000-0000000000c3")
CALLER_USER = uuid.UUID("5ace2e84-0000-0000-0000-0000000000d1")
CALLER_OM = uuid.UUID("5ace2e84-0000-0000-0000-0000000000e1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth_human(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """ORG · PROJ_A(caller 접근권 有) · PROJ_B(caller 접근권 無). 각 project에 story 1(2)건 +
    gate 1건씩. gate_a1·gate_a2(PROJ_A) · gate_b1(PROJ_B) 3건 반환(created_at 순서 무관, id로만 씀)."""
    gate_a1, gate_a2, gate_b1 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    for sql in [
        f"DELETE FROM gate WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{CALLER_USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S5ACE2E84','s5ace2e84-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{CALLER_USER}','caller@s5ace2e84.test','x','Caller',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{CALLER_OM}','{ORG}','{CALLER_USER}','member')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ_A}','{ORG}','A','s5ace2e84-proj-a','warn'),"
        f"('{PROJ_B}','{ORG}','B','s5ace2e84-proj-b','warn')",
        # PROJ_A만 project_access(granted) — PROJ_B는 caller에게 아무 접근권도 없다.
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ_A}','{CALLER_OM}','granted','member')",
        f"INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES "
        f"('{STORY_A1}','{ORG}','{PROJ_A}','SA1','backlog','medium'),"
        f"('{STORY_A2}','{ORG}','{PROJ_A}','SA2','backlog','medium'),"
        f"('{STORY_B1}','{ORG}','{PROJ_B}','SB1','backlog','medium')",
        "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,status,neutral_facts,created_at) VALUES "
        f"('{gate_a1}','{ORG}','{STORY_A1}','story','merge','pending','{{}}',now()),"
        f"('{gate_a2}','{ORG}','{STORY_A2}','story','qa','pending','{{}}',now()),"
        f"('{gate_b1}','{ORG}','{STORY_B1}','story','merge','pending','{{}}',now())",
    ]:
        await s.execute(text(sql))
    await s.commit()
    return gate_a1, gate_a2, gate_b1


# ───────────── ① ids로 요청한 접근가능 게이트가 그대로 돌아온다 ─────────────

@pytest.mark.anyio
async def test_ids_batch_returns_requested_accessible_gates():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_a1, gate_a2, _gate_b1 = await _seed(s)
        async with Session() as s:
            listed = await list_gates(
                work_item_id=None, work_item_type=None, status=None, gate_type=None,
                ids=f"{gate_a1},{gate_a2}",
                sort=None, assigned_to_me=False, limit=None, offset=0,
                session=s, org_id=ORG, auth=_auth_human(CALLER_USER),
            )
        assert {g.id for g in listed} == {gate_a1, gate_a2}, (
            "ids로 명시 요청한 접근가능 게이트 2건이 그대로 돌아와야 한다"
        )
    finally:
        await eng.dispose()


# ───────────── ② project 접근권 없는 게이트는 배치에서도 조용히 빠진다(#2042 authz 비대칭 재발 금지) ─────────────

@pytest.mark.anyio
async def test_ids_batch_silently_drops_gate_without_project_access():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_a1, _gate_a2, gate_b1 = await _seed(s)
        async with Session() as s:
            listed = await list_gates(
                work_item_id=None, work_item_type=None, status=None, gate_type=None,
                ids=f"{gate_a1},{gate_b1}",
                sort=None, assigned_to_me=False, limit=None, offset=0,
                session=s, org_id=ORG, auth=_auth_human(CALLER_USER),
            )
        got_ids = {g.id for g in listed}
        assert got_ids == {gate_a1}, (
            f"PROJ_B(caller 접근권 없음) 소속 게이트가 배치 응답에 새 나가면 안 된다: {got_ids}"
        )
    finally:
        await eng.dispose()


# ───────────── ③ 잘못된 uuid = 422 ─────────────

@pytest.mark.anyio
async def test_ids_batch_invalid_uuid_rejected_422():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await list_gates(
                    work_item_id=None, work_item_type=None, status=None, gate_type=None,
                    ids="not-a-uuid",
                    sort=None, assigned_to_me=False, limit=None, offset=0,
                    session=s, org_id=ORG, auth=_auth_human(CALLER_USER),
                )
        assert exc_info.value.status_code == 422
    finally:
        await eng.dispose()


# ───────────── ④ 200개 초과 = 422(과대 IN 방어) ─────────────

@pytest.mark.anyio
async def test_ids_batch_over_cap_rejected_422():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        too_many = ",".join(str(uuid.uuid4()) for _ in range(201))
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await list_gates(
                    work_item_id=None, work_item_type=None, status=None, gate_type=None,
                    ids=too_many,
                    sort=None, assigned_to_me=False, limit=None, offset=0,
                    session=s, org_id=ORG, auth=_auth_human(CALLER_USER),
                )
        assert exc_info.value.status_code == 422
    finally:
        await eng.dispose()


# ───────────── ⑤ 중복 id는 1건으로 수렴(FE 중복 13발의 근본 처방) ─────────────

@pytest.mark.anyio
async def test_ids_batch_dedupes_duplicate_ids():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_a1, _gate_a2, _gate_b1 = await _seed(s)
        async with Session() as s:
            listed = await list_gates(
                work_item_id=None, work_item_type=None, status=None, gate_type=None,
                ids=f"{gate_a1},{gate_a1},{gate_a1}",
                sort=None, assigned_to_me=False, limit=None, offset=0,
                session=s, org_id=ORG, auth=_auth_human(CALLER_USER),
            )
        assert len(listed) == 1 and listed[0].id == gate_a1, (
            f"같은 id를 세 번 넣어도 결과는 1건이어야 한다(IN절 자연 dedup): {[g.id for g in listed]}"
        )
    finally:
        await eng.dispose()


# ───────────── ⑥ ids 미지정(기존 호출부)은 회귀 0 — list_gate_inbox 직접호출 안전 확인 ─────────────

@pytest.mark.anyio
async def test_ids_omitted_matches_pre_existing_default_behavior():
    """list_gate_inbox()가 list_gates()를 ids= 없이 직접 파이썬 호출한다(라우터 파일 내부) —
    Annotated 실 None 기본값이 아니면 이 직접호출 경로에서 Query 객체가 그대로 들어가
    `.split(",")`가 즉시 TypeError로 터진다(#2864 주석이 이미 경고한 바로 그 함정)."""
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_a1, gate_a2, gate_b1 = await _seed(s)
        async with Session() as s:
            listed = await list_gates(
                work_item_id=None, work_item_type=None, status=None, gate_type=None,
                sort=None, assigned_to_me=False, limit=None, offset=0,
                session=s, org_id=ORG, auth=_auth_human(CALLER_USER),
            )
        # ids 미지정 + work_item_id 미지정 = 기존(#5ace2e84 이전) 그대로 org 스코프 무필터 목록 —
        # PROJ_B(caller 접근권 없음) 게이트도 여기선 걸러지지 않는다(#2042가 손댄 건 work_item_id
        # 필터 경로뿐, 이 일반 목록 경로는 그때도 지금도 동일 — 이 테스트는 회귀 0만 확인).
        assert {g.id for g in listed} == {gate_a1, gate_a2, gate_b1}, (
            "ids 파라미터 추가가 기존(일반 목록, ids/work_item_id 둘 다 미지정) 경로의 동작을 "
            "바꾸면 안 된다 — 회귀"
        )
    finally:
        await eng.dispose()
