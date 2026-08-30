"""story #3249 — POST /api/v2/assets/upload-url + /upload-confirm(BE, #3242 업로드 축 선행분).

avatar/canvas 와 동형(SSOT signed_write_url·자체 서명 0). manual 은 asset_registry.
path_in_source_scope 가 경로 제약을 안 걸어서(«manual 만 경로 제약 없음») 서버-구성
object_path 자체가 유일한 IDOR 방벽 — 그 경계 실증이 이 파일의 핵심.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("a3000000-0000-0000-0000-000000000001")
USER = uuid.UUID("a3000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("a3000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("a3000000-0000-0000-0000-0000000000c1")
PROJ_B = uuid.UUID("a3000000-0000-0000-0000-0000000000c2")
BUCKET = "sprintable-memo-attachments"


@pytest.fixture
def anyio_backend():
    return "asyncio"


_HEAD_SIZES: dict[str, int | None] = {}
_SIGNED_URL_CALLS: list[tuple[str, str, bool]] = []


@pytest.fixture(autouse=True)
def _mock_storage(monkeypatch):
    from unittest.mock import AsyncMock, MagicMock

    import app.services.storage as _storage_mod

    _HEAD_SIZES.clear()
    _SIGNED_URL_CALLS.clear()

    async def _head(container, object_path):
        return _HEAD_SIZES.get(object_path, None)

    async def _signed_write(container, object_path, *, ttl, content_type, create_only=False):
        _SIGNED_URL_CALLS.append((container, object_path, create_only))
        return f"https://signed.example/{object_path}"

    prov = MagicMock()
    prov.head_object = AsyncMock(side_effect=_head)
    prov.signed_write_url = AsyncMock(side_effect=_signed_write)
    monkeypatch.setattr(_storage_mod, "get_storage_provider", lambda: prov)
    yield


async def _reset_and_seed(session):
    for sql in [
        f"DELETE FROM asset_links WHERE org_id='{ORG}'",
        f"DELETE FROM assets WHERE org_id='{ORG}'",
        f"DELETE FROM offering_versions WHERE tier='free' AND created_by='test-3249'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A3','a3org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{USER}','u@a3.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        # USER 는 PROJ_A 에만 grant(PROJ_B 접근 없음 — IDOR 테스트축, test_asset_registry_realdb.py 동형).
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await session.execute(text(sql))
    await session.commit()


def _mock_org_storage_limits(monkeypatch, *, storage_mb: int, max_file_mb: int = 5000):
    """실 offering_versions 조회(_get_org_storage_limits)를 직접 monkeypatch — CI의 real DB엔
    이미 마이그가 심은 tier='free' 행이 존재해서(로컬 create_all DB엔 없어 #3241 라운드서 직접
    INSERT로 seed했던 것과 달리) 테스트가 새 행을 추가로 INSERT하면 `ORDER BY currency ASC
    LIMIT 1`이 어느 행을 집을지 비결정적이 된다(실 seed 값이 이겨 캡이 발동 안 하는 실패 재현,
    CI에서 실측). 조회 자체를 대체해 seed 데이터 유무와 완전히 무관하게 만든다."""
    import ee.plan_limits as _plan_limits

    async def _fake(session, tier):
        return (storage_mb, max_file_mb) if tier == "free" else None

    monkeypatch.setattr(_plan_limits, "_get_org_storage_limits", _fake)


@pytest.mark.anyio
async def test_upload_url_scoped_and_object_path_shape():
    """접근권 있는 project 는 200+server-구성 prefix, 접근권 없는 project 는 404(URL 미발급, 존재 비노출)."""
    from app.routers.assets import create_asset_upload_url, AssetUploadUrlRequest

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            auth = _auth()

            r = await create_asset_upload_url(
                AssetUploadUrlRequest(filename="a.png", content_type="image/png", project_id=PROJ_A),
                db=s, auth=auth, org_id=ORG,
            )
            assert r.object_path.startswith(f"org/{ORG}/project/{PROJ_A}/manual/")
            assert r.object_path.endswith("-a.png")
            assert r.upload_url.startswith("https://signed.example/")
            assert _SIGNED_URL_CALLS[-1][1] == r.object_path
            # story #3249 카디르/codex HIGH 후속 — create-only 서명 실제 요청+계약 노출 둘 다 확인.
            assert _SIGNED_URL_CALLS[-1][2] is True
            assert r.required_put_headers == {"x-goog-if-generation-match": "0"}

            from fastapi import HTTPException
            with pytest.raises(HTTPException) as ei:
                await create_asset_upload_url(
                    AssetUploadUrlRequest(filename="b.png", content_type="image/png", project_id=PROJ_B),
                    db=s, auth=auth, org_id=ORG,
                )
            assert ei.value.status_code == 404  # story #2322/#2342: project 접근 거부=404(존재 비노출).
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_url_org_level_no_project():
    from app.routers.assets import create_asset_upload_url, AssetUploadUrlRequest

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            r = await create_asset_upload_url(
                AssetUploadUrlRequest(filename="c.png", content_type="image/png", project_id=None),
                db=s, auth=_auth(), org_id=ORG,
            )
            assert r.object_path.startswith(f"org/{ORG}/manual/")
            assert "/project/" not in r.object_path
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_confirm_round_trip_creates_asset_and_storage_reflects():
    """정상 발급→confirm 왕복(AC4 핀①) — Asset row 등록 + storage_usage 즉시 반영(AC2)."""
    from app.routers.assets import (
        AssetUploadConfirmRequest, AssetUploadUrlRequest, confirm_asset_upload,
        create_asset_upload_url, storage_usage,
    )

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            auth = _auth()

            issued = await create_asset_upload_url(
                AssetUploadUrlRequest(filename="doc.pdf", content_type="application/pdf", project_id=PROJ_A),
                db=s, auth=auth, org_id=ORG,
            )
            _HEAD_SIZES[issued.object_path] = 2048  # 실 업로드 완료 시뮬레이션(head_object authoritative).

            before = await storage_usage(db=s, auth=auth, org_id=ORG)

            resp = await confirm_asset_upload(
                AssetUploadConfirmRequest(
                    object_path=issued.object_path, filename="doc.pdf",
                    content_type="application/pdf", project_id=PROJ_A,
                ),
                db=s, auth=auth, org_id=ORG,
            )
            assert resp.size_bytes == 2048
            assert resp.name == "doc.pdf"
            assert resp.project_id == PROJ_A

            row = (await s.execute(
                text("SELECT size_bytes, deleted_at FROM assets WHERE id=:id"), {"id": resp.id}
            )).one()
            assert row.size_bytes == 2048 and row.deleted_at is None

            after = await storage_usage(db=s, auth=auth, org_id=ORG)
            assert after.used_bytes == before.used_bytes + 2048
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_confirm_rejects_tampered_object_path_no_asset_created():
    """AC4 핀② — upload-url 이 발급 안 한(server-구성 prefix 밖) object_path 로 confirm 시도는
    거부되고, 실제로 Asset row 가 안 생긴다(양성대조: 거부가 진짜 no-op임을 DB 로 증명)."""
    from fastapi import HTTPException
    from app.routers.assets import AssetUploadConfirmRequest, confirm_asset_upload, storage_usage

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            auth = _auth()
            forged = f"org/{ORG}/project/{PROJ_A}/manual/../../../etc/passwd"
            _HEAD_SIZES[forged] = 999  # 객체가 실재해도(head_object 성공) prefix 불일치면 거부돼야 함.

            before = await storage_usage(db=s, auth=auth, org_id=ORG)
            with pytest.raises(HTTPException) as ei:
                await confirm_asset_upload(
                    AssetUploadConfirmRequest(
                        object_path=forged, filename="x", project_id=PROJ_A,
                    ),
                    db=s, auth=auth, org_id=ORG,
                )
            assert ei.value.status_code == 403
            after = await storage_usage(db=s, auth=auth, org_id=ORG)
            assert after.used_bytes == before.used_bytes  # 부작용 0.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_confirm_object_not_found_leaves_no_orphan_asset():
    """AC4 핀④ — confirm 안 된(putObject 미완료) 발급은 Asset 미등록으로 남는다(고아 객체
    자체 정리는 #2869 별건 — 여기선 '미등록'만 확認)."""
    from fastapi import HTTPException
    from app.routers.assets import AssetUploadConfirmRequest, confirm_asset_upload

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            never_uploaded = f"org/{ORG}/project/{PROJ_A}/manual/{uuid.uuid4()}-ghost.png"
            # _HEAD_SIZES 에 없음 → head_object None(업로드 미완료 시뮬레이션).
            with pytest.raises(HTTPException) as ei:
                await confirm_asset_upload(
                    AssetUploadConfirmRequest(
                        object_path=never_uploaded, filename="ghost.png", project_id=PROJ_A,
                    ),
                    db=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 404
            cnt = (await s.execute(
                text("SELECT COUNT(*) FROM assets WHERE object_path=:p"), {"p": never_uploaded}
            )).scalar_one()
            assert cnt == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_url_rejected_when_org_already_over_cap(monkeypatch):
    """AC3 «발급 선검사» — 이미 총량 캡을 넘긴 org 는 서명URL 자체를 못 받는다(헛발급 방지)."""
    from app.core.config import settings
    from fastapi import HTTPException
    from app.routers.assets import AssetUploadUrlRequest, create_asset_upload_url

    monkeypatch.setattr(settings, "license_consent", "agreed")
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            _mock_org_storage_limits(monkeypatch, storage_mb=1)  # 1MB 총량 캡 — 아래로 이미 초과.
            await s.execute(text(
                "INSERT INTO assets (id,org_id,project_id,container,object_path,name,size_bytes)"
                " VALUES (gen_random_uuid(),:o,:p,:c,'cap/existing','e',:sz)"
            ), {"o": ORG, "p": PROJ_A, "c": BUCKET, "sz": 2 * 1024 * 1024})  # 2MB > 1MB 캡.
            await s.commit()

            with pytest.raises(HTTPException) as ei:
                await create_asset_upload_url(
                    AssetUploadUrlRequest(filename="d.png", content_type="image/png", project_id=PROJ_A),
                    db=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 402
            assert _SIGNED_URL_CALLS == []  # 헛발급 0 — signed_write_url 자체가 안 불림.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_confirm_rejects_when_real_size_exceeds_cap(monkeypatch):
    """AC3 «confirm 재검사» — 발급 시점엔 캡 안이었어도(0바이트 기준) 실 업로드 크기가 파일당
    상한을 넘으면 confirm 이 거부하고 Asset 은 안 생긴다(check_storage_capacity 재사용)."""
    from app.core.config import settings
    from fastapi import HTTPException
    from app.routers.assets import AssetUploadConfirmRequest, confirm_asset_upload

    monkeypatch.setattr(settings, "license_consent", "agreed")
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _reset_and_seed(s)
            _mock_org_storage_limits(monkeypatch, storage_mb=1000, max_file_mb=1)  # 파일당 1MB 상한.
            obj = f"org/{ORG}/project/{PROJ_A}/manual/{uuid.uuid4()}-huge.bin"
            _HEAD_SIZES[obj] = 5 * 1024 * 1024  # 5MB > 1MB 파일 상한.

            with pytest.raises(HTTPException) as ei:
                await confirm_asset_upload(
                    AssetUploadConfirmRequest(object_path=obj, filename="huge.bin", project_id=PROJ_A),
                    db=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 402
            cnt = (await s.execute(
                text("SELECT COUNT(*) FROM assets WHERE object_path=:p"), {"p": obj}
            )).scalar_one()
            assert cnt == 0  # 거부 = Asset 미등록(부작용 0).
    finally:
        await engine.dispose()


def _auth():
    from unittest.mock import MagicMock

    auth = MagicMock()
    auth.user_id = str(USER)
    return auth
