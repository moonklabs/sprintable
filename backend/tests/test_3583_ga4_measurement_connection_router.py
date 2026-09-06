"""story #3583-BE(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — GA4 «고객 소유»
측정 연결. 계약 정본은 story 본문의 PO 確定+계약 보강 3·4·5(measurement_connections
key="ga4"). FE #3935가 이미 이 계약값으로 서 있다(머지는 BE 착지 뒤).

이 파일은 라우터 왕복(GET 목록·authorize·callback·properties·select·disconnect)
전용 — `ga4_oauth.py` 순수 단위는 `test_3583_ga4_oauth_unit.py`(non-destructive),
inflow 부착 로직은 `test_3583_ga4_insight_enrichment.py`로 분리했다(원래 28건
단일 파일이 로컬 11.5s·CI ~70s 추정으로 story #3579 60초 가드 경계대역에 들어가,
처음부터 관심사별 3-way로 쪼갠다 — 세팅 헬퍼는 이 파일이 소유, insight_
enrichment.py가 여기서 import).

세팅 헬퍼는 test_e4fc29fa_site_post_orchestration.py 재사용(중복 재발명 금지)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _seed_human, _session_factory

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

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
    monkeypatch.setattr(config_module.settings, "channel_oauth_state_secret", "test-channel-oauth-state-secret")
    monkeypatch.setattr(config_module.settings, "google_client_id", "test-google-client-id")
    monkeypatch.setattr(config_module.settings, "google_client_secret", "test-google-client-secret")
    monkeypatch.setattr(config_module.settings, "backend_url", "https://backend.example")

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


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


def _override_db_only(app, Session) -> None:
    """ga4_callback_endpoint는 Bearer 인증이 없어(Google이 직접 부르는 리다이렉트
    대상) get_current_user 오버라이드가 불필요하다 — get_db/get_read_db만 이
    테스트의 격리 DB로 돌린다(안 하면 기본 설정 DB로 실제 연결을 시도해 실패)."""
    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)


async def _seed_ga4_connection(
    session, org_id, *, status="property_pending", property_id=None, property_name=None,
    reason=None, connected_at=None,
):
    from app.models.ga4_connection import GA4Connection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    row = GA4Connection(
        id=uuid.uuid4(), org_id=org_id,
        encrypted_access_token=encrypt_channel_credential("access-tok"),
        encrypted_refresh_token=encrypt_channel_credential("refresh-tok"),
        status=status, property_id=property_id, property_name=property_name,
        reason=reason, connected_at=connected_at,
    )
    session.add(row)
    await session.commit()
    return row


async def _seed_channel_post_version(session, *, org_id, work_item_id, connection_id, channel, link_url):
    """channel_post_versions는 draft_id에 FK가 있다 — 최소 draft 하나를 먼저 심는다
    (전체 submit→approve→publish 파이프라인은 이 테스트의 관심사 밖, 직접 ORM 구성)."""
    from app.models.channel_post_draft import ChannelPostDraft
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.gate_seal import compute_seal_hash

    draft = ChannelPostDraft(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, channel=channel,
        connection_id=connection_id, status="published",
    )
    session.add(draft)
    await session.commit()

    text = "본문"
    version = ChannelPostVersion(
        id=uuid.uuid4(), draft_id=draft.id, version=1, text=text, link_url=link_url,
        body_sha256=compute_seal_hash({"text": text, "link_url": link_url}),
        author_member_id=uuid.uuid4(), author_kind="human",
    )
    session.add(version)
    await session.commit()
    return draft, version


def _patch_transport(monkeypatch, handler) -> None:
    """test_3497_insight_snapshots.py::_patch_threads_transport와 동형."""
    import httpx

    real_async_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    class _PatchedAsyncClient(real_async_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _PatchedAsyncClient)


# ─── measurement_connections.py: GET 행 노출 ─────────────────────────────────




@pytest.mark.anyio
async def test_list_measurement_connections_ga4_disconnected_when_no_row():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        assert r.status_code == 200, r.text
        rows = {row["key"]: row for row in r.json()}
        assert rows["ga4"]["status"] == "disconnected"
        assert rows["ga4"]["property_id"] is None
        assert rows["ga4"]["reason"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_measurement_connections_ga4_connected_row_shape():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        connected_at = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id)
            await _seed_ga4_connection(
                s, org_id, status="connected", property_id="123", property_name="뭉클랩",
                connected_at=connected_at,
            )
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        assert r.status_code == 200, r.text
        ga4 = next(row for row in r.json() if row["key"] == "ga4")
        assert ga4["status"] == "connected"
        assert ga4["property_id"] == "123"
        assert ga4["property_name"] == "뭉클랩"
        assert ga4["reason"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_measurement_connections_ga4_needs_reauth_carries_reason():
    """계약 보강 4 — reason은 needs_reauth일 때만 값(없는 값을 지어내지 않는다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id)
            await _seed_ga4_connection(s, org_id, status="needs_reauth", reason="revoked")
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        ga4 = next(row for row in r.json() if row["key"] == "ga4")
        assert ga4["status"] == "needs_reauth"
        assert ga4["reason"] == "revoked"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── authorize ────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_ga4_authorize_requires_owner():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id, role="member")
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/measurement-connections/ga4/authorize")
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_authorize_returns_url_with_state():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/measurement-connections/ga4/authorize")
        assert r.status_code == 200, r.text
        url = r.json()["authorize_url"]
        assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
        assert "state=" in url
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── callback ────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_ga4_callback_invalid_state_redirects_with_error_hint():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        _override_db_only(app, Session)
        async with _client_for(app) as client:
            r = await client.get(
                "/api/v2/measurement-connections/ga4/callback", params={"code": "c", "state": "garbage"},
                follow_redirects=False,
            )
        assert r.status_code == 302
        assert "ga4=invalid_state" in r.headers["location"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_callback_denied_when_no_code():
    from app.main import app
    from app.services.channel_oauth_state import sign_channel_oauth_state

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        state = sign_channel_oauth_state(
            org_id=org_id, requester_member_id=uuid.uuid4(), channel="ga4", code_verifier="v",
        )
        _override_db_only(app, Session)
        async with _client_for(app) as client:
            r = await client.get(
                "/api/v2/measurement-connections/ga4/callback",
                params={"state": state, "error": "access_denied"}, follow_redirects=False,
            )
        assert r.status_code == 302
        assert "ga4=denied" in r.headers["location"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_callback_success_creates_property_pending_connection(monkeypatch):
    import httpx

    from app.main import app
    from app.models.ga4_connection import GA4Connection
    from app.services.channel_oauth_state import sign_channel_oauth_state
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        requester_id = uuid.uuid4()
        state = sign_channel_oauth_state(
            org_id=org_id, requester_member_id=requester_id, channel="ga4", code_verifier="v",
        )

        _override_db_only(app, Session)
        async with _client_for(app) as client:
            _patch_transport(monkeypatch, lambda request: httpx.Response(
                200, json={"access_token": "at", "refresh_token": "rt", "expires_in": 3600},
            ))
            r = await client.get(
                "/api/v2/measurement-connections/ga4/callback",
                params={"code": "c", "state": state}, follow_redirects=False,
            )
        assert r.status_code == 302
        assert "ga4=property" in r.headers["location"]

        async with Session() as s:
            row = (await s.execute(select(GA4Connection).where(GA4Connection.org_id == org_id))).scalar_one()
        assert row.status == "property_pending"
        assert row.connected_by == requester_id
        assert row.property_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── properties / select ──────────────────────────────────────────────────


@pytest.mark.anyio
async def test_ga4_list_properties_refreshes_and_returns_list(monkeypatch):
    import httpx

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id, role="owner")
            await _seed_ga4_connection(s, org_id, status="property_pending")
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)

        def _handler(request: "httpx.Request") -> "httpx.Response":
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "fresh-at", "expires_in": 3600})
            return httpx.Response(200, json={"accountSummaries": [
                {"propertySummaries": [{"property": "properties/999", "displayName": "속성 X"}]},
            ]})

        async with _client_for(app) as client:
            _patch_transport(monkeypatch, _handler)
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections/ga4/properties")
        assert r.status_code == 200, r.text
        assert r.json() == [{"property_id": "999", "display_name": "속성 X"}]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_list_properties_persistent_refresh_failure_marks_needs_reauth(monkeypatch):
    import httpx

    from app.main import app
    from app.models.ga4_connection import GA4Connection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id, role="owner")
            await _seed_ga4_connection(s, org_id, status="connected", property_id="1", property_name="p")
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)

        async with _client_for(app) as client:
            _patch_transport(monkeypatch, lambda request: httpx.Response(400, json={"error": "invalid_grant"}))
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections/ga4/properties")
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "GA4_NEEDS_REAUTH"

        async with Session() as s:
            row = (await s.execute(select(GA4Connection).where(GA4Connection.org_id == org_id))).scalar_one()
        assert row.status == "needs_reauth"
        assert row.reason == "revoked"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_select_property_persists_and_returns_connected_row(monkeypatch):
    import httpx

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id, role="owner")
            await _seed_ga4_connection(s, org_id, status="property_pending")
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)

        def _handler(request: "httpx.Request") -> "httpx.Response":
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "fresh-at", "expires_in": 3600})
            return httpx.Response(200, json={"accountSummaries": [
                {"propertySummaries": [{"property": "properties/999", "displayName": "속성 X"}]},
            ]})

        async with _client_for(app) as client:
            _patch_transport(monkeypatch, _handler)
            r = await client.post(
                f"/api/v2/organizations/{org_id}/measurement-connections/ga4/select",
                json={"property_id": "999"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "connected"
        assert body["property_id"] == "999"
        assert body["property_name"] == "속성 X"
        assert body["connected_at"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_select_property_not_in_list_rejected(monkeypatch):
    import httpx

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id, role="owner")
            await _seed_ga4_connection(s, org_id, status="property_pending")
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)

        def _handler(request: "httpx.Request") -> "httpx.Response":
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "fresh-at", "expires_in": 3600})
            return httpx.Response(200, json={"accountSummaries": []})

        async with _client_for(app) as client:
            _patch_transport(monkeypatch, _handler)
            r = await client.post(
                f"/api/v2/organizations/{org_id}/measurement-connections/ga4/select",
                json={"property_id": "does-not-exist"},
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "GA4_PROPERTY_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── disconnect ───────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_ga4_disconnect_revokes_and_deletes_row(monkeypatch):
    import httpx

    from app.main import app
    from app.models.ga4_connection import GA4Connection
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id, role="owner")
            await _seed_ga4_connection(s, org_id, status="connected", property_id="1", property_name="p")
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)

        revoke_calls = []
        async with _client_for(app) as client:
            _patch_transport(monkeypatch, lambda request: (revoke_calls.append(1), httpx.Response(200, json={}))[1])
            r = await client.delete(f"/api/v2/organizations/{org_id}/measurement-connections/ga4")
        assert r.status_code == 204, r.text
        assert len(revoke_calls) == 1, "Google revoke 엔드포인트를 실제로 호출해야 한다"

        async with Session() as s:
            row = (await s.execute(select(GA4Connection).where(GA4Connection.org_id == org_id))).scalar_one_or_none()
        assert row is None, "행 자체가 삭제돼야 한다(토큰 폐기=행 삭제)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_disconnect_preserves_existing_inflow_evidence(monkeypatch):
    """계약 보강(해제 의미) — 이미 모인 유입 evidence(InsightSnapshot)는 DELETE가
    절대 안 건드린다(과거 측정은 사실, 삭제 대상 아님)."""
    import httpx

    from app.main import app
    from app.models.insight_snapshot import InsightSnapshot
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id, role="owner")
            await _seed_ga4_connection(s, org_id, status="connected", property_id="1", property_name="p")
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=uuid.uuid4(), publication_kind="channel_publication",
                work_item_id=uuid.uuid4(), channel="threads", due_at=datetime.now(timezone.utc),
                status="captured", normalized={"inflow_sessions": 5},
            )
            s.add(snap)
            await s.commit()
            snap_id = snap.id
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)

        async with _client_for(app) as client:
            _patch_transport(monkeypatch, lambda request: httpx.Response(200, json={}))
            r = await client.delete(f"/api/v2/organizations/{org_id}/measurement-connections/ga4")
        assert r.status_code == 204

        async with Session() as s:
            still_there = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.id == snap_id)
            )).scalar_one()
        assert still_there.normalized == {"inflow_sessions": 5}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_disconnect_idempotent_when_no_connection():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id, _ = await _seed_human(s, org_id, role="owner")
        _setup_org_scoped_app(app, Session, org_id, user_id=user_id)
        async with _client_for(app) as client:
            r = await client.delete(f"/api/v2/organizations/{org_id}/measurement-connections/ga4")
        assert r.status_code == 204
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


