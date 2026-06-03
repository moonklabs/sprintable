"""E-MEMBER-SSOT AC2-3 (H2): 실행 가능 real-DB parity 테스트.

legacy(org_members/team_members) vs anchor(members/aliases) resolver를 **동일 실 데이터**로
대조해 0-diff 입증. mocked로는 못 잡는 실데이터 정합(orphan·멀티프로젝트·휴먼 name)을 검증.

DB env(ALEMBIC_DATABASE_URL 또는 PARITY_TEST_DATABASE_URL) 없으면 skip — CI alembic-fresh-db
잡(postgres + alembic upgrade head)에서 실행되며, 로컬은 throwaway PG로 실행.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock

import pytest

_RAW_URL = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
# alembic은 sync(psycopg2) URL — async 드라이버로 변환
_ASYNC_URL = _RAW_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _ASYNC_URL, reason="parity real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# 고정 UUID — 시드/검증 공유
ORG = uuid.UUID("b1000000-0000-0000-0000-000000000001")
U_OWNER = uuid.UUID("b2000000-0000-0000-0000-000000000001")
U_MEM = uuid.UUID("b2000000-0000-0000-0000-000000000002")
OM_OWNER = uuid.UUID("b3000000-0000-0000-0000-000000000001")
OM_MEM = uuid.UUID("b3000000-0000-0000-0000-000000000002")
P1 = uuid.UUID("b4000000-0000-0000-0000-000000000001")
P2 = uuid.UUID("b4000000-0000-0000-0000-000000000002")
TM_OWNER = uuid.UUID("b5000000-0000-0000-0000-000000000001")  # 레거시 휴먼 team_member
AG1 = uuid.UUID("b5000000-0000-0000-0000-0000000000a1")       # 멀티프로젝트 agent — proj1
AG2 = uuid.UUID("b5000000-0000-0000-0000-0000000000a2")       # 멀티프로젝트 agent — proj2
ORPHAN = uuid.UUID("bf000000-0000-0000-0000-000000000000")
APIKEY_ID = uuid.UUID("b7000000-0000-0000-0000-000000000001")
APIKEY_RAW = "sk_live_" + "0" * 64


def _auth(uid, api_key=False):
    c = MagicMock()
    c.user_id = str(uid)
    c.claims = {"app_metadata": ({"api_key_id": "ak"} if api_key else {})}
    return c


def _tup(r):
    return (str(r.id), str(r.user_id) if r.user_id else None, r.name, r.type, r.role,
            str(r.org_id), str(r.project_id) if r.project_id else None)


async def _seed(session):
    """legacy + anchor를 일관되게 시드(0075 백필 결과 모사 — members.id=org_member/team_member.id)."""
    from sqlalchemy import text
    stmts = [
        # 방어: fresh `alembic upgrade head`에선 0075 DROP NOT NULL이 미지속되는 관찰(별건 flag)이 있어,
        # 에이전트 placement(org_member_id NULL) 시드를 위해 idempotent하게 nullable 보장(테스트 신뢰성).
        "ALTER TABLE project_access ALTER COLUMN org_member_id DROP NOT NULL",
        # 의존 역순 정리(이전 실행 잔여) — 단일 트랜잭션, 유효 문만(실패 시 tx abort 방지)
        f"DELETE FROM agent_project_profiles WHERE member_id IN ('{AG1}','{AG2}')",
        f"DELETE FROM member_identity_aliases WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{P1}','{P2}')",
        f"DELETE FROM team_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{U_OWNER}','{U_MEM}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','PG','pgorg','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{U_OWNER}','owner@pg.test','x','Owner',true,true,0,false,0),('{U_MEM}','mem@pg.test','x','Mem',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM_OWNER}','{ORG}','{U_OWNER}','owner'),('{OM_MEM}','{ORG}','{U_MEM}','member')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{P1}','{ORG}','P1',0),('{P2}','{ORG}','P2',0)",
        f"INSERT INTO team_members (id,project_id,org_id,user_id,type,name,role,color,can_manage_members,is_active,created_by) VALUES "
        f"('{TM_OWNER}','{P1}','{ORG}','{U_OWNER}','human','Owner','owner','#3385f8',true,true,NULL),"
        f"('{AG1}','{P1}','{ORG}',NULL,'agent','Bot','member','#ff0000',false,true,'{U_OWNER}'),"
        f"('{AG2}','{P2}','{ORG}',NULL,'agent','Bot','reviewer','#00ff00',false,true,'{U_OWNER}')",
        f"INSERT INTO project_access (id,project_id,org_member_id,member_id,permission,role,access_source) VALUES "
        f"(gen_random_uuid(),'{P1}','{OM_MEM}','{OM_MEM}','granted','member','direct'),"
        f"(gen_random_uuid(),'{P1}',NULL,'{AG1}','granted','member','direct'),"
        f"(gen_random_uuid(),'{P2}',NULL,'{AG2}','granted','reviewer','direct')",
        # anchor: members(휴먼 id=org_member.id, agent id=team_member.id)
        f"INSERT INTO members (id,org_id,type,user_id,name,org_role,is_active) VALUES "
        f"('{OM_OWNER}','{ORG}','human','{U_OWNER}','owner@pg.test','owner',true),"
        f"('{OM_MEM}','{ORG}','human','{U_MEM}','mem@pg.test','member',true),"
        f"('{AG1}','{ORG}','agent',NULL,'Bot',NULL,true),"
        f"('{AG2}','{ORG}','agent',NULL,'Bot',NULL,true)",
        f"INSERT INTO member_identity_aliases (alias_id,member_id,org_id,project_id,alias_source) VALUES "
        f"('{TM_OWNER}','{OM_OWNER}','{ORG}','{P1}','human_team_member')",
        f"INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port) VALUES "
        f"(gen_random_uuid(),'{AG1}','{P1}','dev',9101),(gen_random_uuid(),'{AG2}','{P2}','qa',9102)",
    ]
    for s in stmts:
        await session.execute(text(s))
    # AC3-1: agent API key (team_member_id=member_id=AG1, 1:1) — dual-write 상태 모사
    from app.core.security import hash_token
    await session.execute(text(
        "DELETE FROM agent_api_keys WHERE id=:id"), {"id": str(APIKEY_ID)})
    await session.execute(text(
        "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,scope) "
        "VALUES (:id,:tm,:m,:pfx,:h,ARRAY['read','write'])"
    ), {"id": str(APIKEY_ID), "tm": str(AG1), "m": str(AG1), "pfx": "sk_live_0", "h": hash_token(APIKEY_RAW)})
    await session.commit()


@pytest.mark.anyio
async def test_resolve_member_parity_legacy_vs_anchor():
    """resolve_member: legacy vs anchor 0-diff (agent 멀티프로젝트·human owner·grant member)."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.services import member_resolver as mr

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        cases = [
            (_auth(AG1, api_key=True), None),      # agent proj1
            (_auth(AG2, api_key=True), None),      # agent proj2 (멀티프로젝트)
            (_auth(U_OWNER), P1),                  # human owner
            (_auth(U_MEM), P1),                    # human grant member
        ]
        for auth, pid in cases:
            mr.settings.member_ssot_resolver_shadow = False
            async with Session() as s:
                legacy = await mr.resolve_member(auth, ORG, s, project_id=pid)
            mr.settings.member_ssot_resolver_shadow = True
            async with Session() as s:
                anchor = await mr.resolve_member(auth, ORG, s, project_id=pid)
            assert _tup(legacy) == _tup(anchor), f"parity DIFF: legacy={_tup(legacy)} anchor={_tup(anchor)}"
    finally:
        mr.settings.member_ssot_resolver_shadow = False
        await engine.dispose()


@pytest.mark.anyio
async def test_lookup_members_parity_identity_and_canonicalization():
    """lookup: 직접 member·agent·orphan은 id/type 동일, 레거시 휴먼 team_member.id는 canonical 전환."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.services import member_resolver as mr

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
        ids = {AG1, AG2, OM_OWNER, OM_MEM, TM_OWNER, ORPHAN}
        mr.settings.member_ssot_resolver_shadow = False
        async with Session() as s:
            legacy = await mr.lookup_members_by_ids(ids, s)
        mr.settings.member_ssot_resolver_shadow = True
        async with Session() as s:
            anchor = await mr.lookup_members_by_ids(ids, s)

        # 직접 member(휴먼/에이전트) + orphan: id·type 동일
        for k in (AG1, AG2, OM_OWNER, OM_MEM, ORPHAN):
            assert (str(legacy[k].id), legacy[k].type) == (str(anchor[k].id), anchor[k].type), f"{k} 불일치"
        # 휴먼 direct name = email (M1 정합, 단일/batch 일관)
        assert anchor[OM_MEM].name == "mem@pg.test"
        # 레거시 휴먼 team_member.id → canonical 휴먼 member(org_member.id)
        assert anchor[TM_OWNER].id == OM_OWNER
    finally:
        mr.settings.member_ssot_resolver_shadow = False
        await engine.dispose()


@pytest.mark.anyio
async def test_apikey_resolve_parity_legacy_vs_anchor():
    """⚠️ 생명선: _resolve_api_key가 flag off(team_member) vs on(member)에서 **동일 AuthContext**
    (user_id·org_id·project_id·scope·api_key_id) — API key 인증 신원 무중단 입증."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core import config as _cfg
    from app.dependencies.auth import _resolve_api_key
    from app.services import member_resolver as mr

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        _cfg.settings.member_ssot_apikey_cut = False
        async with Session() as s:
            legacy = await _resolve_api_key(APIKEY_RAW, s)
        _cfg.settings.member_ssot_apikey_cut = True
        async with Session() as s:
            anchor = await _resolve_api_key(APIKEY_RAW, s)

        assert legacy.user_id == anchor.user_id, f"user_id 불일치(무중단 위반): {legacy.user_id} vs {anchor.user_id}"
        assert legacy.org_id == anchor.org_id
        assert legacy.claims["app_metadata"] == anchor.claims["app_metadata"], \
            f"app_metadata 불일치: {legacy.claims['app_metadata']} vs {anchor.claims['app_metadata']}"
    finally:
        _cfg.settings.member_ssot_apikey_cut = False
        await engine.dispose()
