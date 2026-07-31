"""story #2168 PR-①: 임베드 링크가 doc 자신의 project 를 실어 나르게 하는 처방의 BE 절반.

DocPreviewResponse 에 project_id/org_slug/project_slug 를 additive 로 추가(FE embed-card.tsx
가 "현재 프로젝트"를 더는 추측하지 않고 이 필드로 doc 이 실제로 속한 project 로 직행하기 위함).
그리고 get_doc/get_doc_preview 의 org-scope happy path 가 project 인가 없이 즉시 반환하던 갭
(patch/delete 는 f69fcd91 로 이미 고쳐졌으나 GET 은 방치돼 있었음)을 canonical 가드로 통일한다.

realdb 필수 — has_project_access SSOT(team_member∪grant∪owner/admin) 실측 + Project/Organization
slug 컬럼 실조회.
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

ORG = uuid.UUID("d2168000-0000-0000-0000-000000000001")
USER = uuid.UUID("d2168000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("d2168000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("d2168000-0000-0000-0000-0000000000c1")  # USER grant(접근 O)
PROJ_B = uuid.UUID("d2168000-0000-0000-0000-0000000000c2")  # USER 접근 X(cross-project 축)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    """ORG(slug='d2168-org')·PROJ_A(slug='proj-a', grant O)·PROJ_B(slug='proj-b', grant X) + 양쪽 doc."""
    from app.models.doc import Doc
    for sql in [
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','D2168','d2168-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@d2168.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name,slug) VALUES ('{PROJ_A}','{ORG}','A','proj-a')",
        f"INSERT INTO projects (id,org_id,name,slug) VALUES ('{PROJ_B}','{ORG}','B','proj-b')",
        # USER 는 PROJ_A 에만 grant(PROJ_B 접근 없음 — cross-project 테스트축).
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await s.execute(text(sql))
    docs = {}
    for key, pid in [("a", PROJ_A), ("b", PROJ_B)]:
        d = Doc(id=uuid.uuid4(), org_id=ORG, project_id=pid, title=f"doc-{key}",
                slug=f"s-{key}-{uuid.uuid4().hex[:8]}", content="")
        s.add(d)
        docs[key] = d
    await s.commit()
    return docs


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_preview_same_project_returns_project_id_and_slugs():
    from app.repositories.doc import DocRepository
    from app.routers.docs import get_doc_preview
    eng, Session = await _engine()
    try:
        async with Session() as s:
            docs = await _seed(s)
            doc_a = docs["a"]
        async with Session() as s:
            resp = await get_doc_preview(
                q=str(doc_a.id), db=s, auth=_auth(), repo=DocRepository(s, ORG)
            )
        assert resp.project_id == PROJ_A
        assert resp.org_slug == "d2168-org"
        assert resp.project_slug == "proj-a"
        assert resp.slug == doc_a.slug
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_preview_cross_project_forbidden():
    """#2168 조사 로그의 실제 결함: 링크가 project 없이 도착하면 receiver가 "현재 프로젝트"로
    추측했다 — 그 갭을 막는 canonical 인가가 preview 에도 걸려야 한다(get_doc 과 동형 가드).
    story #2342(2026-07-30): 무권한을 403이 아닌 404로 통일."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import get_doc_preview
    eng, Session = await _engine()
    try:
        async with Session() as s:
            docs = await _seed(s)
            doc_b = docs["b"]
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_doc_preview(
                    q=str(doc_b.id), db=s, auth=_auth(), repo=DocRepository(s, ORG)
                )
            assert ei.value.status_code == 404
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_get_doc_cross_project_forbidden_same_project_ok():
    """get_doc(GET /{id}) org-scope happy path 가 project 인가 없이 즉시 반환하던 갭 — fix 검증.
    fix 前(has_project_access 가드 제거)엔 이 테스트가 RED(200 반환)로 exploitability 실증.
    story #2342(2026-07-30): 무권한을 403이 아닌 404로 통일."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import get_doc
    eng, Session = await _engine()
    try:
        async with Session() as s:
            docs = await _seed(s)
            doc_a, doc_b = docs["a"], docs["b"]
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_doc(id=doc_b.id, session=s, auth=_auth(), repo=DocRepository(s, ORG))
            assert ei.value.status_code == 404
        async with Session() as s:
            out = await get_doc(id=doc_a.id, session=s, auth=_auth(), repo=DocRepository(s, ORG))
            assert out.id == doc_a.id
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_preview_legacy_project_without_slug_returns_none_not_error():
    """Project.slug 는 nullable(옛 미백필) — preview 가 project_slug=None 을 내려주면 FE 가
    bare 링크로 우아하게 폴백한다(회귀 아님). preview 가 여기서 예외를 던지지 않는지 고정."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import get_doc_preview
    eng, Session = await _engine()
    try:
        async with Session() as s:
            docs = await _seed(s)
            doc_a = docs["a"]
            await s.execute(text(f"UPDATE projects SET slug=NULL WHERE id='{PROJ_A}'"))
            await s.commit()
        async with Session() as s:
            resp = await get_doc_preview(
                q=str(doc_a.id), db=s, auth=_auth(), repo=DocRepository(s, ORG)
            )
        assert resp.project_slug is None
        assert resp.project_id == PROJ_A
    finally:
        await eng.dispose()
