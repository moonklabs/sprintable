"""story #3806(Phase3·3-2 PR 6, 페드루 PO 確定 2026-09-11 13:27Z) —
`ads_boost_execution.py::process_due_ads_boost_starts`가 실제로 `/publication-
commands` cron tick에 배선됐는지(신규 엔드포인트 0, 피기백)와 그 축의 예외가
다른 축 카운트를 오염시키지 않는지(3527 comment_collections 선례와 동형 격리).

세팅 헬퍼는 test_3806_ads_boost_gate.py·test_3527_comment_collection_cron_wiring.py
와 동형 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

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


@pytest.mark.anyio
async def test_cron_tick_starts_due_ads_boost_via_worker_db(monkeypatch):
    """AC — tick 호출 → due 지난 승인 ads_boost 게이트가 boost_start command를
    받는다(카운트로 확認, 되돌리면 test_3806_ads_boost_starts_worker.py의 단위
    테스트들이 이미 RED — 여기선 "cron 엔드포인트가 이 함수를 실제로 부르는가"
    배선만 겨눈다)."""
    import app.routers.cron as cron_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport
    from sqlalchemy import select
    from app.models.publication_command import PublicationCommand

    from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
    from tests.test_3475_publishing_metrics import _seed_human, _client_for, _setup_org_scoped_app
    from tests.test_3497_insight_snapshots import _seed_channel_connection
    from tests.test_3806_ads_boost_gate import _seed_publication, _boost_body, _approve_gate, _seed_default_role

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    engine, Session = await _session_factory()
    try:
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
                json=_boost_body(ad_connection_id=ad_conn.id, hours_from_now=-1),
            )
        assert r.status_code == 201, r.text
        gate_id = uuid.UUID(r.json()["gate_id"])
        app.dependency_overrides.clear()

        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)

        async def _worker_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_worker_db] = _worker_db
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r = await client.post(
                "/api/v2/internal/cron/publication-commands",
                headers={"Authorization": "Bearer test-cron-secret"},
            )
        assert r.status_code == 200, r.text
        body = r.json()["data"]
        assert body["ads_boost_starts"]["started"] == 1, body

        async with Session() as s:
            command = (await s.execute(
                select(PublicationCommand).where(
                    PublicationCommand.gate_id == gate_id, PublicationCommand.operation == "boost_start",
                )
            )).scalar_one_or_none()
        assert command is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_ads_boost_starts_exception_does_not_corrupt_other_axes_counts(monkeypatch):
    """test_3527_comment_collection_cron_wiring.py::test_cron_comment_collection_
    exception_does_not_corrupt_other_axes_counts와 동형 — ads_boost_starts 축
    예외가 publication_commands 카운트를 오염시키지 않는다(독립 try 격리 확認)."""
    import app.routers.cron as cron_module
    import app.services.ads_boost_execution as ads_boost_execution_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport

    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    async def _boom(*args, **kwargs):
        raise RuntimeError("ads boost starts boom(테스트 주입)")

    monkeypatch.setattr(ads_boost_execution_module, "process_due_ads_boost_starts", _boom)

    engine, Session = await _session_factory()
    try:
        async def _worker_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_worker_db] = _worker_db
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r = await client.post(
                "/api/v2/internal/cron/publication-commands",
                headers={"Authorization": "Bearer test-cron-secret"},
            )
        assert r.status_code == 200, r.text
        body = r.json()["data"]
        assert body["ads_boost_starts"] == {"error": "unhandled"}
        assert body["completed"] == 0 and body["error"] == 0, (
            "ads_boost_starts 축 예외가 publication_commands 카운트 필드까지 오염시켰다"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
