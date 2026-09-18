"""story #3806(Phase3·3-2 PR 12, 페드루 PO 確定 2026-09-11 17:26Z) — 「광고비
다시 수집」(`POST .../ads-boosts/{gate_id}/spend/refresh`) 회귀.
`comments/refresh`(channel_post_comments.py) 동형 설계(5분 rate-limit·human
전용·ActivityLog 귀속 기록) — 자연 스케줄(+1d/+7d)은 그대로 두고 그 경로를
즉시 1회 도는 지름길. 세팅 헬퍼는 test_3806_ads_boost_execution.py/
test_3806_ads_boost_spend.py 재사용(중복 재발명 금지). 새 마이그 0건(신규
컬럼 0 — 기존 InsightSnapshot·ActivityLog 재사용)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_3806_ads_boost_spend import _start_boost

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


@pytest.mark.anyio
async def test_refresh_captures_spend_and_returns_shape():
    from app.main import app
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend/refresh")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["spend_minor"] == 12_345
        assert body["cap_reached"] is False
        assert body["run_status"] == "running"
        assert body["captured_at"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_second_call_within_5min_rate_limited_429():
    from app.main import app
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend/refresh")
            assert r1.status_code == 201, r1.text
            r2 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend/refresh")
        assert r2.status_code == 429, r2.text
        assert r2.json()["error"]["code"] == "ADS_SPEND_REFRESH_RATE_LIMITED"
        assert int(r2.headers["Retry-After"]) > 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_reaching_cap_marks_cap_reached_and_creates_scheduler_pause():
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE
    from sqlalchemy import select
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=10_000,
    )
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend/refresh")
        assert r.status_code == 201, r.text
        assert r.json()["cap_reached"] is True

        async with Session() as s:
            pause_cmd = (await s.execute(
                select(PublicationCommand).where(
                    PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE,
                )
            )).scalar_one_or_none()
        assert pause_cmd is not None
        assert pause_cmd.initiated_by == "scheduler"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_records_activity_log_with_human_actor():
    """`resolve_member()`는 휴먼(JWT)을 `OrgMember.id`로 귀속한다(`user.id`가
    아니다 — member_resolver.py 모듈 docstring). 그래서 `owner_id`(User.id)가
    아니라 그 org의 `OrgMember.id`와 대조한다 — 잘못된 값을 지어내 비교하면
    이 테스트가 "누가 눌렀나"를 실제로 검증 못 하게 된다."""
    from app.main import app
    from app.models.activity_log import ActivityLog
    from app.models.project import OrgMember
    from sqlalchemy import select
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend/refresh")
        assert r.status_code == 201, r.text

        async with Session() as s:
            org_member_id = (await s.execute(
                select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == owner_id)
            )).scalar_one()
            log = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.entity_type == "gate", ActivityLog.entity_id == gate_id,
                    ActivityLog.action == "ads_spend_refresh_requested",
                )
            )).scalar_one_or_none()
        assert log is not None
        assert log.actor_id == org_member_id
        assert log.actor_type == "human"
        assert log.context["spend_minor"] == 12_345
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_agent_key_gets_403():
    from app.main import app
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            agent_id = await _seed_agent(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend/refresh")
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_EXECUTE_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_before_boost_started_returns_409():
    from app.main import app
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend/refresh")
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_NOT_STARTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_unknown_gate_returns_404():
    from app.main import app
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, _gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{uuid.uuid4()}/spend/refresh")
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_GATE_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
