"""story #3806(Phase3·3-2 PR 13, 페드루 PO 確定 2026-09-11 19:58Z) — 「명령 사슬
정체성」 결함. 라이브 재측 中 PO 발견: 감액 재봉인(approved 상태에서 낮은 예산으로
재요청 — `ads_boost.py::request_ads_boost`가 매 재봉인마다 `gate.sealed_ads_
boost_version_id`를 새 UUID로 갱신)이 일어난 뒤엔, 이미 실행 중(run.status=
"running")인 boost의 사람 「중지」 버튼이 409(`ADS_BOOST_NOT_STARTED`)로 죽고,
상한 도달 자동 중지(`_enforce_spend_cap`)도 같은 예외를 조용히 삼켜(pass) pause
명령을 아예 못 만든다 — 광고가 상한을 넘겨도 안 멈춘다.

근본원인: `_request_toggle`의 `started` 조회·`_latest_toggle`이 `(destination,
approved_version)`으로 스코프돼 있는데, `approved_version`은 재봉인마다 바뀌는
반면 실제 boost_start 명령 행은 최초 실행 당시의 (이제는 낡은) approved_version에
그대로 박혀 있다 — "재봉인해도 실행 중 run은 하나"라는 불변식을 approved_version이
못 담는다. 처방: 이 두 조회를 `gate_id`(PublicationCommand 자체 컬럼, 재봉인과
무관하게 안정)로 스코프한다.

이 파일은 먼저 **현재(수정 전) 코드에서 RED임을 고정**한 뒤(PO 明示 요청 — 재현
먼저), 수정 뒤 GREEN으로 전환한다."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3806_ads_boost_gate import _approve_gate, _boost_body, _client_for, _setup, _setup_org_scoped_app
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


async def _start_reapprove_and_reseal(*, initial_budget_minor, resealed_budget_minor):
    """게이트 생성→승인→시작(실행 完, v1 approved_version)→감액 재봉인(pending
    재오픈+v2 발급)→재승인(approved 복귀, v2 그대로). 반환: (engine, Session,
    org_id, owner_id, gate_id)."""
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, pub, _work_item_id, ad_conn_id = await _setup(
        await _session_factory(),
    )

    from app.main import app

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r1 = await client.post(
            f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
            json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=initial_budget_minor),
        )
    assert r1.status_code == 201, r1.text
    gate_id = uuid.UUID(r1.json()["gate_id"])
    app.dependency_overrides.clear()

    async with Session() as s:
        await _approve_gate(s, gate_id, owner_id)

    await _start_boost(Session, org_id, gate_id, owner_id)

    # 감액 재봉인 — request_ads_boost가 approved→pending 재오픈+새 sealed_ads_
    # boost_version_id 발급(이 결함의 원인 그 자체).
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r2 = await client.post(
            f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
            json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=resealed_budget_minor),
        )
    assert r2.status_code == 201, r2.text
    assert uuid.UUID(r2.json()["gate_id"]) == gate_id
    app.dependency_overrides.clear()

    async with Session() as s:
        await _approve_gate(s, gate_id, owner_id)  # 재승인 — PO 라이브 회차와 동형.

    return engine, Session, org_id, owner_id, gate_id


@pytest.mark.anyio
async def test_human_pause_after_reseal_returns_201_not_409():
    """PO 라이브 재현(19:54Z) — 실행 중 boost를 감액 재봉인한 뒤 「중지」를 누르면
    409 ADS_BOOST_NOT_STARTED가 뜬다(실은 실행 중인데). 수정 뒤엔 201이어야 한다."""
    from app.main import app

    engine, Session, org_id, owner_id, gate_id = await _start_reapprove_and_reseal(
        initial_budget_minor=100_000, resealed_budget_minor=90_000,
    )
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/pause")
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_scheduler_cap_pause_after_reseal_actually_pauses_the_run():
    """PO 라이브 재현 — 감액 재봉인 뒤 상한 도달 자동 중지가 AdsBoostNotStartedError를
    조용히 삼켜(pass) pause 명령을 못 만들고, 광고가 상한을 넘겨도 계속 돈다. 수정
    뒤엔 명령이 생성되고, 다음 tick 실행 뒤 run.status가 paused여야 한다."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session, org_id, owner_id, gate_id = await _start_reapprove_and_reseal(
        initial_budget_minor=100_000, resealed_budget_minor=10_000,
    )
    try:
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["capped"] == 1, counts

        async with Session() as s:
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
            assert run.cap_reached_at is not None
            pause_cmd = (await s.execute(
                select(PublicationCommand).where(
                    PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE,
                )
            )).scalar_one_or_none()
        assert pause_cmd is not None, "감액 재봉인 뒤에도 상한 도달 pause 명령이 생성돼야 한다"

        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        async with Session() as s:
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
        assert run.status == "paused", "pause 명령이 실행되면 run이 실제로 멈춰야 한다"
    finally:
        await engine.dispose()
