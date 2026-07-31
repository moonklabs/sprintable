"""오르테가 라이브 실측(2026-07-31, GET /api/v2/gates?status=pending 37/37 project_id=None) —
「단건은 맞고 목록은 틀린」형제 비대칭.

get_gate_endpoint(GET /{id})는 resp.project_id를 대입하는데 list_gates(GET '')는 project_id_
by_work_item을 can_approve 판정에만 쓰고 응답 필드엔 흘려보내지 않았다(대입 자체가 없었다).
거기에 그 배치 조회가 `resolved.type == "human"` 게이트 안에서만 돌아 agent caller는 story/
task/artifact 케이스가 통째로 스킵되는 문제까지 겹쳐 있었다 — project_id는 authz가 아니라
데이터 정합성이라 caller 타입에 의존하면 안 된다(오르테가 판정).

이 파일은 그 두 갈래를 각각 회귀 가드로 고정한다:
  ① 단건/목록 왕복 parity — 같은 gate가 두 엔드포인트에서 같은 project_id를 낸다.
  ② agent caller도 project_id가 채워진다 — human-only 게이트 밖으로 뺀 것의 직접 증거.

#2198/#2027과 동일 정신 — 격리 로컬 throwaway realdb만 사용(라이브 배포 시스템 무접촉).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2e77100-0000-0000-0000-000000000001")
OWNER_USER = uuid.UUID("d2e77100-0000-0000-0000-0000000000a1")
OWNER_OM = uuid.UUID("d2e77100-0000-0000-0000-0000000000b1")
PROJ = uuid.UUID("d2e77100-0000-0000-0000-0000000000c1")
STORY = uuid.UUID("d2e77100-0000-0000-0000-0000000000d1")
AGENT_TM = uuid.UUID("d2e77100-0000-0000-0000-0000000000e1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth_human(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


def _auth_agent(team_member_id: uuid.UUID):
    """is_api_key 판정(member_resolver._resolve_member_legacy)은 claims.app_metadata.api_key_id
    존재 여부만 본다 — 값 자체는 무의미(존재만 체크)."""
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(team_member_id), email=None,
        claims={"app_metadata": {"api_key_id": "test-key"}}, org_id=str(ORG),
    )


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s) -> uuid.UUID:
    """ORG · PROJ(project_id 있음) · STORY(project_id=PROJ) · human owner(project_access) ·
    agent team_member · merge 게이트 1건(work_item_type=story). gate_id 반환.

    ⚠️team_members는 실 배포 스키마에서 members ⋈ project_access UNION 뷰라 직접 INSERT/
    DELETE 불가(CI 실측: ObjectNotInPrerequisiteStateError — cannot delete from view). 로컬
    create_all은 이 모델을 실 테이블로 지어 조용히 통과했었다(로컬 초록≠CI). 실 base 테이블인
    members + project_access(member_id 경유)에 심으면 뷰가 자연히 반영한다 — test_2215_report_
    done_owner_floor_agent_id_realdb.py `_seed_agent_with_grant`와 동일 관례."""
    for sql in [
        f"DELETE FROM gate WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{OWNER_USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D2E77100','d2e77100-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{OWNER_USER}','owner@d2e77100.test','x','Owner',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OWNER_OM}','{ORG}','{OWNER_USER}','member')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','d2e77100-proj','warn')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{OWNER_OM}','granted','owner')",
        f"INSERT INTO stories (id,org_id,project_id,title,status,priority) VALUES "
        f"('{STORY}','{ORG}','{PROJ}','S','backlog','medium')",
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES "
        f"('{AGENT_TM}','{ORG}','agent','에이전트',true)",
        f"INSERT INTO project_access (id,project_id,member_id,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{AGENT_TM}','granted')",
    ]:
        await s.execute(text(sql))
    from app.models.gate import Gate
    gate = Gate(
        id=uuid.uuid4(), org_id=ORG, work_item_id=STORY, work_item_type="story",
        gate_type="merge", status="pending", neutral_facts={},
    )
    s.add(gate)
    await s.commit()
    return gate.id


# ───────────────────────── ① 단건/목록 project_id 왕복 parity ─────────────────────────

@pytest.mark.anyio
async def test_list_and_single_gate_agree_on_project_id():
    """오르테가 명시 요청 — 「단건과 목록이 같은 답을 낸다」 왕복. 한쪽만 고치면 다음에
    또 갈리므로(오늘 게이트 쪽 두 번째 형제 비대칭) 이 parity 자체를 회귀 가드로 고정."""
    from app.routers.gates import get_gate_endpoint, list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_id = await _seed(s)

        async with Session() as s:
            listed = await list_gates(
                work_item_id=None, work_item_type=None, status=None, sort=None, assigned_to_me=False,
                session=s, org_id=ORG, auth=_auth_human(OWNER_USER),
            )
        list_item = next(g for g in listed if g.id == gate_id)

        async with Session() as s:
            single = await get_gate_endpoint(
                id=gate_id, session=s, org_id=ORG, auth=_auth_human(OWNER_USER),
            )

        assert single.project_id == PROJ
        assert list_item.project_id == PROJ
        assert list_item.project_id == single.project_id
    finally:
        await eng.dispose()


# ───────────────────────── ② agent caller도 project_id가 채워진다 ─────────────────────────

@pytest.mark.anyio
async def test_list_gates_project_id_populated_for_agent_caller():
    """수정 前엔 story/task/artifact 배치 조회가 `resolved.type == "human"` 게이트 안에서만
    돌아 agent caller는 이 dict가 doc_proj만 남고(story 케이스 스킵) project_id가 항상 None
    이었다 — project_id는 authz가 아니라 데이터 정합성이라 caller 타입 의존은 결함이다."""
    from app.routers.gates import list_gates
    eng, Session = await _engine()
    try:
        async with Session() as s:
            gate_id = await _seed(s)

        async with Session() as s:
            listed = await list_gates(
                work_item_id=None, work_item_type=None, status=None, sort=None, assigned_to_me=False,
                session=s, org_id=ORG, auth=_auth_agent(AGENT_TM),
            )
        list_item = next(g for g in listed if g.id == gate_id)
        assert list_item.project_id == PROJ
    finally:
        await eng.dispose()
