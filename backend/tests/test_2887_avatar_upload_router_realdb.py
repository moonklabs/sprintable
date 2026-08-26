"""story #2887(BE) — avatar 업로드 라우터 통합(권한 게이트 재사용이 실제로 작동하는지·
Member.avatar_url이 정말 갱신되는지). 새 권한 개념을 만들지 않고 기존 assert_agent_owner/
_assert_can_manage_human을 그대로 재사용한다는 AC 확定(페드루, 2026-08-21)의 하중 증명 —
휴먼 self/stranger/admin 3분기 + 에이전트 owner/non-owner 2분기.

STORAGE_PROVIDER=local(zero-config, 실 로컬 디스크)로 GCS 없이 confirm의 head_object 실물
검증까지 end-to-end로 태운다."""
from __future__ import annotations

import os
import shutil
import tempfile
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

ORG = uuid.UUID("28870000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("28870000-0000-0000-0000-000000000002")
USER_A = uuid.UUID("28870000-0000-0000-0000-0000000000a1")   # self — 자기 아바타 편집
USER_B = uuid.UUID("28870000-0000-0000-0000-0000000000b1")   # stranger — 타인 편집 시도
USER_ADMIN = uuid.UUID("28870000-0000-0000-0000-0000000000ad")
MEMBER_A = uuid.UUID("28870000-0000-0000-0000-0000000001a1")  # == org_members.id(휴먼 앵커)
MEMBER_B = uuid.UUID("28870000-0000-0000-0000-0000000001b1")
MEMBER_ADMIN = uuid.UUID("28870000-0000-0000-0000-0000000001ad")
AGENT_MEMBER = uuid.UUID("28870000-0000-0000-0000-000000002a91")  # owner=USER_A


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _local_storage(monkeypatch):
    tmp_root = tempfile.mkdtemp(prefix="avatar-router-test-")
    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", tmp_root)
    monkeypatch.setenv("GCS_AVATARS_BUCKET", "test-avatars-router-bucket")
    import importlib
    import app.services.avatar_upload as avatar_upload_mod
    importlib.reload(avatar_upload_mod)
    yield
    shutil.rmtree(tmp_root, ignore_errors=True)
    importlib.reload(avatar_upload_mod)


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


def _auth(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG))


async def _seed(s) -> None:
    for sql in [
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id IN ('{USER_A}','{USER_B}','{USER_ADMIN}')",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S2887','s2887-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER_A}','a@s2887.test','x','A',true,true,0,false,0),"
        f"('{USER_B}','b@s2887.test','x','B',true,true,0,false,0),"
        f"('{USER_ADMIN}','admin@s2887.test','x','Admin',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
        f"('{MEMBER_A}','{ORG}','{USER_A}','member'),"
        f"('{MEMBER_B}','{ORG}','{USER_B}','member'),"
        f"('{MEMBER_ADMIN}','{ORG}','{USER_ADMIN}','admin')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','s2887-proj','warn')",
        f"INSERT INTO members (id,org_id,type,user_id,name) VALUES "
        f"('{MEMBER_A}','{ORG}','human','{USER_A}','A'),"
        f"('{MEMBER_B}','{ORG}','human','{USER_B}','B'),"
        f"('{MEMBER_ADMIN}','{ORG}','human','{USER_ADMIN}','Admin')",
        f"INSERT INTO project_access (id,project_id,member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{MEMBER_A}','granted','member'),"
        f"(gen_random_uuid(),'{PROJ}','{MEMBER_B}','granted','member'),"
        f"(gen_random_uuid(),'{PROJ}','{MEMBER_ADMIN}','granted','admin')",
        # 에이전트 — owner_member_id=MEMBER_A → team_members뷰 created_by=USER_A(0110 뷰 정의).
        f"INSERT INTO members (id,org_id,type,owner_member_id,name) VALUES "
        f"('{AGENT_MEMBER}','{ORG}','agent','{MEMBER_A}','Agent')",
        f"INSERT INTO project_access (id,project_id,member_id,permission,role) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{AGENT_MEMBER}','granted','member')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _put_and_confirm(session, org_id, caller_member_id, target_id, auth, object_path=None):
    """caller_member_id는 미사용(과거 시그니처 잔재 방지용 이름) — object_path는 항상
    target_id(아바타가 바뀌는 대상) 스코프여야 한다(confirm_upload의 실제 검증축과 정합)."""
    from app.services.avatar_upload import get_storage_provider, AVATARS_BUCKET
    from app.routers.team_members import confirm_avatar_upload, AvatarConfirmRequest

    if object_path is None:
        object_path = f"avatar/{org_id}/{target_id}/{uuid.uuid4().hex}.png"
    provider = get_storage_provider()
    await provider.put_object(AVATARS_BUCKET, object_path, b"fake-png-bytes", content_type="image/png")
    return await confirm_avatar_upload(
        target_id, AvatarConfirmRequest(object_path=object_path),
        session=session, auth=auth, org_id=org_id,
    )


@pytest.mark.asyncio
async def test_self_can_confirm_own_avatar():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            resp = await _put_and_confirm(s, ORG, MEMBER_A, MEMBER_A, _auth(USER_A))
            assert resp.avatar_url is not None
    finally:
        await eng.dispose()


@pytest.mark.asyncio
async def test_stranger_cannot_confirm_others_avatar():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await _put_and_confirm(s, ORG, MEMBER_B, MEMBER_A, _auth(USER_B))
            assert exc_info.value.status_code == 403
    finally:
        await eng.dispose()


@pytest.mark.asyncio
async def test_org_admin_can_confirm_others_avatar():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            resp = await _put_and_confirm(s, ORG, MEMBER_ADMIN, MEMBER_A, _auth(USER_ADMIN))
            assert resp.avatar_url is not None
    finally:
        await eng.dispose()


@pytest.mark.asyncio
async def test_agent_owner_can_confirm_agent_avatar():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            resp = await _put_and_confirm(s, ORG, MEMBER_A, AGENT_MEMBER, _auth(USER_A))
            assert resp.avatar_url is not None
    finally:
        await eng.dispose()


@pytest.mark.asyncio
async def test_non_owner_non_admin_cannot_confirm_agent_avatar():
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await _put_and_confirm(s, ORG, MEMBER_B, AGENT_MEMBER, _auth(USER_B))
            assert exc_info.value.status_code == 403
    finally:
        await eng.dispose()


@pytest.mark.asyncio
async def test_confirm_persists_avatar_url_to_member_anchor():
    """라우터가 apply_anchor_update를 실제로 호출해 members.avatar_url이 커밋되는지 —
    응답 객체 값만이 아니라 별도 세션 재조회로 확인(모델-only 뮤테이션 셀프체크)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            resp = await _put_and_confirm(s, ORG, MEMBER_A, MEMBER_A, _auth(USER_A))
            await s.commit()
            expected_url = resp.avatar_url

        async with Session() as s:
            persisted = (await s.execute(
                text(f"SELECT avatar_url FROM members WHERE id='{MEMBER_A}'")
            )).scalar_one()
            assert persisted == expected_url
    finally:
        await eng.dispose()
