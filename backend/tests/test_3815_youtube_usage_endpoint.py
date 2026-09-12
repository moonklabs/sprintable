"""story #3815(Phase3·3-5 PR3, 미르코 PR4 FE 그라운딩 갭 → 페드루 PO 계약 확定
2026-09-12 12:53Z) — BE 조각 2건:
① `GET /channel-connections/{connection_id}/youtube-usage` — 연결 카드 사용량
  줄 계약(`used_units`/`limit_units`/`remaining_units`/`reset_at`/
  `scope:"platform"`). 값은 org 무관(플랫폼 전체 공유 카운터), evidence
  소비 0(순수 읽기), connection_id는 인가에만 쓰임.
② `ChannelConnectionResponse`의 어댑터 능력 노출에 `video_required`·
  `youtube_metadata_required`·`privacy_locked`(Settings `youtube_api_audit_
  incomplete` 반영) 추가 — `thread_max_segments`/`image_required`와 동형
  관례(채널 이름 하드코딩 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for, _seed_org, _seed_human, _session_factory, _setup_org_scoped_app,
)

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


async def _seed_youtube_connection(session, org_id, *, owner_id, channel="youtube_sandbox"):
    from app.services.channel_connection import upsert_channel_connection

    return await upsert_channel_connection(
        session, org_id=org_id, channel=channel, account_id=f"{channel}-usage-1",
        account_label="usage_user", credential_kind="oauth",
        access_token="plain-access-token", refresh_token="plain-refresh-token",
        token_expires_at=datetime.now(timezone.utc), refresh_mode="refresh_token",
        scopes=["https://www.googleapis.com/auth/youtube.upload"], connected_by=owner_id,
    )


# ─── ① GET youtube-usage ───────────────────────────────────────────────────

@pytest.mark.anyio
async def test_youtube_usage_endpoint_returns_platform_scope_contract():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            connection = await _seed_youtube_connection(s, org_id, owner_id=owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(
                    f"/api/v2/organizations/{org_id}/channel-connections/{connection.id}/youtube-usage",
                )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["scope"] == "platform"
            assert body["limit_units"] > 0
            assert body["remaining_units"] == body["limit_units"] - body["used_units"]
            assert body["reset_at"]  # ISO 문자열, UTC 자정 경계.
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_youtube_usage_endpoint_value_is_org_agnostic_platform_counter():
    """⭐핵심 계약 — 값 자체가 org 무관(플랫폼 전체 공유). 서로 다른 두 조직이
    같은 시각에 조회하면 완전히 같은 used_units/limit_units를 봐야 한다(연결이
    다른 org 소속이어도 카운터는 하나)."""
    from app.main import app
    from app.services.youtube_quota import record_youtube_quota_usage_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, _ = await _seed_org(s)
            owner_a = await _seed_human(s, org_a)
            connection_a = await _seed_youtube_connection(s, org_a, owner_id=owner_a)
            org_b, _ = await _seed_org(s)
            owner_b = await _seed_human(s, org_b)
            connection_b = await _seed_youtube_connection(s, org_b, owner_id=owner_b)
            # org_a에서만 사용량 발생 — 그래도 org_b가 조회하는 값도 그 사용량을 반영해야 한다.
            await record_youtube_quota_usage_evidence(
                s, org_id=org_a, work_item_id=uuid.uuid4(), publication_id=uuid.uuid4(),
                event="insert", units=1_600,
            )

        _setup_org_scoped_app(app, Session, org_a, user_id=owner_a)
        try:
            async with _client_for(app) as client:
                r_a = await client.get(
                    f"/api/v2/organizations/{org_a}/channel-connections/{connection_a.id}/youtube-usage",
                )
        finally:
            app.dependency_overrides.clear()

        _setup_org_scoped_app(app, Session, org_b, user_id=owner_b)
        try:
            async with _client_for(app) as client:
                r_b = await client.get(
                    f"/api/v2/organizations/{org_b}/channel-connections/{connection_b.id}/youtube-usage",
                )
        finally:
            app.dependency_overrides.clear()

        assert r_a.status_code == 200 and r_b.status_code == 200
        assert r_a.json()["used_units"] == r_b.json()["used_units"] == 1_600
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_youtube_usage_endpoint_rejects_non_youtube_channel():
    from app.main import app
    from app.services.channel_connection import upsert_channel_connection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            connection = await upsert_channel_connection(
                s, org_id=org_id, channel="threads", account_id="threads-usage-1",
                account_label="threads_user", credential_kind="oauth",
                access_token="plain-access-token", refresh_token=None, token_expires_at=None,
                refresh_mode="reissue_from_access_token", scopes=[], connected_by=owner_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(
                    f"/api/v2/organizations/{org_id}/channel-connections/{connection.id}/youtube-usage",
                )
            assert r.status_code == 422, r.text
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_youtube_usage_endpoint_records_no_evidence():
    """순수 읽기 — 조회 자체가 quota를 소비한 것으로 잘못 기록되면 안 된다."""
    from sqlalchemy import select
    from app.main import app
    from app.models.evidence import Evidence
    from app.services.youtube_quota import YOUTUBE_QUOTA_KIND

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            connection = await _seed_youtube_connection(s, org_id, owner_id=owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                for _ in range(3):
                    r = await client.get(
                        f"/api/v2/organizations/{org_id}/channel-connections/{connection.id}/youtube-usage",
                    )
                    assert r.status_code == 200, r.text
        finally:
            app.dependency_overrides.clear()

        async with Session() as s:
            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == YOUTUBE_QUOTA_KIND,
                )
            )).scalars().all()
        assert rows == []
    finally:
        await engine.dispose()


# ─── ② ChannelConnectionResponse 능력 노출 ─────────────────────────────────

@pytest.mark.anyio
async def test_connection_response_exposes_youtube_capability_flags(monkeypatch):
    from app.core.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "youtube_api_audit_incomplete", True)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            await _seed_youtube_connection(s, org_id, owner_id=owner_id, channel="youtube_sandbox")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
            assert r.status_code == 200, r.text
            row = r.json()[0]
            assert row["video_required"] is True
            assert row["youtube_metadata_required"] is True
            assert row["privacy_locked"] is True
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_response_privacy_locked_false_when_audit_complete(monkeypatch):
    from app.core.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "youtube_api_audit_incomplete", False)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            await _seed_youtube_connection(s, org_id, owner_id=owner_id, channel="youtube_sandbox")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
            assert r.status_code == 200, r.text
            row = r.json()[0]
            assert row["video_required"] is True  # 어댑터 축은 감사 상태와 무관하게 그대로.
            assert row["privacy_locked"] is False
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_response_capability_flags_false_for_unsupported_channel():
    """양성대조 — video_required 미선언 채널(threads)은 3플래그 전부 False."""
    from app.main import app
    from app.services.channel_connection import upsert_channel_connection

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            await upsert_channel_connection(
                s, org_id=org_id, channel="threads", account_id="threads-cap-1",
                account_label="threads_user", credential_kind="oauth",
                access_token="plain-access-token", refresh_token=None, token_expires_at=None,
                refresh_mode="reissue_from_access_token", scopes=[], connected_by=owner_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        try:
            async with _client_for(app) as client:
                r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
            assert r.status_code == 200, r.text
            row = r.json()[0]
            assert row["video_required"] is False
            assert row["youtube_metadata_required"] is False
            assert row["privacy_locked"] is False
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
