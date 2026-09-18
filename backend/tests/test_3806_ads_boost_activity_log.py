"""story #3806(Phase3·3-2 PR 13, 페드루 PO 確定 2026-09-11 19:52Z) — 「중지 스위치·
상한 도달 자동 중지」 실행이 결재 이력에 한 줄도 안 남던 기존 결함(PR11 이전부터,
라이브 재측 中 자체발견) 처방. boost start/pause/resume **명령 실행 성공 지점**
(`process_one_ads_boost_command`)에만 ActivityLog 1행 — 요청(명령 생성) 시점엔
안 남긴다(그건 이미 command 테이블 자체가 사실). 세팅 헬퍼는
test_3806_ads_boost_execution.py/test_3806_ads_boost_spend.py 재사용(중복
재발명 금지). 새 마이그 0건(기존 ActivityLog 테이블 그대로 재사용 — PR12와 동형)."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select

from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_3806_ads_boost_spend import _make_spend_snapshots_due, _start_boost

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


async def _org_member_id(session, org_id, user_id):
    from app.models.project import OrgMember

    return (await session.execute(
        select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
    )).scalar_one()


async def _activity_log(session, *, gate_id, action):
    from app.models.activity_log import ActivityLog

    return (await session.execute(
        select(ActivityLog).where(
            ActivityLog.entity_type == "gate", ActivityLog.entity_id == gate_id, ActivityLog.action == action,
        )
    )).scalar_one_or_none()


@pytest.mark.anyio
async def test_boost_start_execution_records_activity_log():
    """`_start_boost`가 이미 `process_due_publication_commands`까지 실행한다 —
    그 성공 지점에서 `ads_boost_started` 1행이 남아야 한다. `_start_boost`는
    HTTP 라우터(resolve_member 경유)가 아니라 `request_ads_boost_start`를
    `owner_id`(User.id)로 직접 호출하는 테스트 헬퍼라(test_3806_ads_boost_spend.py
    참고) actor_id도 그 값 그대로 — 아래 두 테스트(HTTP 라우터 경유)의 OrgMember.id
    조회와 다른 이유가 여기 있다(둘 다 「그 호출이 실은 넘긴 값」과 대조하는 것으로
    각자 정합)."""
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            log = await _activity_log(s, gate_id=gate_id, action="ads_boost_started")
        assert log is not None
        assert log.actor_id == owner_id
        assert log.actor_type == "human"
        assert log.context == {"initiated_by": "human"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_execution_records_activity_log_and_not_before_execution():
    """PO 지침 — 요청(명령 생성) 시점엔 안 남기고, 실행 성공 지점에만 남긴다.
    POST /pause 직후(아직 tick 미실행)엔 0행, `process_due_publication_commands`
    실행 뒤에야 1행."""
    from app.main import app
    from app.services.publication_command import process_due_publication_commands
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
        assert r.status_code == 201, r.text

        async with Session() as s:
            assert await _activity_log(s, gate_id=gate_id, action="ads_boost_paused") is None, (
                "요청(명령 생성) 시점엔 아직 남으면 안 된다"
            )

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            org_member_id = await _org_member_id(s, org_id, owner_id)
            log = await _activity_log(s, gate_id=gate_id, action="ads_boost_paused")
        assert log is not None
        assert log.actor_id == org_member_id
        assert log.actor_type == "human"
        assert log.context == {"initiated_by": "human"}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resume_execution_records_activity_log():
    from app.main import app
    from app.services.publication_command import process_due_publication_commands
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_pause = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
            assert r_pause.status_code == 201, r_pause.text
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with _client_for(app) as client:
            r_resume = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/resume")
            assert r_resume.status_code == 201, r_resume.text
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            org_member_id = await _org_member_id(s, org_id, owner_id)
            log = await _activity_log(s, gate_id=gate_id, action="ads_boost_resumed")
        assert log is not None
        assert log.actor_id == org_member_id
        assert log.actor_type == "human"
        assert log.context == {"initiated_by": "human"}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_scheduler_cap_pause_execution_records_activity_log_with_cap_reached_reason():
    """상한 도달 자동 중지(PR11, `_enforce_spend_cap`)가 만든 pause 명령이 실행되면
    `context.reason="cap_reached"`가 실려야 한다 — 사람이 누른 pause(위 두 테스트)와
    구분되는 유일한 차이. actor는 여전히 사람(gate.resolver_id)이다."""
    from app.models.gate import Gate
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.publication_command import process_due_publication_commands
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=10_000,
    )
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["capped"] == 1, counts

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts  # 방금 만들어진 scheduler pause 명령.

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            resolver_org_member_id = gate.resolver_id
            log = await _activity_log(s, gate_id=gate_id, action="ads_boost_paused")
        assert log is not None
        assert log.actor_id == resolver_org_member_id
        assert log.actor_type == "human"
        assert log.context == {"initiated_by": "scheduler", "reason": "cap_reached"}
    finally:
        await engine.dispose()
