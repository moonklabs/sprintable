"""E-LOOP-LEDGER P1-S6: context-pack search cross-project IDOR — realdb(선생님 결정#6).

get_project_scoped_org_id는 project의 org 소속만 확인하고 caller의 project 멤버십 자체는
검증하지 않는다(app/dependencies/auth.py) — search_context_pack이 has_project_access를
별도로 명시 호출하지 않으면 同org 비멤버가 타 project의 임베딩 검색 결과를 열람 가능(수평 IDOR).
본 테스트는 라우터 함수를 직접 호출해(docs.py의 test_doc_mutation_project_scope_idor_realdb.py와
동형) cross-project=403·same-project=통과(embed_text는 결정론적 결과를 위해 patch)를 검증한다.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d9000000-0000-0000-0000-000000000001")
USER = uuid.UUID("d9000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("d9000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("d9000000-0000-0000-0000-0000000000c1")  # USER grant(접근 O)
PROJ_B = uuid.UUID("d9000000-0000-0000-0000-0000000000c2")  # USER 접근 X(IDOR 축)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    for sql in [
        f"DELETE FROM embeddings WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D9','d9org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@d9.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        # USER는 PROJ_A에만 grant(PROJ_B 접근 없음 — IDOR 테스트축).
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_cross_project_forbidden_same_project_ok():
    from app.routers.context_pack import search_context_pack
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        # cross-project(PROJ_B·USER 무접근) → 403
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await search_context_pack(
                    project_id=PROJ_B, query="검색어", limit=10, session=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403
            assert ei.value.detail["code"] == "PROJECT_ACCESS_DENIED"

        # same-project(PROJ_A·USER grant) → 통과(embed_text patch로 결정론적 결과).
        async with Session() as s:
            with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
                out = await search_context_pack(
                    project_id=PROJ_A, query="검색어", limit=10, session=s, auth=_auth(), org_id=ORG,
                )
            assert out == []  # 시드된 embedding 없음 — 403이 아니라 정상 빈 결과라는 점이 핵심.
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_embed_unavailable_returns_503_not_leaked_as_empty_result():
    """embed_text가 None(인증불가)이면 조용히 빈 결과가 아니라 503으로 드러나야(사용자 대기 요청)."""
    from app.routers.context_pack import search_context_pack
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with patch("app.services.embedding_client.embed_text", return_value=None):
                with pytest.raises(HTTPException) as ei:
                    await search_context_pack(
                        project_id=PROJ_A, query="검색어", limit=10, session=s, auth=_auth(), org_id=ORG,
                    )
                assert ei.value.status_code == 503
                assert ei.value.detail["code"] == "EMBED_UNAVAILABLE"
    finally:
        await eng.dispose()
