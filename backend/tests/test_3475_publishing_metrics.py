"""story #3475(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 발행 계측 API(API·
real DB). 5줄 確定의 5지표를 표본으로 고정한다(story 본문 "테스트·표본" 그대로 —
정시 2·지각 1 → on_time_rate 0.667, 만료 1·임박 1·정상 1 → 1/1, org 격리).

세팅 헬퍼는 test_3471_org_content_rules_lint.py와 동형(중복 재발명 금지) — org·
agent·human·connection 시딩은 그대로 재사용하고, 이 스토리 전용 원장(publication_
commands·channel_publications·publication_attempts) 시딩만 새로 추가한다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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
        # story #2728류 싱글턴 관례 — platform_settings이 정확히 1행이어야
        # get_platform_settings()가 성립한다(마이그가 프로덕션에서 시드하는 것을
        # create_all 경로에선 직접 시드).
        await conn.execute(sa_text("INSERT INTO platform_settings (id) VALUES (gen_random_uuid())"))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="3475 Publishing Metrics Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, *, role="owner"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_connection(session, org_id, *, status="active", token_expires_at=None):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel="wordpress",
        account_id=f"acct-{uuid.uuid4().hex[:8]}", status=status,
        credential_kind="pasted_secret", refresh_mode="manual",
        encrypted_access_token=encrypt_channel_credential("plain-secret"),
        token_expires_at=token_expires_at,
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _seed_command_and_publication(
    session, org_id, connection_id, *,
    scheduled_at, published_at, status="completed", dead_letter_at=None,
):
    """publication_commands + channel_publications 한 쌍을 만든다(gate_id·
    approved_version=version_id로 조인 — 그라운딩 그대로)."""
    from app.models.publication_command import PublicationCommand
    from app.models.channel_publication import ChannelPublication

    gate_id = uuid.uuid4()
    version_id = uuid.uuid4()
    cmd = PublicationCommand(
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
        approved_version=version_id, operation="publish", content_kind="channel_post",
        scheduled_at=scheduled_at, status=status, dead_letter_at=dead_letter_at,
        requested_by_member_id=uuid.uuid4(),
    )
    session.add(cmd)
    pub = ChannelPublication(
        id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=version_id,
        connection_id=connection_id, channel="wordpress", status="published", published_at=published_at,
    )
    session.add(pub)
    await session.commit()
    return cmd.id, gate_id, version_id


async def _seed_attempt(session, command_id, gate_id, *, approval_check, adapter_called, started_at, finished_at=None):
    from app.models.publication_attempt import PublicationAttempt

    attempt = PublicationAttempt(
        id=uuid.uuid4(), command_id=command_id, gate_id=gate_id,
        approval_check=approval_check, adapter_called=adapter_called,
        started_at=started_at, finished_at=finished_at,
    )
    session.add(attempt)
    await session.commit()
    return attempt.id


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


# ══════════════════════════════════════════════════════════════════════════════
# API 테스트
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_on_time_rate_two_on_time_one_late_matches_story_sample():
    """story 본문 표본 그대로 — 정시 2·지각 1 → on_time_rate = 2/3 = 0.667..."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            connection_id = await _seed_connection(s, org_id)

            # 정시 1 — 정각 발행.
            scheduled1 = now - timedelta(days=1)
            await _seed_command_and_publication(s, org_id, connection_id, scheduled_at=scheduled1, published_at=scheduled1)
            # 정시 2 — 허용오차(기본 120s) 안, 60초 늦음.
            scheduled2 = now - timedelta(days=2)
            await _seed_command_and_publication(s, org_id, connection_id, scheduled_at=scheduled2, published_at=scheduled2 + timedelta(seconds=60))
            # 지각 1 — 허용오차 밖, 10분 늦음.
            scheduled3 = now - timedelta(days=3)
            await _seed_command_and_publication(s, org_id, connection_id, scheduled_at=scheduled3, published_at=scheduled3 + timedelta(minutes=10))

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["on_time_numer"] == 2
        assert body["on_time_denom"] == 3
        assert abs(body["on_time_rate"] - (2 / 3)) < 1e-9
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_on_time_rate_denom_zero_is_null_not_zero():
    """⭐분모 0(이 window에 예약 발행 자체가 없음) — 0이 아니라 null(§18-2 "0"과
    "미측정"을 가른다의 BE 쪽 근거)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["on_time_rate"] is None
        assert body["on_time_numer"] == 0
        assert body["on_time_denom"] == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connections_expired_and_expiring_matches_story_sample():
    """story 본문 표본 그대로 — 만료 연결 1·임박 1·정상 1 → 1/1."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            await _seed_connection(s, org_id, status="expired")
            await _seed_connection(s, org_id, status="active", token_expires_at=now + timedelta(days=3))
            await _seed_connection(s, org_id, status="active", token_expires_at=now + timedelta(days=30))

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["connections_expired"] == 1
        assert body["connections_expiring_7d"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_duplicate_publications_is_always_zero_by_constraint():
    """⭐확定② — 세지 않고 실 쿼리로 0을 낸다. 정상 표본(중복 없음)에서 0."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            connection_id = await _seed_connection(s, org_id)
            await _seed_command_and_publication(s, org_id, connection_id, scheduled_at=now, published_at=now)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
        assert r.json()["duplicate_publications"] == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unapproved_adapter_calls_counts_failed_approval_checks():
    """⭐approval_check != 'ok' AND adapter_called인 시도만 센다 — 정상(ok) 시도는
    안 센다(정상 경로 0의 근거)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            connection_id = await _seed_connection(s, org_id)
            command_id, gate_id, _ = await _seed_command_and_publication(
                s, org_id, connection_id, scheduled_at=now, published_at=now,
            )
            # 정상 — 안 센다.
            await _seed_attempt(s, command_id, gate_id, approval_check="ok", adapter_called=True, started_at=now)
            # 승인 없는데 호출됨 — 센다.
            await _seed_attempt(s, command_id, gate_id, approval_check="version_mismatch", adapter_called=True, started_at=now)
            # 승인 없지만 호출 자체는 안 됨 — 안 센다(차단이 정상 작동한 경우).
            await _seed_attempt(s, command_id, gate_id, approval_check="missing", adapter_called=False, started_at=now)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
        assert r.json()["unapproved_adapter_calls"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_recovery_seconds_derived_from_dead_letter_to_first_success():
    """⭐복구시간 = dead_letter_at → 그 뒤 첫 성공(ok+adapter_called) 시도의
    finished_at. 표본 1개라 p50=p95=그 값."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        dead_letter_at = now - timedelta(hours=2)
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)
            connection_id = await _seed_connection(s, org_id)
            command_id, gate_id, _ = await _seed_command_and_publication(
                s, org_id, connection_id, scheduled_at=now, published_at=now, dead_letter_at=dead_letter_at,
            )
            recovered_at = dead_letter_at + timedelta(minutes=30)
            await _seed_attempt(
                s, command_id, gate_id, approval_check="ok", adapter_called=True,
                started_at=recovered_at, finished_at=recovered_at,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
        body = r.json()
        assert abs(body["recovery_seconds_p50"] - 1800) < 1.0
        assert abs(body["recovery_seconds_p95"] - 1800) < 1.0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_recovery_seconds_null_when_no_dead_letter_events():
    """복구할 실패가 없었다 — 0이 아니라 null(FE §18-2 "이 기간에 실패가 없습니다"의 재료)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["recovery_seconds_p50"] is None
        assert body["recovery_seconds_p95"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_other_org_data_does_not_leak_in():
    """⭐org 격리 — 다른 org의 발행/연결 데이터가 이 org의 지표에 안 섞인다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)

            other_org_id, _ = await _seed_org(s)
            other_connection_id = await _seed_connection(s, other_org_id, status="expired")
            await _seed_command_and_publication(s, other_org_id, other_connection_id, scheduled_at=now, published_at=now)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["on_time_denom"] == 0
        assert body["connections_expired"] == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_can_read_metrics_get():
    """확定⑤ — org 멤버·에이전트 모두 GET 가능(content_rules GET과 동일 축)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_computed_at_present_and_window_echoed():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=30d")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["window"] == "30d"
        assert body["computed_at"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


_FE_PUBLISHING_METRICS_KEYS = frozenset({
    # PR#3833(components/content/publishing-metrics-band.tsx::PublishingMetrics)의
    # 11개 키와 «정확히» 같아야 한다 — 키 하나만 어긋나도 FE가 그 필드를 조용히
    # undefined→null로 그린다(pydantic response_model이 조용히 다른 값을 내보내도
    # 이 pin이 즉시 잡는다). 페드루 PO 요청(2026-09-05, PR#3836 리뷰).
    "window", "on_time_rate", "on_time_numer", "on_time_denom",
    "duplicate_publications", "unapproved_adapter_calls",
    "recovery_seconds_p50", "recovery_seconds_p95",
    "connections_expired", "connections_expiring_7d", "computed_at",
})


@pytest.mark.anyio
async def test_response_key_set_matches_fe_publishing_metrics_interface_exactly():
    """⭐PO 요청(PR#3836 리뷰) — 응답 키 집합이 FE PublishingMetrics(#3833)와
    정확히 같다(집합 비교 — 키 하나 어긋나면 FE가 조용히 null을 그린다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=7d")
        assert r.status_code == 200, r.text
        assert set(r.json().keys()) == _FE_PUBLISHING_METRICS_KEYS
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_invalid_window_returns_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            owner_id = await _seed_human(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publishing-metrics?window=90d")
        assert r.status_code == 422, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
