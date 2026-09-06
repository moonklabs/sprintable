"""story 620beefc(Phase1·마케팅운영, 페드루 PO 決定 2026-09-04) — Threads 이미지 업로드+
변환+계보(AC1/AC2) 및 변환 불가 3종 422(§13 3요소). story #3579(2026-09-06, 페드루 PO
確定) 후속으로 `test_620beefc_channel_post_image.py`(25 테스트)에서 3-way 분할 — 원본
파일이 러너 정규화 60초 가드 경계대역(48~57s, PR #3925/#3926에서 174s/141s까지 관측)에
있어 러너가 조금만 느려져도 가드에 걸림. 세팅 헬퍼·픽스처는 이 파일(`_upload`)이 그대로
소유(원본 그대로, 신규 헬퍼 0) — `_lifecycle`·`_regression` 두 파일이 여기서 import.
autouse 픽스처(`_dispose_global_engine_after_test`·`_configure_secrets`·
`_local_channel_media_storage`)만 pytest 관례상 파일마다 재선언(import로는 전파 안 됨,
story #3562 전례와 동일).

이 파일 담당 — 업로드+변환+계보(AC1/AC2)·변환 불가 3종 422(종횡비 초과/미달·디코드
불가·애니메이션)·업로드-URL 형식/채널 미지원.

`STORAGE_PROVIDER=local`(zero-config 실 디스크, avatar_upload 라우터 테스트와 동일
관례)로 GCS 없이 confirm의 head_object/download_object 실물 검증까지 태운다. 업로드
자체(FE PUT)는 local provider가 수신을 구현 안 해(storage/local.py 명시 갭) 테스트가
직접 `put_object`로 "PUT이 이미 끝난" 상태를 만든 뒤 confirm만 호출한다(avatar 라우터
테스트와 동일 우회)."""
from __future__ import annotations

import io
import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


_CHANNEL_MEDIA_BUCKET = "test-channel-media-620beefc"


@pytest.fixture(autouse=True)
def _local_channel_media_storage(monkeypatch, tmp_path):
    """`STORAGE_PROVIDER`/`STORAGE_LOCAL_ROOT`는 storage/factory.py가 매 호출 시점에
    read하므로 monkeypatch.setenv만으로 충분. `CHANNEL_MEDIA_BUCKET`/`_PUBLIC_BASE`는
    channel_post_images.py의 모듈 최상위 상수(import 시 1회 평가)라 **importlib.reload
    대신 monkeypatch.setattr로 속성만 직접 덮어쓴다** — reload는 그 모듈의 예외
    클래스들(ChannelImageUnsupportedError 등)도 전부 새 객체로 재정의해, 이미
    `from ... import ChannelImageUnsupportedError`로 구 클래스를 바인딩해 둔 라우터의
    `except ChannelImageUnsupportedError` 절이 새 인스턴스를 못 잡고(클래스 정체성
    불일치) 500으로 새는 사고가 실측 확認됐다(avatar_upload.py는 이 함정이 없다 —
    avatar 라우터 테스트가 reload를 쓰는 건 그 모듈에 예외 클래스가 없기 때문)."""
    import app.services.channel_post_images as cpi_module

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="620beefc Image Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, project_id, *, role="owner"):
    """member_resolver.py::_resolve_member_legacy — JWT(휴먼)는 org_member.id로 해소된다
    (TeamMember가 아니다, test_3419_cancel_unpublish.py와 동일 관례)."""
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_story(session, org_id, project_id, *, title="채널 포스트"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_connection(session, org_id, *, channel="threads", status="active", token="plain-access-token"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=f"acct-{uuid.uuid4().hex[:8]}", status=status,
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential(token) if status == "active" else None,
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _approve_gate_directly(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


# ─── 이미지 픽스처 ────────────────────────────────────────────────────────────

def _png_bytes(width: int, height: int, *, mode: str = "RGB", color=(200, 50, 80)) -> bytes:
    from PIL import Image

    img = Image.new(mode, (width, height), color=color if mode != "L" else 128)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# story #3530 — instagram 어댑터는 image_formats=("image/jpeg",)뿐(PNG 미지원) —
# instagram 하한(image_aspect_min) 검증 테스트는 이 헬퍼로 실 JPEG를 만들어야 한다.
def _jpeg_bytes(width: int, height: int, *, color=(200, 50, 80)) -> bytes:
    from PIL import Image

    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _animated_gif_bytes() -> bytes:
    from PIL import Image

    frames = [Image.new("RGB", (100, 100), color=(i * 40, 0, 0)) for i in range(3)]
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    return buf.getvalue()


async def _put_raw_object(object_path: str, raw: bytes, *, content_type: str) -> None:
    from app.services.storage import get_storage_provider

    ok = await get_storage_provider().put_object(_CHANNEL_MEDIA_BUCKET, object_path, raw, content_type=content_type)
    assert ok


async def _request_upload_url(client, org_id, draft_id, *, content_type: str) -> dict:
    r = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/upload-url",
        json={"content_type": content_type},
    )
    return r


def _object_path_for(org_id, draft_id, *, content_type: str) -> str:
    ext = {"image/jpeg": "jpg", "image/png": "png"}.get(content_type, "bin")
    return f"channel-media/{org_id}/{draft_id}/{uuid.uuid4().hex}.{ext}"


async def _upload_and_confirm(client, org_id, draft_id, raw: bytes, *, content_type: str):
    """story 620beefc(페드루 리뷰 블로커 B4 후속) — create_only=True 서명 뒤로는
    upload-url 엔드포인트를 실제로 안 거친다. `storage/local.py`는 PUT 수신 자체를
    구현 안 해(그 모듈 명시 갭) create_only=True 서명이면 fail-closed로 URL을 아예
    미발급한다 — LocalStorageProvider의 한계일 뿐 confirm()의 파생/봉인 로직과는
    무관하므로, 이 헬퍼는 "FE가 PUT을 이미 끝냈다"는 상태를 직접 만들어(object_path
    구성+put_object 직접 호출, `_object_path()`(channel_post_images.py)와 동일 모양)
    confirm 자체만 실행한다(GIF 양성대조 테스트가 이미 쓰던 것과 동일 기법을 공용
    헬퍼로 승격). upload-url 엔드포인트 자체의 검증(형식/채널 미지원)은 별도
    `test_upload_url_*` 테스트가 여전히 실 엔드포인트로 검증한다(그 경로들은
    signed_write_url 호출 前에 거부돼 이 갭과 무관)."""
    object_path = _object_path_for(org_id, draft_id, content_type=content_type)
    await _put_raw_object(object_path, raw, content_type=content_type)
    r_confirm = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/confirm",
        json={"object_path": object_path},
    )
    return r_confirm


async def _create_draft(client, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다."):
    r = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": text},
    )
    assert r.status_code == 201, r.text
    return r.json()["draft_id"]


# ─── AC1/AC2 — 업로드+계보(변환 불요 vs 변환 필요) ────────────────────────────

@pytest.mark.anyio
async def test_upload_conforming_image_no_conversion():
    """규격 안(320~1440px·JPEG/PNG·8MB 밑)이면 파생본을 안 만든다 — was_converted=False,
    final=원본 그대로."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(800, 600)
            r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["was_converted"] is False
        assert body["original_width"] == 800
        assert body["final_width"] == 800
        assert body["final_bytes"] == body["original_bytes"] == len(raw)
        assert body["version"] == 2  # v1=텍스트만, v2=이미지 첨부(새 버전)
        assert body["image_url"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_oversized_width_auto_converted():
    """너비 1440 초과 → 서버가 자동 다운스케일(PO 決定 ③) — 422 아님, was_converted=True."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(3000, 2000)
            r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["was_converted"] is True
        assert body["original_width"] == 3000
        assert body["final_width"] == 1440
        assert body["final_height"] == 960  # 2000 * (1440/3000) = 960
        assert body["final_bytes"] < body["original_bytes"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_narrow_width_auto_upscaled():
    """너비 320 미만도 서버가 자동 업스케일(Meta "will be scaled" 그대로 선제 처리)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(200, 200)
            r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["was_converted"] is True
        assert body["final_width"] == 320
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC1 — 변환 불가 3종 422(§13 3요소) ──────────────────────────────────────

@pytest.mark.anyio
async def test_upload_aspect_ratio_exceeded_returns_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(2000, 100)  # 종횡비 20:1 > 10:1
            r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_IMAGE_ASPECT_RATIO_EXCEEDED"
        assert error["max_aspect_ratio"] == 10.0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# story #3530(BE #3872이 어댑터·검증엔 이미 심어 둔 하한(image_aspect_min)의 경계
# 테스트 3개 — instagram(4:5=0.8~1.91:1) 전용, PO 確定 "포함/배제 일치: 상한
# ratio > max(1.91 통과)와 짝으로 하한 ratio < min(0.8 통과)").
@pytest.mark.anyio
async def test_upload_aspect_ratio_too_narrow_returns_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _jpeg_bytes(400, 1000)  # width/height 0.4 < 하한 0.8
            r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/jpeg")
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_IMAGE_ASPECT_RATIO_TOO_NARROW"
        assert error["min_width_height_ratio"] == 0.8
        assert error["width_height_ratio"] == pytest.approx(0.4)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_aspect_ratio_min_boundary_passes():
    """경계값(width/height == image_aspect_min 정확히)은 거부되지 않는다 — 검증이
    `<`(strict)이지 `<=`가 아니어야 한다(PO 「0.8 통과」 확定)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _jpeg_bytes(400, 500)  # width/height 정확히 0.8
            r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/jpeg")
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_aspect_ratio_max_boundary_passes_for_orientation_aware_channel():
    """instagram(orientation-aware 분기, width/height 원시 비율)도 상한 경계값
    (== image_aspect_max 정확히)은 거부되지 않는다 — 정규화 분기(else 절)만 검증
    하던 회귀를 orientation-aware 분기까지 확장."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="instagram")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _jpeg_bytes(955, 500)  # width/height 정확히 1.91
            r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/jpeg")
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_undecodable_returns_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = b"not a real image, just garbage bytes " * 20
            r = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_IMAGE_UNDECODABLE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_animated_gif_returns_422():
    """GIF는 애초에 adapter.image_formats(JPEG/PNG)에 없어 upload-url 발급 자체가
    422로 막힌다 — 그 갭을 우회해 raw object만 심어 confirm 단계까지 도달시켜
    ChannelImageAnimatedUnsupportedError 경로 자체를 직접 검증한다(방어心層 확인)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            object_path = f"channel-media/{org_id}/{draft_id}/{uuid.uuid4().hex}.gif"
            await _put_raw_object(object_path, _animated_gif_bytes(), content_type="image/gif")
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/assets/confirm",
                json={"object_path": object_path},
            )
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_IMAGE_ANIMATED_UNSUPPORTED"
        assert error["frame_count"] == 3
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_url_unsupported_format_returns_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r = await _request_upload_url(client, org_id, draft_id, content_type="image/gif")
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_IMAGE_UNSUPPORTED_FORMAT"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_upload_url_unsupported_channel_returns_422():
    """image_max_count<=0인 채널(threads 아닌 가짜 채널)은 이미지 자체를 지원 안 함."""
    from app.main import app
    from app.services import channel_adapters as adapters_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id, channel="no-image-channel")
            story_id = await _seed_story(s, org_id, project_id)

        no_image_adapter = adapters_mod.ChannelAdapterConfig(
            authorize_url="https://example.com/auth", token_url="https://example.com/token",
            scope="basic", refresh_mode="manual", display_name="No Image Channel",
        )
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        with patch.dict(adapters_mod.CHANNEL_ADAPTERS, {"no-image-channel": no_image_adapter}):
            async with _client_for(app) as client:
                draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
                r = await _request_upload_url(client, org_id, draft_id, content_type="image/png")
        assert r.status_code == 422, r.text
        error = r.json().get("error") or r.json()
        assert error["code"] == "CHANNEL_IMAGE_UNSUPPORTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


