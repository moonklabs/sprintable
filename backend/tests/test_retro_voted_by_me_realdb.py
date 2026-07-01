"""B4: `voted_by_me` — realdb ID-space 정합 실증.

설계 claim: `RetroVote.voter_id`는 vote 시 `canonicalize_member_id`를 거친 members.id 공간이고,
휴먼은 members.id=org_members.id로 ID-preserving 백필돼 `resolve_member`(레거시 경로).id와
정확히 같은 공간 — 별도 매핑 불요. mock으로는 이 claim 자체를 검증할 수 없다(양쪽 다 patch로
가짜값을 주입하면 우연히 맞아떨어짐) — 실 PG에서 canonicalize_member_id로 저장된 voter_id와
resolve_member로 해소한 requester id가 **진짜로 같은 값**인지 실증 필요.
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

ORG = uuid.UUID("cb000000-0000-0000-0000-000000000001")
USER_A = uuid.UUID("cb000000-0000-0000-0000-0000000000a1")  # item1에 투표
USER_B = uuid.UUID("cb000000-0000-0000-0000-0000000000a2")  # 미투표(cross-member 노출 0 검증)
OM_A = uuid.UUID("cb000000-0000-0000-0000-0000000000b1")
OM_B = uuid.UUID("cb000000-0000-0000-0000-0000000000b2")
PROJ = uuid.UUID("cb000000-0000-0000-0000-0000000000c1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    from app.models.retro import RetroItem, RetroSession, RetroVote
    from app.services.member_resolver import canonicalize_member_id

    for sql in [
        f"DELETE FROM retro_votes WHERE item_id IN "
        f"(SELECT id FROM retro_items WHERE session_id IN "
        f"(SELECT id FROM retro_sessions WHERE org_id='{ORG}'))",
        f"DELETE FROM retro_items WHERE session_id IN (SELECT id FROM retro_sessions WHERE org_id='{ORG}')",
        f"DELETE FROM retro_sessions WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{USER_A}','{USER_B}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','CB','cb-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER_A}','a@cb.test','x','A',true,true,0,false,0),"
        f"('{USER_B}','b@cb.test','x','B',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"('{OM_A}','{ORG}','{USER_A}','member'),('{OM_B}','{ORG}','{USER_B}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{OM_A}','granted'),"
        f"(gen_random_uuid(),'{PROJ}','{OM_B}','granted')",
    ]:
        await s.execute(text(sql))

    sess = RetroSession(id=uuid.uuid4(), org_id=ORG, project_id=PROJ, title="r", phase="vote")
    s.add(sess)
    await s.flush()

    item1 = RetroItem(id=uuid.uuid4(), session_id=sess.id, category="good", text="i1")
    item2 = RetroItem(id=uuid.uuid4(), session_id=sess.id, category="good", text="i2")
    s.add_all([item1, item2])
    await s.flush()

    # 실제 vote_item 라우트와 동일 경로 — canonicalize_member_id를 거쳐 voter_id 저장.
    voter_id = await canonicalize_member_id(OM_A, s)
    s.add(RetroVote(id=uuid.uuid4(), item_id=item1.id, voter_id=voter_id))
    await s.flush()
    await s.commit()

    return {"session_id": sess.id, "item1_id": item1.id, "item2_id": item2.id}


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_voted_by_me_id_space_matches_real_resolve_member():
    from app.repositories.retro import RetroSessionRepository
    from app.routers.retros import get_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)

        # USER_A(투표자 본인) — item1만 voted_by_me=True.
        async with Session() as s:
            out = await get_session(id=ids["session_id"], db=s, auth=_auth(USER_A), repo=RetroSessionRepository(s, ORG))
            by_id = {i.id: i for i in out.items}
            assert by_id[ids["item1_id"]].voted_by_me is True
            assert by_id[ids["item2_id"]].voted_by_me is False

        # USER_B(미투표) — item1도 voted_by_me=False(cross-member 노출 0).
        async with Session() as s:
            out = await get_session(id=ids["session_id"], db=s, auth=_auth(USER_B), repo=RetroSessionRepository(s, ORG))
            by_id = {i.id: i for i in out.items}
            assert by_id[ids["item1_id"]].voted_by_me is False
            assert by_id[ids["item2_id"]].voted_by_me is False
    finally:
        await eng.dispose()
