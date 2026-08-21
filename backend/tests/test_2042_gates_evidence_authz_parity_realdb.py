"""story #2042(P0, gates·evidence authz 비대칭) — 같은 세션·같은 work_item인데 GET /evidence만
403이고 GET /gates는 200(PO 그라운딩 2026-07-20, 실측 확定). 원인은 두 갈래였다(실측으로 확인,
겉으론 하나처럼 보였지만 다른 병):

  ① evidence.py 축 불일치(story #1936과 동일 결함 클래스): `_assert_work_item_access`/
     `get_evidence`가 `resolve_member().id`(휴먼일 때 org_member.id)를 `has_project_access`에
     넘겼는데, 그 함수의 human_grant_branch/admin_branch는 `OrgMember.user_id`(raw users.id)로
     매칭한다(project_auth.py `_project_access_predicate`) — team_member 행이 없는 순수
     project_access(granted) 휴먼은 정당한 접근권이 있어도 403으로 튕겼다. 코드베이스 전역
     40+ has_project_access 콜사이트가 전부 `uuid.UUID(auth.user_id)`를 직접 쓰는 것과 이
     파일만 달랐다.
  ② gates.py list_gates()가 work_item_id+work_item_type 필터가 있어도 project 접근권을 아예
     안 물었다(org_id 스코프만) — 단건 조회(get_gate_endpoint)·evidence는 project 인가를
     강제하는데 목록만 조직 전체에 열려 있어, project 밖 사용자에게 게이트 정보가 샌다.

이 파일은 두 축을 각각+조합으로 실측한다: (A) project_access(granted)만 있고 team_member는
없는 휴먼 — 수정 전엔 evidence 403(①의 직접 피해자), 수정 후 evidence·gates 둘 다 허용.
(B) project_access가 전혀 없는 휴먼 — 수정 전엔 gates 200(②의 직접 피해자, 정보 노출),
수정 후 evidence·gates 둘 다 거부(AC2 "같은 판정" 그 자체를 값으로 단언).

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

ORG = uuid.UUID("20420000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("20420000-0000-0000-0000-0000000000c1")
STORY = uuid.UUID("20420000-0000-0000-0000-0000000000d1")
GRANTED_USER = uuid.UUID("20420000-0000-0000-0000-0000000000a1")   # project_access(granted)만, team_member 없음
GRANTED_OM = uuid.UUID("20420000-0000-0000-0000-0000000000b1")
DENIED_USER = uuid.UUID("20420000-0000-0000-0000-0000000000a2")    # 접근권 전무
DENIED_OM = uuid.UUID("20420000-0000-0000-0000-0000000000b2")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth_human(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> None:
    """ORG · PROJ · STORY(project_id=PROJ) · gate 1건(merge) · evidence 1건.
    GRANTED_USER: org_members 행 + project_access(granted) — team_member 행은 만들지 않는다
    (①의 정확한 재현 조건 — team_member_branch 우회로 축 불일치가 가려지지 않게).
    DENIED_USER: org_members 행만(같은 org 멤버지만 이 project엔 어떤 접근권도 없음)."""
    for sql in [
        f"DELETE FROM evidence WHERE org_id='{ORG}'",
        f"DELETE FROM gate WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{GRANTED_USER}','{DENIED_USER}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S2042','s2042-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{GRANTED_USER}','granted@s2042.test','x','Granted',true,true,0,false,0),"
        f"('{DENIED_USER}','denied@s2042.test','x','Denied',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"('{GRANTED_OM}','{ORG}','{GRANTED_USER}','member'),"
        f"('{DENIED_OM}','{ORG}','{DENIED_USER}','member')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','s2042-proj','warn')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{GRANTED_OM}','granted','member')",
        f"INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES "
        f"('{STORY}','{ORG}','{PROJ}','S','backlog','medium')",
        "INSERT INTO gate (id,org_id,work_item_id,work_item_type,gate_type,status,neutral_facts,"
        f"created_at) VALUES (gen_random_uuid(),'{ORG}','{STORY}','story','merge','pending','{{}}',now())",
        "INSERT INTO evidence (id,org_id,work_item_id,work_item_type,type,ref,created_by,created_at) "
        f"VALUES (gen_random_uuid(),'{ORG}','{STORY}','story','url','https://example.test/x',"
        f"'{GRANTED_OM}',now())",
    ]:
        await s.execute(text(sql))
    await s.commit()


# ───────────── ① evidence 축 불일치: project_access(granted)만 있는 휴먼 ─────────────

@pytest.mark.anyio
async def test_evidence_allows_project_access_granted_human_without_team_member():
    from app.routers.evidence import list_evidence
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            items = await list_evidence(
                work_item_id=STORY, work_item_type="story",
                session=s, org_id=ORG, auth=_auth_human(GRANTED_USER),
            )
        assert len(items) == 1, (
            "project_access(granted)만 있고 team_member가 없는 휴먼은 정당한 접근권자다 — "
            "축 불일치(caller.id=org_member.id를 has_project_access에 넘김)가 있으면 403으로 튕긴다"
        )
    finally:
        await eng.dispose()


# ───────────── ② gates 노출: project_access가 전혀 없는 휴먼도 200이었다 ─────────────

@pytest.mark.anyio
async def test_gates_denies_human_with_no_project_access():
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await list_gates(
                    work_item_id=STORY, work_item_type="story", status=None, gate_type=None,
                    sort=None, assigned_to_me=False, limit=None, offset=0,
                    session=s, org_id=ORG, auth=_auth_human(DENIED_USER),
                )
        assert exc_info.value.status_code == 404, (
            "project 접근권이 전혀 없는 사용자가 이 work_item의 gate를 조회하면 거부돼야 한다 — "
            "list_gates가 org_id만 스코프하면(project 인가 미검사) 200으로 새 나간다(정보 노출)"
        )
    finally:
        await eng.dispose()


# ───────────── AC2 — 같은 사용자·같은 work_item, evidence·gates 판정 일치(양쪽 다) ─────────────

@pytest.mark.anyio
async def test_evidence_and_gates_agree_for_granted_user():
    from app.routers.evidence import list_evidence
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            ev = await list_evidence(
                work_item_id=STORY, work_item_type="story",
                session=s, org_id=ORG, auth=_auth_human(GRANTED_USER),
            )
        async with Session() as s:
            gates = await list_gates(
                work_item_id=STORY, work_item_type="story", status=None, gate_type=None,
                sort=None, assigned_to_me=False, limit=None, offset=0,
                session=s, org_id=ORG, auth=_auth_human(GRANTED_USER),
            )
        assert len(ev) == 1 and len(gates) == 1, "granted 휴먼은 evidence·gates 둘 다 봐야 한다(둘 다 허용)"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_evidence_and_gates_agree_for_denied_user():
    from app.routers.evidence import list_evidence
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as ev_exc:
                await list_evidence(
                    work_item_id=STORY, work_item_type="story",
                    session=s, org_id=ORG, auth=_auth_human(DENIED_USER),
                )
        async with Session() as s:
            with pytest.raises(HTTPException) as gate_exc:
                await list_gates(
                    work_item_id=STORY, work_item_type="story", status=None, gate_type=None,
                    sort=None, assigned_to_me=False, limit=None, offset=0,
                    session=s, org_id=ORG, auth=_auth_human(DENIED_USER),
                )
        # 상태코드 문구(403 vs 404, existence-hiding 관례 차이)는 각 라우터 고유 스타일 —
        # AC2가 요구하는 「접근 판정(허용/거부)이 일치」는 둘 다 4xx로 거부되는 것으로 충분.
        assert ev_exc.value.status_code in (403, 404)
        assert gate_exc.value.status_code in (403, 404)
    finally:
        await eng.dispose()
