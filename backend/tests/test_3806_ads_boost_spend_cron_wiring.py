"""story #3806(Phase3·3-2 PR 11, 페드루 PO 確定 2026-09-11 16:20Z) —
`ads_spend_snapshots.py::process_due_ads_spend_snapshots`가 실제로 `/publication-
commands` cron tick에 배선됐는지(신규 엔드포인트 0, 피기백) 확認. PR4가 이 함수를
만든 뒤 3-7 그라운딩 도중 자체발견된 배선 갭 — 이 함수는 만들어진 뒤 한 번도
프로덕션 cron 축에서 호출된 적이 없었다(테스트 직접호출만). test_3806_ads_boost_
starts_cron_wiring.py·test_3527_comment_collection_cron_wiring.py와 동형 구조."""
from __future__ import annotations

import os

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
async def test_cron_tick_captures_due_ads_spend_snapshot_via_worker_db(monkeypatch):
    """AC — tick 호출 → due 지난 paid 스냅샷이 캡처된다(카운트로 확認, 되돌리면
    test_3806_ads_boost_spend.py의 단위 테스트들이 이미 RED — 여기선 "cron
    엔드포인트가 이 함수를 실제로 부르는가" 배선만 겨눈다)."""
    import app.routers.cron as cron_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport

    from tests.test_e4fc29fa_site_post_orchestration import _session_factory
    from tests.test_3806_ads_boost_execution import _setup_approved_gate
    from tests.test_3806_ads_boost_spend import _start_boost, _make_spend_snapshots_due

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)

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
        # story #3809(PR 4a) — 최초 예약이 1건뿐이라(_start_boost 직후) 이 tick
        # 1회로는 캡처 1건만(다음 캡처는 그 자리서 이어 예약될 뿐 아직 안 due).
        assert body["ads_spend_snapshots"]["captured"] == 1, body
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_ads_spend_snapshots_exception_does_not_corrupt_other_axes_counts(monkeypatch):
    """test_3527_comment_collection_cron_wiring.py와 동형 — ads_spend_snapshots
    축 예외가 publication_commands 카운트를 오염시키지 않는다(독립 try 격리 확認)."""
    import app.routers.cron as cron_module
    import app.services.ads_spend_snapshots as ads_spend_snapshots_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport

    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    async def _boom(*args, **kwargs):
        raise RuntimeError("ads spend snapshots boom(테스트 주입)")

    monkeypatch.setattr(ads_spend_snapshots_module, "process_due_ads_spend_snapshots", _boom)

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
        assert body["ads_spend_snapshots"] == {"error": "unhandled"}
        assert body["completed"] == 0 and body["error"] == 0, (
            "ads_spend_snapshots 축 예외가 publication_commands 카운트 필드까지 오염시켰다"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
