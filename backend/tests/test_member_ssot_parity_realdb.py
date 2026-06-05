"""E-MEMBER-SSOT AC2-3 (H2): 실행 가능 real-DB parity 테스트.

legacy(org_members/team_members) vs anchor(members/aliases) resolver를 **동일 실 데이터**로
대조해 0-diff 입증. mocked로는 못 잡는 실데이터 정합(orphan·멀티프로젝트·휴먼 name)을 검증.

DB env(ALEMBIC_DATABASE_URL 또는 PARITY_TEST_DATABASE_URL) 없으면 skip — CI alembic-fresh-db
잡(postgres + alembic upgrade head)에서 실행되며, 로컬은 throwaway PG로 실행.
"""
from __future__ import annotations

import os
import uuid
from datetime import date as _date
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
    # AC3-4 2-2: cutover(0088) 후 team_members는 projection 뷰 → INSERT 불가. 물리 레거시 행은
    # team_members_legacy에 시드. 미적용 DB(pre-0088)면 team_members가 물리테이블 — 동적 선택(양립).
    physical_tm = (await session.execute(text(
        "SELECT CASE WHEN to_regclass('public.team_members_legacy') IS NOT NULL "
        "THEN 'team_members_legacy' ELSE 'team_members' END"
    ))).scalar()
    stmts = [
        # 방어: fresh `alembic upgrade head`에선 0075 DROP NOT NULL이 미지속되는 관찰(별건 flag)이 있어,
        # 에이전트 placement(org_member_id NULL) 시드를 위해 idempotent하게 nullable 보장(테스트 신뢰성).
        "ALTER TABLE project_access ALTER COLUMN org_member_id DROP NOT NULL",
        # 의존 역순 정리(이전 실행 잔여) — 단일 트랜잭션, 유효 문만(실패 시 tx abort 방지)
        f"DELETE FROM agent_project_profiles WHERE member_id IN ('{AG1}','{AG2}')",
        f"DELETE FROM member_identity_aliases WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{P1}','{P2}')",
        f"DELETE FROM {physical_tm} WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{U_OWNER}','{U_MEM}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','PG','pgorg','free')",
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{U_OWNER}','owner@pg.test','x','Owner',true,true,0,false,0),('{U_MEM}','mem@pg.test','x','Mem',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM_OWNER}','{ORG}','{U_OWNER}','owner'),('{OM_MEM}','{ORG}','{U_MEM}','member')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{P1}','{ORG}','P1',0),('{P2}','{ORG}','P2',0)",
        # agent_config required for agents by chk_agent_has_config (type<>'agent' OR agent_config IS NOT NULL)
        f"INSERT INTO {physical_tm} (id,project_id,org_id,user_id,type,name,role,color,can_manage_members,is_active,created_by,agent_config) VALUES "
        f"('{TM_OWNER}','{P1}','{ORG}','{U_OWNER}','human','Owner','owner','#3385f8',true,true,NULL,NULL),"
        f"('{AG1}','{P1}','{ORG}',NULL,'agent','Bot','member','#ff0000',false,true,'{U_OWNER}','{{}}'::jsonb),"
        f"('{AG2}','{P2}','{ORG}',NULL,'agent','Bot','reviewer','#00ff00',false,true,'{U_OWNER}','{{}}'::jsonb)",
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


NEW_TM = uuid.UUID("b5000000-0000-0000-0000-0000000000b9")
NEW_APIKEY = uuid.UUID("b7000000-0000-0000-0000-0000000000b9")


async def _make_new_agent_tm(session):
    """members/profile/apikey 없는 신규 agent team_member 삽입(재실행 정리 포함). TeamMember ORM 반환."""
    from sqlalchemy import select, text
    from app.models.team import TeamMember
    await session.execute(text("DELETE FROM agent_api_keys WHERE id=:i"), {"i": str(NEW_APIKEY)})
    await session.execute(text("DELETE FROM agent_project_profiles WHERE member_id=:i"), {"i": str(NEW_TM)})
    await session.execute(text("DELETE FROM members WHERE id=:i"), {"i": str(NEW_TM)})
    await session.execute(text("DELETE FROM team_members WHERE id=:i"), {"i": str(NEW_TM)})
    await session.execute(text(
        "INSERT INTO team_members (id,project_id,org_id,user_id,type,name,role,color,can_manage_members,is_active,created_by,agent_role,fakechat_port) "
        "VALUES (:id,:p,:o,NULL,'agent','NewBot','member','#fff',false,true,:cb,'dev',9199)"
    ), {"id": str(NEW_TM), "p": str(P1), "o": str(ORG), "cb": str(U_OWNER)})
    await session.commit()
    return (await session.execute(select(TeamMember).where(TeamMember.id == NEW_TM))).scalar_one()


@pytest.mark.anyio
async def test_agent_anchor_writesync_creates_members_and_profile():
    """⚠️ 생명선 AC3-1b AC1: 신규 agent 생성 write-sync가 members(id=tm.id·type=agent·owner=생성휴먼)
    + agent_project_profiles(member=tm.id·런타임 미러)를 만든다 → cut-on 무중단·project_id 해소·FK 충족."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.services.agent_anchor_sync import sync_agent_anchor_on_create

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            tm = await _make_new_agent_tm(s)
            await sync_agent_anchor_on_create(s, tm, created_by=U_OWNER)
            await s.commit()
        async with Session() as s:
            m = (await s.execute(text(
                "SELECT type, owner_member_id, name, is_active FROM members WHERE id=:i"), {"i": str(NEW_TM)})).first()
            prof = (await s.execute(text(
                "SELECT project_id, agent_role, fakechat_port FROM agent_project_profiles WHERE member_id=:i"), {"i": str(NEW_TM)})).first()
            # AC3-4 2-1: write-sync가 project_access placement도 생성(뷰 role/can_manage 소스)
            pa = (await s.execute(text(
                "SELECT project_id, role, access_source FROM project_access WHERE member_id=:i"), {"i": str(NEW_TM)})).first()
        assert m is not None and m.type == "agent" and m.is_active is True, "members(agent) 미생성"
        assert str(m.owner_member_id) == str(OM_OWNER), f"owner_member_id=생성 휴먼 member 아님: {m.owner_member_id}"
        assert prof is not None and str(prof.project_id) == str(P1) and prof.agent_role == "dev", "agent_project_profiles 미생성/미러 불일치"
        assert pa is not None and str(pa.project_id) == str(P1) and pa.access_source == "direct", "project_access placement 미생성(AC3-4 2-1)"

        # 멱등: 재호출해도 중복/에러 없음
        async with Session() as s:
            from sqlalchemy import select
            from app.models.team import TeamMember
            tmobj = (await s.execute(select(TeamMember).where(TeamMember.id == NEW_TM))).scalar_one()
            await sync_agent_anchor_on_create(s, tmobj, created_by=U_OWNER)
            await s.commit()
            prof_cnt = (await s.execute(text(
                "SELECT count(*) FROM agent_project_profiles WHERE member_id=:i"), {"i": str(NEW_TM)})).scalar_one()
            assert prof_cnt == 1, f"멱등 위반: profile {prof_cnt}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apikey_insert_after_writesync_succeeds_and_absent_member_violates_fk():
    """⚠️ 생명선 AC3-1b AC3: 0080 FK 재추가 후 — write-sync로 members 선행 시 신규 agent api_key
    INSERT 성공(H1을 올바른 방식으로 해소), members 부재 member_id는 FK 위반(트랩#7/8 가드)."""
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.services.agent_anchor_sync import sync_agent_anchor_on_create

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            tm = await _make_new_agent_tm(s)
            await sync_agent_anchor_on_create(s, tm, created_by=U_OWNER)  # members 선행
            await s.commit()
        # write-sync 후 api_key INSERT(member_id=tm.id) → FK 충족 성공
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,scope) "
                "VALUES (:id,:tm,:m,'sk_live_b9','hashb9',ARRAY['read','write'])"
            ), {"id": str(NEW_APIKEY), "tm": str(NEW_TM), "m": str(NEW_TM)})
            await s.commit()
            cnt = (await s.execute(text("SELECT count(*) FROM agent_api_keys WHERE id=:i"), {"i": str(NEW_APIKEY)})).scalar_one()
            assert cnt == 1, "write-sync 후 api_key INSERT 실패(H1 회귀)"
        # members 부재 member_id → FK 위반(0080 재추가 입증)
        absent = uuid.UUID("b5000000-0000-0000-0000-0000000000ba")
        async with Session() as s:
            with pytest.raises(IntegrityError):
                await s.execute(text(
                    "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash) "
                    "VALUES (gen_random_uuid(),:tm,:m,'sk_live_ba','hashba')"
                ), {"tm": str(absent), "m": str(absent)})
                await s.commit()
    finally:
        await engine.dispose()


_SD = "2026-06-04"  # standup 테스트 날짜
_SD_DATE = _date.fromisoformat(_SD)


@pytest.mark.anyio
async def test_canonicalize_member_id_alias_and_passthrough():
    """AC3-3: 레거시 휴먼 team_member.id → canonical(org_member.id), 직접 canonical/agent는 그대로."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.services.member_resolver import canonicalize_member_id

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            assert await canonicalize_member_id(TM_OWNER, s) == OM_OWNER  # 레거시 휴먼 → canonical
            assert await canonicalize_member_id(OM_MEM, s) == OM_MEM      # 이미 canonical
            assert await canonicalize_member_id(AG1, s) == AG1            # 에이전트 passthrough
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_get_missing_canonical_single_identity():
    """⚠️ AC3-3 핵심: missing 산정이 effective 휴먼 access를 canonical로 집계 — 레거시 team_member.id로
    제출해도 canonical로 인식(#1167 무회귀), 멀티프로젝트 단일 신원."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.repositories.standup import StandupEntryRepository

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text("DELETE FROM standup_entries WHERE project_id=:p AND date=:d"),
                            {"p": str(P1), "d": _SD_DATE})
            # ⚠️ 실 grant 플로우 모사: create_project_access는 member_id를 NULL로 둔다(org_member_id만).
            # branch2가 member_id 키면 OM_MEM 누락(신규 grant-only 휴먼 미표시) → org_member_id 키여야 함.
            await s.execute(text(
                "UPDATE project_access SET member_id=NULL WHERE project_id=:p AND org_member_id=:m"),
                {"p": str(P1), "m": str(OM_MEM)})
            await s.commit()
        # roster(P1) = owner(OM_OWNER) ∪ grant(OM_MEM, member_id=NULL) ∪ 레거시 휴먼 tm(TM_OWNER→OM_OWNER)
        async with Session() as s:
            missing = set(await StandupEntryRepository(s, ORG).get_missing(P1, _SD_DATE))
        assert missing == {OM_OWNER, OM_MEM}, f"roster 불일치: {missing}"

        # OM_MEM이 canonical로 제출 → missing에서 빠짐
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO standup_entries (id,org_id,project_id,author_id,date,plan_story_ids) "
                "VALUES (gen_random_uuid(),:o,:p,:a,:d,'{}')"
            ), {"o": str(ORG), "p": str(P1), "a": str(OM_MEM), "d": _SD_DATE})
            await s.commit()
            m2 = set(await StandupEntryRepository(s, ORG).get_missing(P1, _SD_DATE))
        assert m2 == {OM_OWNER}, f"canonical 제출 미반영: {m2}"

        # 레거시 team_member.id(TM_OWNER)로 제출해도 canonical(OM_OWNER)로 인식 → missing 비게
        async with Session() as s:
            await s.execute(text(
                "INSERT INTO standup_entries (id,org_id,project_id,author_id,date,plan_story_ids) "
                "VALUES (gen_random_uuid(),:o,:p,:a,:d,'{}')"
            ), {"o": str(ORG), "p": str(P1), "a": str(TM_OWNER), "d": _SD_DATE})
            await s.commit()
            m3 = set(await StandupEntryRepository(s, ORG).get_missing(P1, _SD_DATE))
        assert m3 == set(), f"레거시 id 제출이 canonical로 인식 안 됨(#1167 회귀): {m3}"
    finally:
        await engine.dispose()


# ── 0080 hotfix: 가드 VALIDATE의 bad>0(RAISE NOTICE) 분기 syntax 검증(트랩#4 실DB-only) ──────────
_FK_0080 = "fk_agent_api_keys_member_id_members"
_GUARD_DO_0080 = f"""
DO $$
DECLARE bad int;
BEGIN
    SELECT count(*) INTO bad FROM agent_api_keys ak
    WHERE ak.member_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = ak.member_id);
    IF bad = 0 THEN
        ALTER TABLE agent_api_keys VALIDATE CONSTRAINT {_FK_0080};
    ELSE
        RAISE NOTICE 'agent_api_keys.member_id FK NOT VALID 유지: members 부재 row % 건 — AC2 감사·보정 후 재VALIDATE 필요', bad;
    END IF;
END $$;
"""


@pytest.mark.anyio
async def test_0080_guard_validate_raise_branch_bad_gt0():
    """⚠️ 트랩#4(실DB-only): 0080 가드 VALIDATE의 bad>0(RAISE NOTICE) 분기가 syntax-valid해야 한다.
    CI fresh-DB는 bad=0(VALIDATE 분기)라 RAISE 분기 미발현 — members 부재 active key가 실재하는 dev에서만
    터졌던 `too many parameters for RAISE`(%% vs % 회귀) 가드. 위반행을 FK 추가 전 INSERT(NOT VALID도
    신규검증) → FK NOT VALID → 가드 DO 실행이 크래시 없이 NOT VALID 유지하는지."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    bad_key = uuid.UUID("b7000000-0000-0000-0000-0000000000c0")
    absent_member = uuid.UUID("b9000000-0000-0000-0000-0000000000c0")
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text("DELETE FROM agent_api_keys WHERE id=:i"), {"i": str(bad_key)})
            for fk in (_FK_0080, "agent_api_keys_member_id_fkey"):
                await s.execute(text(f"ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS {fk}"))
            # FK 부재 상태에서 위반행 INSERT(member_id가 members에 없음) — bad>0 모사
            await s.execute(text(
                "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,scope) "
                "VALUES (:id,:tm,:m,'sk_live_c0','hashc0',ARRAY['read','write'])"
            ), {"id": str(bad_key), "tm": str(AG1), "m": str(absent_member)})
            await s.execute(text(
                f"ALTER TABLE agent_api_keys ADD CONSTRAINT {_FK_0080} "
                f"FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL NOT VALID"
            ))
            await s.commit()
        # 가드 DO 실행 — bad>0 → RAISE NOTICE 분기. SyntaxError 없이 통과해야(%% 회귀 가드)
        async with Session() as s:
            await s.execute(text(_GUARD_DO_0080))
            await s.commit()
        # FK는 NOT VALID 유지(가드가 VALIDATE 안 함)
        async with Session() as s:
            convalidated = (await s.execute(text(
                "SELECT convalidated FROM pg_constraint WHERE conname=:n"), {"n": _FK_0080})).scalar_one()
        assert convalidated is False, "bad>0인데 FK가 VALIDATE됨(가드 오작동)"
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM agent_api_keys WHERE id=:i"), {"i": str(bad_key)})
            await s.execute(text(f"ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS {_FK_0080}"))
            # 모델 baseline FK 복원(NOT VALID — 검증 실패 없이 재실행/타테스트 오염 방지)
            await s.execute(text("ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS agent_api_keys_member_id_fkey"))
            await s.execute(text(
                "ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_member_id_fkey "
                "FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL NOT VALID"
            ))
            await s.commit()
        await engine.dispose()


# ── 0082 가드 VALIDATE의 bad>0(RAISE NOTICE) 분기 syntax 검증(트랩#4 실DB-only) ──────────────────
_GUARD_DO_0082 = f"""
DO $$
DECLARE bad int;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{_FK_0080}' AND NOT convalidated) THEN
        SELECT count(*) INTO bad FROM agent_api_keys ak
        WHERE ak.member_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = ak.member_id);
        IF bad = 0 THEN
            ALTER TABLE agent_api_keys VALIDATE CONSTRAINT {_FK_0080};
        ELSE
            RAISE NOTICE 'agent_api_keys.member_id FK NOT VALID 유지: members 부재 row % 건 (window 보정 후에도 잔여 — 점검 필요)', bad;
        END IF;
    END IF;
END $$;
"""


@pytest.mark.anyio
async def test_0082_guard_validate_raise_branch_bad_gt0():
    """⚠️ 트랩#4(실DB-only): 0082 가드 VALIDATE의 bad>0(RAISE NOTICE) 분기가 syntax-valid해야 한다.
    0082 백필은 team_members 기반이라 team_member 없는 orphan api_key member_id는 보정 못 함 → bad>0
    잔여 시 RAISE 분기를 탄다(0080과 동일 % 회귀 가드, IF EXISTS NOT convalidated 래퍼 포함). 위반행을
    FK 추가 전 INSERT(NOT VALID도 신규검증) → FK NOT VALID → 가드 DO 크래시 없이 NOT VALID 유지하는지."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    bad_key = uuid.UUID("b7000000-0000-0000-0000-0000000000c2")
    # member_id가 members에도 없고 team_member.id도 아닌 orphan — 0082 백필(members.id=team_member.id 기반)
    # 으로도 생성 불가 → bad>0 잔여. team_member_id는 실존 AG1(agent_api_keys.team_member_id FK 충족).
    orphan_member = uuid.UUID("b9000000-0000-0000-0000-0000000000c2")
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text("DELETE FROM agent_api_keys WHERE id=:i"), {"i": str(bad_key)})
            for fk in (_FK_0080, "agent_api_keys_member_id_fkey"):
                await s.execute(text(f"ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS {fk}"))
            await s.execute(text(
                "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,scope) "
                "VALUES (:id,:tm,:m,'sk_live_c2','hashc2',ARRAY['read','write'])"
            ), {"id": str(bad_key), "tm": str(AG1), "m": str(orphan_member)})
            await s.execute(text(
                f"ALTER TABLE agent_api_keys ADD CONSTRAINT {_FK_0080} "
                f"FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL NOT VALID"
            ))
            await s.commit()
        # 0082 가드 DO 실행 — bad>0 → RAISE NOTICE 분기. SyntaxError 없이 통과해야(% 회귀 가드)
        async with Session() as s:
            await s.execute(text(_GUARD_DO_0082))
            await s.commit()
        async with Session() as s:
            convalidated = (await s.execute(text(
                "SELECT convalidated FROM pg_constraint WHERE conname=:n"), {"n": _FK_0080})).scalar_one()
        assert convalidated is False, "bad>0인데 FK가 VALIDATE됨(가드 오작동)"
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM agent_api_keys WHERE id=:i"), {"i": str(bad_key)})
            await s.execute(text(f"ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS {_FK_0080}"))
            await s.execute(text("ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS agent_api_keys_member_id_fkey"))
            await s.execute(text(
                "ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_member_id_fkey "
                "FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL NOT VALID"
            ))
            await s.commit()
        await engine.dispose()


# ── 0083: orphan-org dead agent api_key revoke + member_id NULL + FK VALIDATE ──────────────────────
_DO_0083 = f"""
DO $$
DECLARE revoked int; bad int;
BEGIN
    UPDATE agent_api_keys SET revoked_at = now(), member_id = NULL
    WHERE revoked_at IS NULL AND member_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = agent_api_keys.member_id);
    GET DIAGNOSTICS revoked = ROW_COUNT;
    RAISE NOTICE 'orphan-org dead agent api_key revoke + member_id NULL: % 건', revoked;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '{_FK_0080}' AND NOT convalidated) THEN
        SELECT count(*) INTO bad FROM agent_api_keys ak
        WHERE ak.member_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = ak.member_id);
        IF bad = 0 THEN
            ALTER TABLE agent_api_keys VALIDATE CONSTRAINT {_FK_0080};
        ELSE
            RAISE NOTICE 'FK NOT VALID 유지 (bad=% 잔여)', bad;
        END IF;
    END IF;
END $$;
"""


@pytest.mark.anyio
async def test_0083_revoke_orphan_org_apikey_and_validate():
    """⚠️ AC2 마무리: 0083이 orphan-org dead agent 키(members 부재 member_id)를 revoke+member_id NULL로
    정리하고 FK를 VALIDATE하되, **legit 키(member_id 존재)는 안 건드린다**. revoke만으론 FK 위반이 남으므로
    member_id=NULL이 핵심(VALIDATE는 revoked 무관 전 행 검사)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    legit_key = uuid.UUID("b7000000-0000-0000-0000-0000000000d1")   # member_id=AG1(존재) — 무영향
    orphan_key = uuid.UUID("b7000000-0000-0000-0000-0000000000d2")  # member_id=orphan — revoke 대상
    orphan_member = uuid.UUID("b9000000-0000-0000-0000-0000000000d2")
    try:
        async with Session() as s:
            await _seed(s)
            for k in (legit_key, orphan_key):
                await s.execute(text("DELETE FROM agent_api_keys WHERE id=:i"), {"i": str(k)})
            for fk in (_FK_0080, "agent_api_keys_member_id_fkey"):
                await s.execute(text(f"ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS {fk}"))
            await s.execute(text(
                "INSERT INTO agent_api_keys (id,team_member_id,member_id,key_prefix,key_hash,scope) VALUES "
                "(:lk,:tm,:lm,'sk_live_d1','hd1',ARRAY['read','write']),"
                "(:ok,:tm,:om,'sk_live_d2','hd2',ARRAY['read','write'])"
            ), {"lk": str(legit_key), "ok": str(orphan_key), "tm": str(AG1), "lm": str(AG1), "om": str(orphan_member)})
            await s.execute(text(
                f"ALTER TABLE agent_api_keys ADD CONSTRAINT {_FK_0080} "
                f"FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL NOT VALID"
            ))
            await s.commit()
        async with Session() as s:
            await s.execute(text(_DO_0083))
            await s.commit()
        async with Session() as s:
            legit = (await s.execute(text(
                "SELECT member_id, revoked_at IS NULL FROM agent_api_keys WHERE id=:i"), {"i": str(legit_key)})).first()
            orphan = (await s.execute(text(
                "SELECT member_id, revoked_at IS NULL FROM agent_api_keys WHERE id=:i"), {"i": str(orphan_key)})).first()
            conval = (await s.execute(text(
                "SELECT convalidated FROM pg_constraint WHERE conname=:n"), {"n": _FK_0080})).scalar_one()
        assert str(legit[0]) == str(AG1) and legit[1] is True, f"legit 키 영향받음: {legit}"
        assert orphan[0] is None and orphan[1] is False, f"orphan 키 revoke+NULL 안 됨: {orphan}"
        assert conval is True, "orphan 정리 후에도 FK 미validate"
    finally:
        async with Session() as s:
            for k in (legit_key, orphan_key):
                await s.execute(text("DELETE FROM agent_api_keys WHERE id=:i"), {"i": str(k)})
            await s.execute(text(f"ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS {_FK_0080}"))
            await s.execute(text("ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS agent_api_keys_member_id_fkey"))
            await s.execute(text(
                "ALTER TABLE agent_api_keys ADD CONSTRAINT agent_api_keys_member_id_fkey "
                "FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE SET NULL NOT VALID"
            ))
            await s.commit()
        await engine.dispose()


@pytest.mark.anyio
async def test_ensure_human_member_creates_anchor_idempotent():
    """AC3-2c: ensure_human_member가 members 없는 휴먼 org_member에 members 행(id=om.id·type=human·
    name=email)을 멱등 생성 — create_project_access가 member_id=org_member.id 세팅 전 호출(FK 충족)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.services.agent_anchor_sync import ensure_human_member

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    new_user = uuid.UUID("b2000000-0000-0000-0000-0000000000e1")
    new_om = uuid.UUID("b3000000-0000-0000-0000-0000000000e1")
    try:
        async with Session() as s:
            await _seed(s)
            # members 없는 신규 휴먼 org_member(0075 이후 생성 모사)
            await s.execute(text("DELETE FROM members WHERE id=:i"), {"i": str(new_om)})
            await s.execute(text("DELETE FROM org_members WHERE id=:i"), {"i": str(new_om)})
            await s.execute(text("DELETE FROM users WHERE id=:i"), {"i": str(new_user)})
            await s.execute(text(
                "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
                "VALUES (:u,'newhuman@pg.test','x','NewHuman',true,true,0,false,0)"), {"u": str(new_user)})
            await s.execute(text(
                "INSERT INTO org_members (id,org_id,user_id,role) VALUES (:om,:o,:u,'member')"),
                {"om": str(new_om), "o": str(ORG), "u": str(new_user)})
            await s.commit()
        async with Session() as s:
            ok = await ensure_human_member(s, new_om)
            await s.commit()
            assert ok is True
            m = (await s.execute(text(
                "SELECT type, name, user_id FROM members WHERE id=:i"), {"i": str(new_om)})).first()
        assert m is not None and m.type == "human", "휴먼 members 미생성"
        assert m.name == "NewHuman" and str(m.user_id) == str(new_user)
        # 멱등: 재호출 무에러·중복 0
        async with Session() as s:
            await ensure_human_member(s, new_om)
            await s.commit()
            cnt = (await s.execute(text("SELECT count(*) FROM members WHERE id=:i"), {"i": str(new_om)})).scalar_one()
            assert cnt == 1
        # org_member 부재 → False(미세팅)
        async with Session() as s:
            assert await ensure_human_member(s, uuid.UUID("b3000000-0000-0000-0000-0000000000ee")) is False
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM members WHERE id=:i"), {"i": str(new_om)})
            await s.execute(text("DELETE FROM org_members WHERE id=:i"), {"i": str(new_om)})
            await s.execute(text("DELETE FROM users WHERE id=:i"), {"i": str(new_user)})
            await s.commit()
        await engine.dispose()


@pytest.mark.anyio
async def test_ensure_human_member_orphan_safe():
    """⚠️ E1(QA): ensure_human_member orphan-safe — orphan org면 False(members.org_id FK 500 회피),
    orphan user면 user_id=NULL(members.user_id FK 회피). 0084 §1 동형(트랩#3 실DB orphan)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.services.agent_anchor_sync import ensure_human_member

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    om_orphan_org = uuid.UUID("b3000000-0000-0000-0000-0000000000f1")   # org_id가 organizations에 없음
    om_orphan_user = uuid.UUID("b3000000-0000-0000-0000-0000000000f2")  # user_id가 users에 없음
    orphan_user = uuid.UUID("b2000000-0000-0000-0000-0000000000f2")
    try:
        async with Session() as s:
            await _seed(s)
            for i in (om_orphan_org, om_orphan_user):
                await s.execute(text("DELETE FROM members WHERE id=:i"), {"i": str(i)})
                await s.execute(text("DELETE FROM org_members WHERE id=:i"), {"i": str(i)})
            # org_members.org_id/user_id는 FK 없음 → orphan 삽입 가능(실DB 정합 모사)
            await s.execute(text(
                "INSERT INTO org_members (id,org_id,user_id,role) VALUES "
                "(:o1,'cccccccc-0000-0000-0000-0000000000cc',:u0,'member'),"  # orphan org
                "(:o2,:org,:uo,'member')"                                      # orphan user
            ), {"o1": str(om_orphan_org), "u0": str(U_MEM), "o2": str(om_orphan_user), "org": str(ORG), "uo": str(orphan_user)})
            await s.commit()
        # orphan org → False, members 미생성(500 없이)
        async with Session() as s:
            assert await ensure_human_member(s, om_orphan_org) is False, "orphan org인데 True"
            await s.commit()
            cnt = (await s.execute(text("SELECT count(*) FROM members WHERE id=:i"), {"i": str(om_orphan_org)})).scalar_one()
            assert cnt == 0, "orphan org members 생성됨(FK 위험)"
        # orphan user → True, members 생성·user_id NULL
        async with Session() as s:
            assert await ensure_human_member(s, om_orphan_user) is True
            await s.commit()
            row = (await s.execute(text("SELECT user_id FROM members WHERE id=:i"), {"i": str(om_orphan_user)})).first()
            assert row is not None and row[0] is None, f"orphan user인데 user_id 비-NULL: {row}"
    finally:
        async with Session() as s:
            for i in (om_orphan_org, om_orphan_user):
                await s.execute(text("DELETE FROM members WHERE id=:i"), {"i": str(i)})
                await s.execute(text("DELETE FROM org_members WHERE id=:i"), {"i": str(i)})
            await s.commit()
        await engine.dispose()


@pytest.mark.anyio
async def test_ac3_4_team_members_projection_view():
    """AC3-4 2-2: team_members가 projection 뷰(0088)로 강등됨을 검증(migrate 0088 적용 DB 전제).

    ⚠️ migrate head<0088이면 team_members가 물리테이블 → relkind!='v'이라 skip(가드).
    검증: ① relkind='v'(뷰) ② agent(AG1) 행 = anchor 소스(role=project_access, agent_role/presence=profile)
    ③ 에이전트는 id로 단일행(1:1) ④ deleted members 제외 ⑤ team_members_legacy 물리 잔존(가역 자산).
    """
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            relkind = (await s.execute(text(
                "SELECT relkind FROM pg_class WHERE relname='team_members'"
            ))).scalar()
        if relkind != "v":
            pytest.skip(f"team_members relkind={relkind} — migrate 0088 미적용, AC3-4 cutover 전")

        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            # ② AG1(agent) 행 = anchor 소스 재현: role(project_access P1=member), agent_role/port(profile=dev/9101)
            row = (await s.execute(text(
                "SELECT type, role, agent_role, fakechat_port FROM team_members WHERE id=:id"
            ), {"id": str(AG1)})).first()
            assert row is not None, "AG1 뷰 미출현"
            assert row[0] == "agent" and row[1] == "member" and row[2] == "dev" and row[3] == 9101, f"AG1 매핑 불일치: {row}"
            # ③ 에이전트 id 단일행(1:1)
            cnt = (await s.execute(text(
                "SELECT count(*) FROM team_members WHERE id=:id"), {"id": str(AG1)})).scalar_one()
            assert cnt == 1, f"agent 다중행: {cnt}"
            # ④ deleted members 제외 — 임시 soft-delete 후 뷰 미출현
            await s.execute(text("UPDATE members SET deleted_at=now() WHERE id=:id"), {"id": str(AG1)})
            await s.commit()
            gone = (await s.execute(text(
                "SELECT count(*) FROM team_members WHERE id=:id"), {"id": str(AG1)})).scalar_one()
            assert gone == 0, "deleted member가 뷰에 잔존"
            await s.execute(text("UPDATE members SET deleted_at=NULL WHERE id=:id"), {"id": str(AG1)})
            await s.commit()
            # ⑤ team_members_legacy 물리테이블 잔존(G5 가역 자산)
            legacy_kind = (await s.execute(text(
                "SELECT relkind FROM pg_class WHERE relname='team_members_legacy'"
            ))).scalar()
            assert legacy_kind == "r", f"team_members_legacy 물리테이블 부재: {legacy_kind}"
    finally:
        await engine.dispose()


# ── 0089(AC3-5 ①) project_access FK 가드 VALIDATE의 bad>0 분기(트랩#4b 실DB-only) ───────────────
_GUARD_DO_0089_MEMBER = """
DO $$
DECLARE bad int;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_access_member') THEN
        SELECT count(*) INTO bad FROM project_access pa
        WHERE pa.member_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM members m WHERE m.id = pa.member_id);
        IF bad = 0 THEN
            ALTER TABLE project_access VALIDATE CONSTRAINT fk_project_access_member;
            RAISE NOTICE 'fk_project_access_member validated (bad=0)';
        ELSE
            RAISE NOTICE 'fk_project_access_member NOT VALID 유지: members 부재 referent % 건 — 점검 후 재VALIDATE 필요', bad;
        END IF;
    END IF;
END $$;
"""


@pytest.mark.anyio
async def test_0089_guard_validate_project_access_fk_bad_gt0():
    """⚠️ AC3-5 ① 트랩#4b(실DB-only): 0089 가드 VALIDATE의 bad>0(RAISE NOTICE) 분기가 syntax-valid·
    크래시 없이 NOT VALID 유지하는지. 위반행을 FK 추가 전 INSERT(NOT VALID도 신규검증) → 가드 DO 실행.
    CI fresh-DB는 bad=0(VALIDATE)라 RAISE 분기 미발현 — % placeholder 회귀 가드(0080 교훈 동형)."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    bad_pa = uuid.UUID("c0000000-0000-0000-0000-0000000000fa")
    absent_member = uuid.UUID("c9000000-0000-0000-0000-0000000000fa")
    try:
        async with Session() as s:
            await _seed(s)
            await s.execute(text("DELETE FROM project_access WHERE id=:i"), {"i": str(bad_pa)})
            # FK 잠시 DROP → 위반행(member_id가 members에 없음) INSERT → NOT VALID로 재추가(기존행 검증 보류)
            await s.execute(text("ALTER TABLE project_access DROP CONSTRAINT IF EXISTS fk_project_access_member"))
            await s.execute(text(
                "INSERT INTO project_access (id,project_id,org_member_id,member_id,permission,access_source) "
                "VALUES (:id,:p,NULL,:m,'granted','direct')"
            ), {"id": str(bad_pa), "p": str(P1), "m": str(absent_member)})
            await s.execute(text(
                "ALTER TABLE project_access ADD CONSTRAINT fk_project_access_member "
                "FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE NOT VALID"
            ))
            await s.commit()
        # 가드 DO 실행 — bad>0 → RAISE NOTICE 분기(크래시·% 회귀 없이)
        async with Session() as s:
            await s.execute(text(_GUARD_DO_0089_MEMBER))
            await s.commit()
        async with Session() as s:
            convalidated = (await s.execute(text(
                "SELECT convalidated FROM pg_constraint WHERE conname='fk_project_access_member'"
            ))).scalar_one()
        assert convalidated is False, "bad>0인데 FK가 VALIDATE됨(가드 오작동)"
    finally:
        async with Session() as s:
            await s.execute(text("DELETE FROM project_access WHERE id=:i"), {"i": str(bad_pa)})
            await s.commit()
        await engine.dispose()
