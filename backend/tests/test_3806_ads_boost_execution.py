"""story #3806(Phase3·3-2 PR3, 페드루 PO 確定 2026-09-11) — 승인된 ads_boost 게이트
실행·중지·재개(`publication_command` 재사용·`toggle_seq` 축) 회귀. 세팅 헬퍼는
test_3806_ads_boost_gate.py(PR 2)를 그대로 재사용(중복 재발명 금지) — 발행물+게이트
생성은 PR 2 API 경유, 승인만 이 파일이 직접 DB로 전이시킨다(승인 API 자체는 이미
`gates.py` 범용 엔드포인트가 커버, 이 PR의 관심사 밖)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory, _seed_default_role, _seed_agent
from tests.test_3475_publishing_metrics import _seed_human, _client_for, _setup_org_scoped_app
from tests.test_3497_insight_snapshots import _seed_channel_connection
from tests.test_3806_ads_boost_gate import _seed_publication, _boost_body, _approve_gate

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


async def _setup_approved_gate(session_factory_result, *, approve=True, objective="POST_ENGAGEMENT"):
    """PR 2 API 경유로 게이트를 만들고(봉인 6열 전부 실제로 채워짐), approve=True면
    바로 승인까지 전이시킨다. 반환: (engine, Session, org_id, owner_id, gate_id).
    `objective`는 워커 fix 테스트가 [sandbox:budget-exceeded]/[sandbox:pause-delayed]
    마커를 실어 보내는 자리(ads_sandbox_campaign.py 모듈 docstring 참고)."""
    from app.main import app

    engine, Session = session_factory_result
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_id = await _seed_human(s, org_id, role="owner")
        conn = await _seed_channel_connection(s, org_id, channel="threads")
        ad_conn = await _seed_channel_connection(s, org_id, channel="ads_sandbox")
        await _seed_default_role(s, org_id)
        pub, _ = await _seed_publication(s, org_id=org_id, connection_id=conn.id)

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
            json=_boost_body(ad_connection_id=ad_conn.id, objective=objective),
        )
    assert r.status_code == 201, r.text
    gate_id = uuid.UUID(r.json()["gate_id"])
    app.dependency_overrides.clear()

    if approve:
        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)

    return engine, Session, org_id, project_id, owner_id, gate_id


async def _mark_command_status(session, command_id: uuid.UUID, status: str):
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    cmd = (await session.execute(
        select(PublicationCommand).where(PublicationCommand.id == command_id)
    )).scalar_one()
    cmd.status = status
    await session.commit()


@pytest.mark.anyio
async def test_start_requires_approved_gate():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), approve=False,
    )
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_GATE_NOT_APPROVED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_start_creates_boost_start_command():
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["operation"] == "boost_start"
        assert body["toggle_seq"] == 0
        assert body["status"] == "pending"

        async with Session() as s:
            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == uuid.UUID(body["command_id"]))
            )).scalar_one()
            assert cmd.content_kind == "ads_boost"
            assert cmd.gate_id == gate_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_start_response_serializes_initiated_by_human():
    """story #3806(Phase3·3-2 PR 8, 페드루 PO 確定 2026-09-11) — 0367 컬럼은 PR6이
    이미 DB에 채웠지만(`test_3806_ads_boost_starts_worker.py::
    test_human_triggered_start_is_marked_initiated_by_human`가 DB 모델 값으로
    확認) 이 파일의 `CommandResponse`가 그 필드를 직렬화 안 해 API 축만으론 못
    읽었다(양성대조 실측 중 자체발견 — PO 지적). 뮤테이션 대상: `_to_response`에서
    `initiated_by=command.initiated_by` kwarg를 걷으면 이 단언이 KeyError/실패로
    RED."""
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
        assert r.status_code == 201, r.text
        assert r.json()["initiated_by"] == "human"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_start_resubmit_is_idempotent_same_command():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
            r2 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
        assert r1.status_code == 201, r1.text
        assert r2.status_code == 201, r2.text
        assert r1.json()["command_id"] == r2.json()["command_id"], "같은 승인주기 재요청은 같은 boost_start 행을 반환해야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_key_gets_403_on_start():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_EXECUTE_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_gate_returns_404():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, _gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{uuid.uuid4()}/start")
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_GATE_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_gate_returns_same_404():
    from app.main import app

    engine, Session, org_a, _pa, owner_a, _gate_a = await _setup_approved_gate(await _session_factory())
    try:
        engine_b, Session_b, org_b, _pb, owner_b, gate_b = await _setup_approved_gate((engine, Session))
        _setup_org_scoped_app(app, Session, org_a, user_id=owner_a)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_a}/ads-boosts/{gate_b}/start")
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_GATE_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_without_start_returns_409():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_NOT_STARTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resume_without_pause_returns_409():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_start = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
            assert r_start.status_code == 201, r_start.text
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/resume")
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_NOT_PAUSED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_creates_toggle_seq_1():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_start = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
            assert r_start.status_code == 201, r_start.text
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["operation"] == "pause"
        assert body["toggle_seq"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_double_click_reuses_same_row_while_pending():
    """페드루 핀 — 비종결 재클릭은 새 행을 만들지 않고 같은 행을 재사용한다(행 1·호출 1)."""
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_start = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
            assert r_start.status_code == 201, r_start.text
            r1 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
            r2 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
        assert r1.status_code == 201, r1.text
        assert r2.status_code == 201, r2.text
        assert r1.json()["command_id"] == r2.json()["command_id"]
        assert r1.json()["toggle_seq"] == r2.json()["toggle_seq"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_when_already_completed_returns_409():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_start = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
            assert r_start.status_code == 201, r_start.text
            r1 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
            assert r1.status_code == 201, r1.text

            async with Session() as s:
                await _mark_command_status(s, uuid.UUID(r1.json()["command_id"]), "completed")

            r2 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
        assert r2.status_code == 409, r2.text
        assert r2.json()["error"]["code"] == "ADS_BOOST_ALREADY_PAUSED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_resume_pause_creates_three_rows_with_distinct_toggle_seq():
    """페드루 핀 그대로 — pause→resume→pause = 행 3(seq 1·2·3), 각각 1회 provider 호출
    (여기선 provider 호출 자체는 워커 몫이라 행 개수·seq만 pin, 실 Meta 호출은 범위 밖)."""
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_start = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/start")
            assert r_start.status_code == 201, r_start.text

            r_pause1 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
            assert r_pause1.status_code == 201, r_pause1.text
            assert r_pause1.json()["toggle_seq"] == 1
            async with Session() as s:
                await _mark_command_status(s, uuid.UUID(r_pause1.json()["command_id"]), "completed")

            r_resume = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/resume")
            assert r_resume.status_code == 201, r_resume.text
            assert r_resume.json()["toggle_seq"] == 2
            async with Session() as s:
                await _mark_command_status(s, uuid.UUID(r_resume.json()["command_id"]), "completed")

            r_pause2 = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
            assert r_pause2.status_code == 201, r_pause2.text
            assert r_pause2.json()["toggle_seq"] == 3

        command_ids = {
            r_pause1.json()["command_id"], r_resume.json()["command_id"], r_pause2.json()["command_id"],
        }
        assert len(command_ids) == 3, "pause→resume→pause는 서로 다른 3개 행이어야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
