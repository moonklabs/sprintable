"""story 620beefc(Phase1·마케팅운영, 페드루 PO 決定 2026-09-04) — Threads 이미지 발행+
미디어 저장·에셋 계보. AC7 QA 목록: 규격 경계·변환 불가 3종 422·봉인 뮤테이션(재승인
축 세분화)·비동기 완료 tick 3갈래(IN_PROGRESS/FINISHED/ERROR)·텍스트 발행 회귀.

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


# ─── AC4 — 봉인 판정 축 세분화(media) ─────────────────────────────────────────

@pytest.mark.anyio
async def test_media_change_after_approval_reopens_gate_with_media_changed_reason():
    """본문·예약 시각 그대로, 이미지만 승인 뒤 첨부 → gate가 pending으로 되돌아가고
    voided 사유가 MEDIA_CHANGED(CONTENT_CHANGED로 뭉뚱그려지면 안 됨, AC4)."""
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            # 승인된 gate에 걸린 pending command 하나(취소 대상 관측용) 직접 심는다 —
            # void_pending_commands_for_gate가 이 행을 MEDIA_CHANGED로 되돌리는지 확인.
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id,
                destination=connection_id, approved_version=uuid.uuid4(),
                status="pending", requested_by_member_id=human_id,
            )
            s.add(cmd)
            await s.commit()

            raw = _png_bytes(400, 400)
            r_img = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
            assert r_img.status_code == 201, r_img.text

            from app.models.gate import Gate
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            await s.refresh(gate)
            assert gate.status == "pending"
            assert gate.reapproval_required is True

            await s.refresh(cmd)
            assert cmd.status == "voided"
            assert cmd.reason_code == "MEDIA_CHANGED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_text_edit_after_image_attach_carries_image_forward():
    """story 620beefc(페드루 리뷰 블로커 B1) — 이미지 첨부 뒤 순수 텍스트 편집(이미지
    엔드포인트 미경유)이 이미지를 조용히 떨어뜨리지 않는다. image_sha256이 새 버전에도
    캐리포워드될 뿐 아니라(원 버그의 절반 — 이건 처음부터 됐었다), **ChannelPostImage
    행 자체**도 새 version_id로 복제돼야 한다(원 버그의 실체 — publish_channel_post_
    draft가 gate가 아니라 latest.id로 이미지 행을 찾으므로, 행이 옛 version_id에만
    남아 있으면 image_sha256은 세팅돼 있는데도 발행 시점엔 이미지를 못 찾아 조용히
    TEXT로 나가고 썸네일도 사라진다)."""
    from app.main import app
    from app.models.channel_post_image import ChannelPostImage
    from app.models.channel_post_version import ChannelPostVersion
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(400, 400)
            r_img = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
            assert r_img.status_code == 201, r_img.text
            image_version_id = uuid.UUID(r_img.json()["version_id"])

            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "본문만 수정 — 이미지 엔드포인트 안 거침",
                },
            )
            assert r_edit.status_code == 201, r_edit.text
            new_version_id = uuid.UUID(r_edit.json()["version_id"])
            assert new_version_id != image_version_id

            rows = (await s.execute(
                select(ChannelPostVersion).where(ChannelPostVersion.id.in_([image_version_id, new_version_id]))
            )).scalars().all()
            by_id = {v.id: v for v in rows}
            assert by_id[new_version_id].image_sha256 == by_id[image_version_id].image_sha256
            assert by_id[new_version_id].image_sha256 is not None

            # 원 버그의 실체 — 이 assert 없이는 위 두 줄만으로 "고쳐진 것처럼" 보인다.
            new_version_image = (await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == new_version_id)
            )).scalar_one_or_none()
            assert new_version_image is not None, (
                "ChannelPostImage 행이 새 version_id로 복제 안 됨 — publish 시점에 "
                "latest.id로 조회하면 빈손이라 이미지 없이 TEXT로 나간다(B1 원 버그)"
            )
            original_image = (await s.execute(
                select(ChannelPostImage).where(ChannelPostImage.version_id == image_version_id)
            )).scalar_one()
            assert new_version_image.original_sha256 == original_image.original_sha256
            assert new_version_image.final_sha256 == by_id[new_version_id].image_sha256
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_uses_carried_forward_image_not_silently_text_only():
    """story 620beefc(페드루 리뷰 블로커 B1, 발행 레벨 실증) — 이미지 첨부 뒤 텍스트만
    편집한 버전을 실제로 발행하면 IMAGE 컨테이너 경로(image_url 있음)로 나가야 한다 —
    B1이 있었다면 이 발행은 image_url=None인 TEXT 경로로 조용히 샜다."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            raw = _png_bytes(400, 400)
            r_img = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
            assert r_img.status_code == 201, r_img.text

            # 이미지 엔드포인트를 안 거치는 순수 텍스트 편집(새 버전 — image_sha256만 캐리포워드).
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "발행 직전 텍스트만 재편집",
                },
            )
            assert r_edit.status_code == 201, r_edit.text

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            captured = {}

            async def _fake_create_container(client_, *, access_token, threads_user_id, text, image_url=None):
                captured["image_url"] = image_url
                return "container-carried-forward"

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(side_effect=_fake_create_container)),
            ):
                publication = await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                )
        assert publication.status == "container_created"  # 비동기 IMAGE 경로 — 즉시 published 아님
        assert captured["image_url"] is not None, "B1 재발 — 캐리포워드된 이미지가 발행에 안 실림"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC5 — 비동기 발행 흐름 3갈래(IN_PROGRESS/FINISHED/ERROR) ─────────────────

async def _prepare_approved_image_draft(client, s, *, org_id, connection_id, story_id, human_id):
    draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
    raw = _png_bytes(400, 400)
    r_img = await _upload_and_confirm(client, org_id, draft_id, raw, content_type="image/png")
    assert r_img.status_code == 201, r_img.text
    r_submit = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
    )
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    await _approve_gate_directly(s, gate_id)
    return draft_id


@pytest.mark.anyio
async def test_image_publish_creates_container_then_waits_no_immediate_publish_call():
    """컨테이너 생성 직후 publish_container를 즉시 호출하지 않는다(PO 決定 — Meta 권장
    30초 대기) — container_created 그대로 반환, processing=true."""
    from app.main import app
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )

            publish_container_mock = AsyncMock(side_effect=AssertionError("publish_container는 이 tick에 호출되면 안 된다"))
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-1")),
                patch.object(tp, "publish_container", publish_container_mock),
            ):
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["processing"] is True
            assert body["permalink"] is None
            publish_container_mock.assert_not_called()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_in_progress_tick_does_not_call_publish_container():
    """재진입(다음 tick)에서 컨테이너 status=IN_PROGRESS면 여전히 publish 호출 없이
    반환된다."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-2")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            publish_container_mock = AsyncMock(side_effect=AssertionError("IN_PROGRESS tick엔 publish_container 호출 금지"))
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("IN_PROGRESS", None))),
                patch.object(tp, "publish_container", publish_container_mock),
            ):
                publication = await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                )
            assert publication.status == "container_created"
            publish_container_mock.assert_not_called()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_finished_tick_completes():
    """FINISHED가 되면 그제서야 publish_container로 진행해 published로 끝난다."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-3")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("FINISHED", None))),
                patch.object(tp, "publish_container", AsyncMock(return_value="media-img-3")),
                patch.object(tp, "get_permalink", AsyncMock(return_value="https://threads.net/p/xyz")),
            ):
                publication = await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                )
            assert publication.status == "published"
            assert publication.external_id == "media-img-3"
            assert publication.permalink == "https://threads.net/p/xyz"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_error_status_needs_check_no_auto_retry():
    """ERROR면 결정적 실패로 즉시 dead_letter(needs_check, 백오프 재시도 없음)."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft, ChannelImageContainerFailedError
    from app.services.publication_command import classify_failure_kind, FAILURE_KIND_NEEDS_CHECK
    import app.services.threads_publish as tp

    assert classify_failure_kind("CHANNEL_IMAGE_CONTAINER_FAILED") == FAILURE_KIND_NEEDS_CHECK

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-4")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("ERROR", "INVALID_ASPEC_RATIO"))),
            ):
                with pytest.raises(ChannelImageContainerFailedError):
                    await publish_channel_post_draft(
                        s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                    )

            # story 620beefc(페드루 리뷰 블로커 B2) — external_container_id가 지워져야
            # 사람의 AC5 재시도가 죽은 컨테이너를 다시 poll하지 않고 완전히 새 컨테이너를
            # 만든다(안 지우면 ERROR/EXPIRED 컨테이너를 영구히 반복 poll하는 실패 루프).
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select as sa_select

            pub = (await s.execute(
                sa_select(ChannelPublication).where(ChannelPublication.org_id == org_id)
            )).scalar_one()
            assert pub.status == "failed"
            assert pub.external_container_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_error_retry_creates_brand_new_container():
    """story 620beefc(페드루 리뷰 블로커 B2, 회복 경로 실증) — ERROR 뒤 external_
    container_id가 지워진 상태에서 재시도하면(다음 publish_channel_post_draft 호출)
    create_container를 다시 호출해 완전히 새 creation_id를 받는다 — 죽은 컨테이너를
    또 poll하지 않는다."""
    from app.main import app
    from app.services.channel_posts import publish_channel_post_draft, ChannelImageContainerFailedError
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-dead")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("EXPIRED", None))),
            ):
                with pytest.raises(ChannelImageContainerFailedError):
                    await publish_channel_post_draft(
                        s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                    )

            create_container_retry = AsyncMock(return_value="container-fresh")
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", create_container_retry),
            ):
                publication = await publish_channel_post_draft(
                    s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                )
            assert publication.status == "container_created"
            assert publication.external_container_id == "container-fresh"
            create_container_retry.assert_called_once()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_image_publish_in_progress_beyond_5min_times_out_as_needs_check():
    """story 620beefc(페드루 리뷰 블로커 B3) — IN_PROGRESS 상한 없이는 command가
    attempt_count/backoff 어느 것도 안 건드리는 "처리 中" 분기(pending, +30초)로만
    계속 재큐잉돼 진짜 무한루프가 된다(dead_letter로 절대 못 빠짐). row.created_at을
    5분보다 오래 전으로 직접 되돌려(최초 컨테이너 생성 시각의 근사) 그 시나리오를
    재현 — ChannelImageContainerFailedError(needs_check)로 떨어져야 한다."""
    from datetime import timedelta
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.services.channel_posts import publish_channel_post_draft, ChannelImageContainerFailedError
    from sqlalchemy import select as sa_select
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-stuck")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            pub = (await s.execute(
                sa_select(ChannelPublication).where(ChannelPublication.org_id == org_id)
            )).scalar_one()
            pub.created_at = datetime.now(timezone.utc) - timedelta(minutes=6)
            await s.commit()

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "get_container_status", AsyncMock(return_value=("IN_PROGRESS", None))),
            ):
                with pytest.raises(ChannelImageContainerFailedError) as exc_info:
                    await publish_channel_post_draft(
                        s, org_id=org_id, draft_id=draft_id, published_by_member_id=human_id,
                    )
            assert exc_info.value.container_status == "TIMEOUT"

            await s.refresh(pub)
            assert pub.status == "failed"
            assert pub.external_container_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_processing_kind_awaiting_container_exposed_in_list():
    """AC5·§17-15 — command_status=pending ∧ publication_status=container_created →
    processing_kind='awaiting_container' 목록 응답에 노출."""
    from app.main import app
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _prepare_approved_image_draft(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(return_value="container-img-5")),
            ):
                await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        assert r_list.status_code == 200, r_list.text
        item = next(it for it in r_list.json() if it["draft_id"] == draft_id)
        assert item["command_status"] == "pending"
        assert item["publication_status"] == "container_created"
        assert item["processing_kind"] == "awaiting_container"
        assert item["thumbnail_url"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 텍스트 발행 회귀(이미지 미첨부 경로 완전 무변경) ────────────────────────

@pytest.mark.anyio
async def test_text_only_publish_unaffected_by_image_branch():
    """이미지 없는 초안은 has_image=False 분기를 안 타 기존 TEXT 동기 경로 그대로 —
    create_container에 image_url=None이 넘어가고 같은 호출 안에서 즉시 publish까지
    끝난다(비동기 대기 없음, 회귀 0)."""
    from app.main import app
    import app.services.threads_publish as tp

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client, Session() as s:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            captured = {}

            async def _fake_create_container(client_, *, access_token, threads_user_id, text, image_url=None):
                captured["image_url"] = image_url
                return "container-text-only"

            with (
                patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(0, 100, 3600))),
                patch.object(tp, "create_container", AsyncMock(side_effect=_fake_create_container)),
                patch.object(tp, "publish_container", AsyncMock(return_value="media-text-only")),
                patch.object(tp, "get_permalink", AsyncMock(return_value=None)),
            ):
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["processing"] is False
        assert body["external_id"] == "media-text-only"
        assert captured["image_url"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC2 — 어댑터 이미지 규격 선언 노출 ───────────────────────────────────────

@pytest.mark.anyio
async def test_connection_response_exposes_threads_image_spec():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r.status_code == 200, r.text
        rows = r.json()
        assert len(rows) == 1
        row = rows[0]
        assert row["image_formats"] == ["image/jpeg", "image/png"]
        assert row["image_max_bytes"] == 8 * 1024 * 1024
        assert row["image_aspect_max"] == 10.0
        assert row["image_width_min"] == 320
        assert row["image_width_max"] == 1440
        assert row["image_color_space"] == "sRGB"
        assert row["image_max_count"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 페드루 리뷰 블로커 B4(보안) — create_only 서명 ──────────────────────────

@pytest.mark.anyio
async def test_upload_url_requests_create_only_signed_url_and_exposes_required_headers():
    """story 620beefc(페드루 리뷰 블로커 B4) — create_only=True 없이는 TTL(10분) 안에
    같은 서명 URL로 원본을 재PUT할 수 있어, confirm()이 이미 읽어 해시·봉인한 뒤 실제
    GCS 객체가 다른 바이트로 바뀔 수 있다(발행 바이트≠봉인 바이트). provider.
    signed_write_url이 실제로 create_only=True를 받는지, 응답에 provider가 요구하는
    헤더가 그대로 실리는지 직접 검증한다(story #3249 assets.py 선례와 동형 계약).
    LocalStorageProvider는 create_only PUT 수신을 구현 안 해(fail-closed) 이 축은
    provider를 목으로 대체해 signed_write_url 호출 인자 자체를 검증한다."""
    from app.main import app
    from unittest.mock import AsyncMock, MagicMock, patch

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        fake_provider = MagicMock()
        fake_provider.signed_write_url = AsyncMock(return_value="https://storage.googleapis.com/fake-signed-url")
        fake_provider.required_write_headers = MagicMock(return_value={"x-goog-if-generation-match": "0"})

        import app.services.channel_post_images as cpi_mod
        async with _client_for(app) as client:
            draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
            with patch.object(cpi_mod, "get_storage_provider", return_value=fake_provider):
                r = await _request_upload_url(client, org_id, draft_id, content_type="image/png")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["required_put_headers"] == {"x-goog-if-generation-match": "0"}

        _, kwargs = fake_provider.signed_write_url.call_args
        assert kwargs["create_only"] is True
        fake_provider.required_write_headers.assert_called_once_with(create_only=True)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
