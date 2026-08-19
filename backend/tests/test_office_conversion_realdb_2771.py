"""office_conversion + /attachments/{asset_id}/convert real-DB 통합 (#2771 §7).

커버: 원본 pptx→pdf 변환(mock Gotenberg/storage)·2회째 캐시 hit(변환 재호출 0회)·
비-office 자산 422·**교차 테넌트 음성대조**(PO 판정 2026-08-19 ① — 타 org 토큰으로 변환물
asset_id sign/authorize 시도 시 org 필터로 404, 변환물도 원본과 동일한 org_id로 생성되므로
`/authorize` asset_id 분기 하나가 원본·변환물 둘 다 커버함을 실증).

DB env 없으면 skip(CI alembic-fresh 잡서 실행) — test_asset_registry_realdb.py/
test_attachment_authorize_asset_s3.py와 동일 관례.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("a4000000-0000-0000-0000-000000000001")
ORG2 = uuid.UUID("a4000000-0000-0000-0000-000000000002")
USER = uuid.UUID("a4000000-0000-0000-0000-0000000000a1")
USER2 = uuid.UUID("a4000000-0000-0000-0000-0000000000a2")
OM = uuid.UUID("a4000000-0000-0000-0000-0000000000b1")
OM2 = uuid.UUID("a4000000-0000-0000-0000-0000000000b2")
PROJ = uuid.UUID("a4000000-0000-0000-0000-0000000000c1")
PROJ_OTHER = uuid.UUID("a4000000-0000-0000-0000-0000000000d1")  # ORG2 소속
BUCKET = "sprintable-memo-attachments"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s):
    for sql in [
        f"DELETE FROM assets WHERE org_id IN ('{ORG}','{ORG2}')",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM org_members WHERE org_id IN ('{ORG}','{ORG2}')",
        f"DELETE FROM projects WHERE org_id IN ('{ORG}','{ORG2}')",
        f"DELETE FROM users WHERE id IN ('{USER}','{USER2}')",
        f"DELETE FROM organizations WHERE id IN ('{ORG}','{ORG2}')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A4','a4','free')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG2}','A4b','a4b','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@a4.test','x','U',true,true,0,false,0)",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER2}','u2@a4b.test','x','U2',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM2}','{ORG2}','{USER2}','member')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','warn')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ_OTHER}','{ORG2}','OtherP','warn')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ}','{OM}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _mk_pptx_asset(s) -> uuid.UUID:
    aid = uuid.uuid4()
    await s.execute(
        text(
            "INSERT INTO assets (id,org_id,project_id,container,object_path,name,content_type,size_bytes) "
            "VALUES (:id,:org,:proj,:bucket,:path,'deck.pptx',"
            "'application/vnd.openxmlformats-officedocument.presentationml.presentation',1000)"
        ),
        {"id": str(aid), "org": str(ORG), "proj": str(PROJ), "bucket": BUCKET, "path": f"chat/{PROJ}/x/{aid}.pptx"},
    )
    await s.commit()
    return aid


def _auth(user):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user), email="u@a4.test", claims={}, org_id=str(ORG))


@pytest.fixture(autouse=True)
def _mock_storage_and_gotenberg(monkeypatch):
    import app.services.storage as _storage_mod
    from app.services import office_conversion

    store: dict[str, bytes] = {}

    async def _download(container, object_path):
        return store.get(object_path, b"fake-pptx-bytes")

    async def _put(container, object_path, data, *, content_type=None):
        store[object_path] = data
        return True

    prov = MagicMock()
    prov.download_object = AsyncMock(side_effect=_download)
    prov.put_object = AsyncMock(side_effect=_put)
    monkeypatch.setattr(_storage_mod, "get_storage_provider", lambda: prov)

    calls = {"n": 0}

    async def _fake_gotenberg(filename, data):
        calls["n"] += 1
        return b"%PDF-1.4 fake converted bytes"

    monkeypatch.setattr(office_conversion, "_call_gotenberg", _fake_gotenberg)
    monkeypatch.setattr(office_conversion, "_GOTENBERG_URL", "https://office-converter.example.internal")
    yield calls


@pytest.mark.anyio
async def test_convert_then_cache_hit_then_cross_org_authorize_denied(_mock_storage_and_gotenberg):
    from app.routers.attachments import authorize_attachment, convert_attachment

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            source_id = await _mk_pptx_asset(s)
            auth = _auth(USER)

            # 최초 변환 — Gotenberg 1회 호출.
            res1 = await convert_attachment(asset_id=source_id, db=s, auth=auth, org_id=ORG)
            assert res1["content_type"] == "application/pdf"
            converted_id = uuid.UUID(res1["asset_id"])
            assert converted_id != source_id
            assert _mock_storage_and_gotenberg["n"] == 1

            # 2회째 — 캐시 hit, Gotenberg 재호출 없음, 같은 asset_id.
            res2 = await convert_attachment(asset_id=source_id, db=s, auth=auth, org_id=ORG)
            assert uuid.UUID(res2["asset_id"]) == converted_id
            assert _mock_storage_and_gotenberg["n"] == 1

            # 변환물도 원본과 같은 org_id로 생성됨 — 원본 org 사용자는 authorize 통과(orphan asset, link 0건).
            authz_ok = await authorize_attachment(
                path=None, conversation_id=None, story_id=None,
                asset_id=converted_id, db=s, auth=auth, org_id=ORG,
            )
            assert authz_ok["authorized"] is True

            # PO AC①: 교차 테넌트 음성대조 — ORG2 토큰으로 변환물 authorize 시도 → org 필터 0행 → 404.
            with pytest.raises(HTTPException) as exc:
                await authorize_attachment(
                    path=None, conversation_id=None, story_id=None,
                    asset_id=converted_id, db=s, auth=_auth(USER2), org_id=ORG2,
                )
            assert exc.value.status_code == 404
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_convert_rejects_non_office_asset():
    from app.routers.attachments import convert_attachment

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            aid = uuid.uuid4()
            await s.execute(
                text(
                    "INSERT INTO assets (id,org_id,project_id,container,object_path,name,content_type,size_bytes) "
                    "VALUES (:id,:org,:proj,:bucket,:path,'photo.png','image/png',10)"
                ),
                {"id": str(aid), "org": str(ORG), "proj": str(PROJ), "bucket": BUCKET, "path": f"chat/{PROJ}/x/{aid}.png"},
            )
            await s.commit()

            with pytest.raises(HTTPException) as exc:
                await convert_attachment(asset_id=aid, db=s, auth=_auth(USER), org_id=ORG)
            assert exc.value.status_code == 422
    finally:
        await engine.dispose()
