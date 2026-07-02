"""E-LOOP-LEDGER S24(story bf9f6e25·P0-UX·prod-blocking): LoopArtifactResponse.text_content 계약
(doc 8e8725da §3) — content_type 분기 키 + text/* 4KB-cap inline + image 회귀0 + 전문 lazy endpoint.

비-tautological 핵심:
ⓐ text/* asset → content_type + text_content(원문 그대로, cap 이내) + text_truncated=False.
ⓑ 4KB 초과 text → text_content가 정확히 4096바이트로 잘리고 text_truncated=True(진짜 storage
   read+cap 로직 실행 — mock RuntimeError가 아니라 LocalStorageProvider로 실 파일 write/read).
ⓒ image/* asset → text_content=None·text_truncated=False·기존 필드(asset_id 등) 불변(회귀0 실증 —
   S4 기존 테스트의 image asset 시드가 그대로 통과하는 것과 별개로 여기서 명시 검증).
ⓓ storage read 실패(파일 미존재) → 크래시 없이 (None, False)로 graceful degrade(best-effort).
ⓔ GET /assets/{id}/text — text 성공/이미지 400/미존재 404.

DB env(ALEMBIC_DATABASE_URL) 없으면 realdb 파트 skip. STORAGE_PROVIDER는 미설정(local 기본) —
LocalStorageProvider가 STORAGE_LOCAL_ROOT 하위에 실제로 write/read한다(GCS 크레덴셜 불요).
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.routers import loops as r
from app.schemas.loop import LoopArtifactCreate
from app.services.loop import _resolve_artifact_text

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _local_storage_root(tmp_path, monkeypatch):
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / "storage"))
    monkeypatch.delenv("STORAGE_PROVIDER", raising=False)  # 명시적으로 local 강제(dev/prod=gcs 오염 방지)


# ── 유닛: _resolve_artifact_text (DB 불요) ─────────────────────────────────────

class _FakeAsset:
    def __init__(self, id, content_type, container, object_path):
        self.id = id
        self.content_type = content_type
        self.container = container
        self.object_path = object_path


@pytest.mark.anyio
async def test_resolve_artifact_text_none_asset():
    text_content, truncated = await _resolve_artifact_text(None)
    assert text_content is None and truncated is False


@pytest.mark.anyio
async def test_resolve_artifact_text_image_content_type_skips_storage_read():
    """까심 RC(선택·권장) — fake path가 "가드 없어도 우연히 같은 결과"일 수 있어 tautological
    위험([[feedback_test_isolate_bug_variable]]). spy로 download_object 호출 0회를 직접 assert해
    가드가 실제로 storage read 자체를 막는지(에러를 삼킨 게 아니라) 비-tautological하게 증명."""
    from unittest.mock import AsyncMock, patch

    asset = _FakeAsset(uuid.uuid4(), "image/png", "uploads", "some/real/path.png")
    with patch("app.services.storage.get_storage_provider") as mock_provider:
        mock_provider.return_value.download_object = AsyncMock(side_effect=AssertionError("should not be called"))
        text_content, truncated = await _resolve_artifact_text(asset)
    mock_provider.return_value.download_object.assert_not_called()
    assert text_content is None and truncated is False


@pytest.mark.anyio
async def test_resolve_artifact_text_missing_object_graceful_degrade():
    # content_type=text/* 지만 실제 파일이 없음 → FileNotFoundError를 삼키고 (None, False).
    asset = _FakeAsset(uuid.uuid4(), "text/plain", "uploads", "does/not/exist.txt")
    text_content, truncated = await _resolve_artifact_text(asset)
    assert text_content is None and truncated is False


@pytest.mark.anyio
async def test_resolve_artifact_text_short_text_full_no_truncation():
    from app.services.storage import get_storage_provider

    asset = _FakeAsset(uuid.uuid4(), "text/plain", "uploads", f"t-{uuid.uuid4().hex}.txt")
    body = "짧은 카피 문구".encode("utf-8")
    ok = await get_storage_provider().put_object("uploads", asset.object_path, body, content_type="text/plain")
    assert ok
    text_content, truncated = await _resolve_artifact_text(asset)
    assert text_content == body.decode("utf-8")
    assert truncated is False


@pytest.mark.anyio
async def test_resolve_artifact_text_over_4kb_truncated_exactly():
    from app.services.storage import get_storage_provider

    asset = _FakeAsset(uuid.uuid4(), "text/plain", "uploads", f"t-{uuid.uuid4().hex}.txt")
    body = ("a" * 5000).encode("ascii")  # 4096바이트 cap보다 명확히 큼(경계 모호성 없는 ascii)
    await get_storage_provider().put_object("uploads", asset.object_path, body, content_type="text/plain")
    text_content, truncated = await _resolve_artifact_text(asset)
    assert truncated is True
    assert len(text_content.encode("utf-8")) == 4096
    assert text_content == "a" * 4096


# ── realdb: create_loop_artifact / list_loop_artifacts 응답 필드 실증 ─────────────

pytestmark_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("24000000-0000-0000-0000-000000000001")
USER = uuid.UUID("24000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("24000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("24000000-0000-0000-0000-000000000002")


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    for sql in [
        f"DELETE FROM asset_links WHERE org_id='{ORG}'",
        f"DELETE FROM loop_artifacts WHERE org_id='{ORG}'",
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM assets WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ_A}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S24','s24org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@s24.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_loop(s, project_id) -> uuid.UUID:
    from app.repositories.loop import LoopRunRepository
    repo = LoopRunRepository(s, ORG)
    loop = await repo.create(
        project_id=project_id, title="L", goal_tags=[], status="draft",
        created_by_member_id=uuid.uuid4(),
    )
    await s.commit()
    return loop.id


async def _seed_asset(s, project_id, content_type, container="uploads", object_path=None) -> uuid.UUID:
    from app.models.asset import Asset
    a = Asset(
        id=uuid.uuid4(), org_id=ORG, project_id=project_id, container=container,
        object_path=object_path or f"org/{ORG}/asset-{uuid.uuid4().hex[:8]}",
        name="a", content_type=content_type, size_bytes=100,
    )
    s.add(a)
    await s.commit()
    return a.id


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytestmark_db
@pytest.mark.anyio
async def test_create_artifact_text_asset_returns_inline_text_content():
    from app.services.storage import get_storage_provider

    eng, Session = await _engine()
    try:
        object_path = f"org/{ORG}/text-{uuid.uuid4().hex[:8]}.txt"
        await get_storage_provider().put_object(
            "uploads", object_path, "무료로 시작하기".encode("utf-8"), content_type="text/plain"
        )
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_A)
            asset_id = await _seed_asset(s, PROJ_A, "text/plain", object_path=object_path)

        async with Session() as s:
            out = await r.create_loop_artifact(
                loop_id=loop_id,
                body=LoopArtifactCreate(variant_group="cta", variant_label="A", asset_id=asset_id),
                session=s, auth=_auth(), org_id=ORG,
            )
            assert out.content_type == "text/plain"
            assert out.text_content == "무료로 시작하기"
            assert out.text_truncated is False
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_create_artifact_image_asset_text_content_null_zero_regression():
    """⭐image 회귀0: content_type만 새로 채워지고 text_content/text_truncated는 조용히 null/False —
    기존 필드(asset_id/variant_label/decision 등)는 S4 테스트와 동일하게 그대로."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_A)
            asset_id = await _seed_asset(s, PROJ_A, "image/png")

        async with Session() as s:
            out = await r.create_loop_artifact(
                loop_id=loop_id,
                body=LoopArtifactCreate(variant_group="hero", variant_label="A", asset_id=asset_id),
                session=s, auth=_auth(), org_id=ORG,
            )
            assert out.content_type == "image/png"
            assert out.text_content is None
            assert out.text_truncated is False
            assert out.asset_id == asset_id
            assert out.decision == "pending"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_list_loop_artifacts_mixed_text_and_image_batch():
    """N개 variant(텍스트+이미지 혼합) list — 각 아이템이 자기 asset의 content_type/text에 맞게
    독립적으로 채워지는지(batch asset 조회가 asset_id로 올바르게 매핑되는지) 실증."""
    from app.services.storage import get_storage_provider

    eng, Session = await _engine()
    try:
        object_path = f"org/{ORG}/text-{uuid.uuid4().hex[:8]}.txt"
        await get_storage_provider().put_object(
            "uploads", object_path, "지금 업그레이드".encode("utf-8"), content_type="text/plain"
        )
        async with Session() as s:
            await _seed(s)
            loop_id = await _seed_loop(s, PROJ_A)
            text_asset = await _seed_asset(s, PROJ_A, "text/plain", object_path=object_path)
            image_asset = await _seed_asset(s, PROJ_A, "image/png")

        async with Session() as s:
            await r.create_loop_artifact(
                loop_id=loop_id,
                body=LoopArtifactCreate(variant_group="pricing-cta", variant_label="A", asset_id=text_asset),
                session=s, auth=_auth(), org_id=ORG,
            )
            await r.create_loop_artifact(
                loop_id=loop_id,
                body=LoopArtifactCreate(variant_group="pricing-cta", variant_label="B", asset_id=image_asset),
                session=s, auth=_auth(), org_id=ORG,
            )
            await s.commit()

        async with Session() as s:
            groups = await r.list_loop_artifacts(loop_id=loop_id, session=s, auth=_auth(), org_id=ORG)
            assert len(groups) == 1
            by_label = {a.variant_label: a for a in groups[0].artifacts}
            assert by_label["A"].content_type == "text/plain"
            assert by_label["A"].text_content == "지금 업그레이드"
            assert by_label["B"].content_type == "image/png"
            assert by_label["B"].text_content is None
    finally:
        await eng.dispose()


# ── realdb: GET /assets/{id}/text ──────────────────────────────────────────────

@pytestmark_db
@pytest.mark.anyio
async def test_get_asset_text_endpoint_success():
    from app.routers.assets import get_asset_text
    from app.services.storage import get_storage_provider

    eng, Session = await _engine()
    try:
        object_path = f"org/{ORG}/full-{uuid.uuid4().hex[:8]}.txt"
        full = "긴 이메일 본문 " * 100
        await get_storage_provider().put_object("uploads", object_path, full.encode("utf-8"), content_type="text/plain")
        async with Session() as s:
            await _seed(s)
            asset_id = await _seed_asset(s, PROJ_A, "text/plain", object_path=object_path)

        async with Session() as s:
            out = await get_asset_text(asset_id=str(asset_id), db=s, auth=_auth(), org_id=ORG)
            assert out.text_content == full
            assert out.content_type == "text/plain"
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_get_asset_text_endpoint_missing_blob_graceful_503_not_500():
    """까심 RC(필수) — DB row는 존재하지만 GCS blob이 없음(head_object 등록 후 blob 삭제/일시장애
    시나리오). fix 前엔 download_object의 FileNotFoundError가 그대로 터져 FastAPI 500 — fix 後엔
    503+명확 메시지(크래시 아님). object_path를 write 없이 등록해 실제 부재를 재현(mock 아님)."""
    from app.routers.assets import get_asset_text

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            asset_id = await _seed_asset(
                s, PROJ_A, "text/plain", object_path=f"org/{ORG}/never-uploaded-{uuid.uuid4().hex[:8]}.txt"
            )

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_asset_text(asset_id=str(asset_id), db=s, auth=_auth(), org_id=ORG)
            assert ei.value.status_code == 503
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_get_asset_text_endpoint_image_asset_400():
    from app.routers.assets import get_asset_text

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            asset_id = await _seed_asset(s, PROJ_A, "image/png")

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_asset_text(asset_id=str(asset_id), db=s, auth=_auth(), org_id=ORG)
            assert ei.value.status_code == 400
    finally:
        await eng.dispose()


@pytestmark_db
@pytest.mark.anyio
async def test_get_asset_text_endpoint_not_found_404():
    from app.routers.assets import get_asset_text

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_asset_text(asset_id=str(uuid.uuid4()), db=s, auth=_auth(), org_id=ORG)
            assert ei.value.status_code == 404
    finally:
        await eng.dispose()
