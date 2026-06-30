"""f69fcd91: doc mutation(delete/cancel/update) cross-project IDOR — realdb repro + lock.

갭(codex #1792 QA 적출·PO confirm): delete_doc/transition_doc_endpoint/update_doc 가 대상 doc 을 **id+org**
로만 잡아 mutate(get_project_scoped_org_id 의 project_id 는 caller query param·생략 시 org-only) → 同org
**비-owner/admin·대상 doc project grant 없는** 멤버가 타 project doc 을 삭제/취소/수정 가능(수평 IDOR).

fix = 3경로 다 대상 doc 의 `has_project_access(doc.project_id)` 강제. 본 테스트는 **fix 후 거동**(cross-project
=403·same-project=통과)을 assert — fix 前엔 RED(mutation 성공/authz 부재)로 exploitability 실증, fix 後 GREEN.
realdb 필수(has_project_access SSOT=team_member∪grant∪owner/admin·grant row 실측).
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

ORG = uuid.UUID("c9000000-0000-0000-0000-000000000001")
USER = uuid.UUID("c9000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("c9000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("c9000000-0000-0000-0000-0000000000c1")  # USER grant(접근 O)
PROJ_B = uuid.UUID("c9000000-0000-0000-0000-0000000000c2")  # USER 접근 X(IDOR 축)
AGENT = uuid.UUID("c9000000-0000-0000-0000-0000000000e1")  # agent member·grant 0(agent IDOR 축)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


def _agent_auth():
    # 에이전트 키: auth.user_id=str(members.id)(_resolve_api_key). grant 없으면 has_project_access
    # agent 분기서 차단돼야(cross-project mutate 불가).
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(AGENT), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    """ORG·USER(member·非owner/admin)·PROJ_A(grant)·PROJ_B(no grant) 시드 + 양 project 에 doc."""
    from app.models.doc import Doc
    for sql in [
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C9','c9org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@c9.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        # agent member(grant 0 — agent cross-project IDOR 축).
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{AGENT}','{ORG}','agent','Ag',true)",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        # USER 는 PROJ_A 에만 grant(PROJ_B 접근 없음 — IDOR 테스트축).
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await s.execute(text(sql))
    docs = {}
    for key, pid, status in [
        ("b_del", PROJ_B, "draft"), ("b_cancel", PROJ_B, "pending"), ("b_upd", PROJ_B, "draft"),
        ("a_del", PROJ_A, "draft"), ("a_cancel", PROJ_A, "pending"), ("a_upd", PROJ_A, "draft"),
        ("b_share", PROJ_B, "draft"), ("a_share", PROJ_A, "draft"),
        ("b_comment", PROJ_B, "draft"), ("a_comment", PROJ_A, "draft"),
        ("b_agent", PROJ_B, "draft"),
    ]:
        d = Doc(id=uuid.uuid4(), org_id=ORG, project_id=pid, title="t",
                slug=f"s-{uuid.uuid4().hex[:10]}", status=status, content="")
        s.add(d)
        docs[key] = d.id
    await s.commit()
    return docs


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ───────────────────────── delete ─────────────────────────

@pytest.mark.anyio
async def test_delete_cross_project_forbidden_same_project_ok():
    from app.repositories.doc import DocRepository
    from app.routers.docs import delete_doc
    eng, Session = await _engine()
    try:
        async with Session() as s:
            docs = await _seed(s)
        # cross-project(PROJ_B·USER 무접근) → 403
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await delete_doc(id=docs["b_del"], repo=DocRepository(s, ORG), auth=_auth())
            assert ei.value.status_code == 403
        # same-project(PROJ_A·USER grant) → 통과
        async with Session() as s:
            out = await delete_doc(id=docs["a_del"], repo=DocRepository(s, ORG), auth=_auth())
            await s.commit()
            assert out == {"ok": True}
    finally:
        await eng.dispose()


# ───────────────────────── cancel(transition pending→draft) ─────────────────────────

@pytest.mark.anyio
async def test_cancel_cross_project_forbidden_same_project_ok():
    from app.routers.docs import DocTransitionRequest, transition_doc_endpoint
    eng, Session = await _engine()
    try:
        docs = None
        async with Session() as s:
            docs = await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await transition_doc_endpoint(
                    id=docs["b_cancel"], body=DocTransitionRequest(status="draft"),
                    session=s, org_id=ORG, auth=_auth(),
                )
            assert ei.value.status_code == 403
        async with Session() as s:
            out = await transition_doc_endpoint(
                id=docs["a_cancel"], body=DocTransitionRequest(status="draft"),
                session=s, org_id=ORG, auth=_auth(),
            )
            assert out.status == "draft"
    finally:
        await eng.dispose()


# ───────────────────────── update(patch) ─────────────────────────

@pytest.mark.anyio
async def test_update_cross_project_forbidden_same_project_ok():
    from app.repositories.doc import DocRepository
    from app.routers.docs import DocUpdate, update_doc
    eng, Session = await _engine()
    try:
        async with Session() as s:
            docs = await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await update_doc(
                    id=docs["b_upd"], body=DocUpdate(title="hacked"),
                    repo=DocRepository(s, ORG), session=s, auth=_auth(),
                )
            assert ei.value.status_code == 403
        async with Session() as s:
            out = await update_doc(
                id=docs["a_upd"], body=DocUpdate(title="ok-edit"),
                repo=DocRepository(s, ORG), session=s, auth=_auth(),
            )
            assert out.title == "ok-edit"
    finally:
        await eng.dispose()


# ───────────────────────── share (enable/regenerate/disable) ─────────────────────────

@pytest.mark.anyio
async def test_share_cross_project_forbidden_same_project_ok():
    from app.repositories.doc import DocRepository
    from app.routers.docs import disable_doc_share, enable_doc_share, regenerate_doc_share
    eng, Session = await _engine()
    try:
        async with Session() as s:
            docs = await _seed(s)
        # cross-project(PROJ_B·USER 무접근) — enable/rotate/revoke 3 op 다 403
        for op in (enable_doc_share, regenerate_doc_share, disable_doc_share):
            async with Session() as s:
                with pytest.raises(HTTPException) as ei:
                    await op(id=docs["b_share"], repo=DocRepository(s, ORG), db=s, auth=_auth())
                assert ei.value.status_code == 403, op.__name__
        # same-project(PROJ_A) — enable 통과
        async with Session() as s:
            out = await enable_doc_share(id=docs["a_share"], repo=DocRepository(s, ORG), db=s, auth=_auth())
            assert out.enabled is True
    finally:
        await eng.dispose()


# ───────────────────────── comment ─────────────────────────

@pytest.mark.anyio
async def test_comment_cross_project_forbidden_same_project_ok():
    from app.repositories.doc import DocRepository
    from app.routers.docs import add_doc_comment
    eng, Session = await _engine()
    try:
        async with Session() as s:
            docs = await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await add_doc_comment(
                    id=docs["b_comment"], content="x", db=s, repo=DocRepository(s, ORG), auth=_auth()
                )
            assert ei.value.status_code == 403
        async with Session() as s:
            out = await add_doc_comment(
                id=docs["a_comment"], content="ok", db=s, repo=DocRepository(s, ORG), auth=_auth()
            )
            assert out.content == "ok"
    finally:
        await eng.dispose()


# ───────────────────────── agent (grant 0 → 차단) ─────────────────────────

@pytest.mark.anyio
async def test_agent_without_grant_cross_project_forbidden():
    """agent 키(grant 0)도 cross-project mutate 차단 — auth.user_id=str(members.id)(유효 UUID·throw 안 함)·
    has_project_access agent 분기(project_access.member_id)가 grant 없으면 False → 403(fail-open 아님)."""
    from app.repositories.doc import DocRepository
    from app.routers.docs import delete_doc
    eng, Session = await _engine()
    try:
        async with Session() as s:
            docs = await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await delete_doc(id=docs["b_agent"], repo=DocRepository(s, ORG), auth=_agent_auth())
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()
