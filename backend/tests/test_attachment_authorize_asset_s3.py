"""E-STORAGE-SSOT S3 — authorize_attachment asset_id 분기(real-DB).

AC1 project-access(or org-level) 유저만·AC3 외부/wrong-bucket(asset_id=truth라 BE derive)·AC4 cross-org
project_id 403/404. asset_id=truth(D1)라 BE 가 registry 에서 {container,object_path} 권위 derive·반환.
DB env 없으면 skip(CI alembic-fresh 잡서 실행).
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

ORG = uuid.UUID("a3000000-0000-0000-0000-000000000001")
ORG2 = uuid.UUID("a3000000-0000-0000-0000-000000000002")
USER = uuid.UUID("a3000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("a3000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("a3000000-0000-0000-0000-0000000000c1")  # USER grant
PROJ_B = uuid.UUID("a3000000-0000-0000-0000-0000000000c2")  # USER no-access
PROJ_OTHER = uuid.UUID("a3000000-0000-0000-0000-0000000000d1")  # ORG2
BUCKET = "sprintable-memo-attachments"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s):
    for sql in [
        f"DELETE FROM assets WHERE org_id IN ('{ORG}','{ORG2}')",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id IN ('{ORG}','{ORG2}')",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id IN ('{ORG}','{ORG2}')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A3','a3','free')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG2}','A3b','a3b','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@a3.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_OTHER}','{ORG2}','OtherP')",
        # USER grant PROJ_A 만.
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _mk_asset(s, org, project) -> uuid.UUID:
    aid = uuid.uuid4()
    await s.execute(
        text(
            "INSERT INTO assets (id,org_id,project_id,container,object_path,name,size_bytes) "
            "VALUES (:id, :org, :proj, :bucket, :path, 'x.png', 1)"
        ),
        {"id": str(aid), "org": str(org), "proj": (str(project) if project else None),
         "bucket": BUCKET, "path": f"x/{aid}.png"},
    )
    await s.commit()
    return aid


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email="u@a3.test", claims={}, org_id=str(ORG))


@pytest.mark.anyio
async def test_authorize_asset_branch():
    from app.routers.attachments import authorize_attachment

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            a_ok = await _mk_asset(s, ORG, PROJ_A)        # 접근 가능 project
            a_noacc = await _mk_asset(s, ORG, PROJ_B)     # same org·접근불가 project
            a_orglvl = await _mk_asset(s, ORG, None)      # org-level
            a_xorg = await _mk_asset(s, ORG2, PROJ_OTHER) # 타 org
            auth = _auth()

            # AC1: project access → 200 + BE derive 좌표
            res = await authorize_attachment(path=None, conversation_id=None, story_id=None,
                                             asset_id=a_ok, db=s, auth=auth, org_id=ORG)
            assert res["authorized"] is True
            assert res["container"] == BUCKET and res["object_path"] == f"x/{a_ok}.png"

            # AC1: org-level → org 멤버 통과
            res2 = await authorize_attachment(path=None, conversation_id=None, story_id=None,
                                              asset_id=a_orglvl, db=s, auth=auth, org_id=ORG)
            assert res2["authorized"] is True

            # 접근불가 project → 403
            with pytest.raises(HTTPException) as e1:
                await authorize_attachment(path=None, conversation_id=None, story_id=None,
                                           asset_id=a_noacc, db=s, auth=auth, org_id=ORG)
            assert e1.value.status_code == 403

            # AC4: cross-org asset → 404(org 필터 0행)
            with pytest.raises(HTTPException) as e2:
                await authorize_attachment(path=None, conversation_id=None, story_id=None,
                                           asset_id=a_xorg, db=s, auth=auth, org_id=ORG)
            assert e2.value.status_code == 404

            # XOR: 2개 동시 → 400
            with pytest.raises(HTTPException) as e3:
                await authorize_attachment(path="x", conversation_id=uuid.uuid4(), story_id=None,
                                           asset_id=a_ok, db=s, auth=auth, org_id=ORG)
            assert e3.value.status_code == 400
    finally:
        await engine.dispose()
