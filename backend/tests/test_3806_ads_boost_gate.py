"""story #3806(Phase3·3-2 PR2, 페드루 PO 確定 2026-09-11) — Meta Ads boost 요청 +
`ads_boost` 게이트(봉인 5열)·「변경=재승인」·«자동 증액 불가»(422 ADS_BUDGET_EXCEEDS_SEAL,
봉인값 무변경) 회귀. 세팅 헬퍼는 test_e4fc29fa_site_post_orchestration·test_3475_
publishing_metrics·test_3620_publication_reconciliation과 동형(중복 재발명 금지) —
draft+version+publication 실 체인은 test_3620의 `_seed_sandbox_publication_with_
version_text` 패턴을 그대로 재사용."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _seed_org, _session_factory, _seed_default_role, _seed_agent,
)
from tests.test_3475_publishing_metrics import _seed_human, _client_for, _setup_org_scoped_app
from tests.test_3497_insight_snapshots import _seed_channel_connection

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


async def _seed_publication(session, *, org_id, connection_id, work_item_id=None, channel="threads"):
    """test_3620_publication_reconciliation.py::_seed_sandbox_publication_with_
    version_text와 동형 — 실 ChannelPostVersion+ChannelPostDraft를 심어 work_item_id
    해석이 실제 FK를 탄다(무작위 UUID로 얼버무리지 않음)."""
    from app.models.channel_post_draft import ChannelPostDraft
    from app.models.channel_post_version import ChannelPostVersion
    from app.models.channel_publication import ChannelPublication

    draft = ChannelPostDraft(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id or uuid.uuid4(),
        channel=channel, connection_id=connection_id,
    )
    session.add(draft)
    await session.commit()

    version = ChannelPostVersion(
        id=uuid.uuid4(), draft_id=draft.id, version=1, text="boost 대상 원문", body_sha256="deadbeef",
        author_member_id=uuid.uuid4(), author_kind="human",
    )
    session.add(version)
    await session.commit()

    pub = ChannelPublication(
        id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=version.id,
        connection_id=connection_id, channel=channel, status="published",
        external_id="media-1", published_at=datetime.now(timezone.utc),
    )
    session.add(pub)
    await session.commit()
    return pub, draft.work_item_id


def _boost_body(*, ad_connection_id, budget_minor=100_000, currency="KRW", objective="POST_ENGAGEMENT", hours_from_now=1):
    now = datetime.now(timezone.utc)
    return {
        "ad_connection_id": str(ad_connection_id),
        "budget_minor": budget_minor, "currency": currency, "objective": objective,
        "starts_at": (now + timedelta(hours=hours_from_now)).isoformat(),
        "ends_at": (now + timedelta(hours=hours_from_now, days=7)).isoformat(),
    }


async def _setup(session_factory_result, *, seed_role=True, ad_channel="ads_sandbox", ad_status="active"):
    engine, Session = session_factory_result
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_id = await _seed_human(s, org_id, role="owner")
        conn = await _seed_channel_connection(s, org_id, channel="threads")
        # 페드루 PO 追加 確定(2026-09-11) — boost는 원 발행물 연결(threads 등)과
        # 별개로 광고 계정 연결(meta_ads|ads_sandbox)을 명시 지정해야 한다.
        ad_conn = await _seed_channel_connection(s, org_id, channel=ad_channel, status=ad_status)
        if seed_role:
            await _seed_default_role(s, org_id)
        pub, work_item_id = await _seed_publication(s, org_id=org_id, connection_id=conn.id)
    return engine, Session, org_id, project_id, owner_id, pub, work_item_id, ad_conn.id


@pytest.mark.anyio
async def test_fresh_boost_creates_pending_gate_with_sealed_five():
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session, org_id, project_id, owner_id, pub, _, ad_conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts", json=_boost_body(ad_connection_id=ad_conn_id),
            )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["status"] == "pending"
        assert body["reapproval_required"] is False
        assert body["sealed_ads_connection_id"] == str(ad_conn_id)
        assert body["sealed_ads_budget_minor"] == 100_000
        assert body["sealed_ads_currency"] == "KRW"
        assert body["sealed_ads_objective"] == "POST_ENGAGEMENT"

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == uuid.UUID(body["gate_id"])))).scalar_one()
            assert gate.gate_type == "ads_boost"
            assert gate.status == "pending"
            assert gate.sealed_ads_boost_version_id is not None, "PR 3의 approved_version 축이 비어 있으면 안 된다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_key_gets_403():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, ad_conn_id = await _setup(await _session_factory())
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts", json=_boost_body(ad_connection_id=ad_conn_id),
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_CREATE_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_publication_returns_404():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, _pub, _, ad_conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{uuid.uuid4()}/boosts", json=_boost_body(ad_connection_id=ad_conn_id),
            )
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_PUBLICATION_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_publication_returns_same_404():
    """#3796 동형 원칙 — 타 org 소유 publication도 미존재와 동일 404(존재 비노출)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, _ = await _seed_org(s)
            owner_a = await _seed_human(s, org_a, role="owner")
            await _seed_default_role(s, org_a)
            ad_conn_a = await _seed_channel_connection(s, org_a, channel="ads_sandbox")
            org_b, _ = await _seed_org(s)
            conn_b = await _seed_channel_connection(s, org_b, channel="threads")
            pub_b, _ = await _seed_publication(s, org_id=org_b, connection_id=conn_b.id)

        _setup_org_scoped_app(app, Session, org_a, user_id=owner_a)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_a}/publications/{pub_b.id}/boosts",
                json=_boost_body(ad_connection_id=ad_conn_a.id),
            )
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_PUBLICATION_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_invalid_schedule_returns_422():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, ad_conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        body = _boost_body(ad_connection_id=ad_conn_id)
        body["ends_at"] = body["starts_at"]  # 시작=종료 → 무효
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts", json=body)
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_INVALID_SCHEDULE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approver_role_missing_returns_409():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, ad_conn_id = await _setup(await _session_factory(), seed_role=False)
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts", json=_boost_body(ad_connection_id=ad_conn_id),
            )
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_APPROVER_ROLE_MISSING"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_while_pending_same_or_lower_budget_reseals_in_place():
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session, org_id, project_id, owner_id, pub, _, ad_conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=100_000, objective="POST_ENGAGEMENT"),
            )
            assert r1.status_code == 201, r1.text
            gate_id = r1.json()["gate_id"]

            async with Session() as s:
                version_id_1 = (await s.execute(
                    select(Gate.sealed_ads_boost_version_id).where(Gate.id == uuid.UUID(gate_id))
                )).scalar_one()

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=80_000, objective="OUTCOME_ENGAGEMENT"),
            )
        assert r2.status_code == 201, r2.text
        body2 = r2.json()
        assert body2["gate_id"] == gate_id, "같은 publication 재요청은 같은 게이트 슬롯을 재사용해야 한다"
        assert body2["status"] == "pending"
        assert body2["reapproval_required"] is False
        assert body2["sealed_ads_budget_minor"] == 80_000
        assert body2["sealed_ads_objective"] == "OUTCOME_ENGAGEMENT"

        async with Session() as s:
            version_id_2 = (await s.execute(
                select(Gate.sealed_ads_boost_version_id).where(Gate.id == uuid.UUID(gate_id))
            )).scalar_one()
        assert version_id_2 != version_id_1, "재봉인마다 새 approved_version이 발급돼야 PR 3 idempotency 키가 갈린다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _approve_gate(session, gate_id: uuid.UUID, resolver_id: uuid.UUID):
    from app.models.gate import Gate, set_gate_status
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    set_gate_status(gate, "approved", now=datetime.now(timezone.utc))
    gate.resolver_id = resolver_id
    gate.resolved_at = datetime.now(timezone.utc)
    gate.requires_human = False
    await session.commit()


@pytest.mark.anyio
async def test_resubmit_while_approved_lower_budget_reopens_and_voids_pending_commands():
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    engine, Session, org_id, project_id, owner_id, pub, _, ad_conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=100_000),
            )
        assert r1.status_code == 201, r1.text
        gate_id = uuid.UUID(r1.json()["gate_id"])

        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
            # 승인된 게이트에 걸린 pending 명령 1건 — 재오픈 시 voided 확認 표본.
            # content_kind는 void_pending_commands_for_gate가 gate_id로만 걸러 무관하나,
            # ck_publication_commands_content_kind CHECK가 'ads_boost'를 아직 안 받아
            # (PR3에서 마이그 확장 예정, 이 PR 범위 밖) 기존 허용값을 그대로 쓴다.
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=pub.connection_id,
                approved_version=pub.version_id, operation="publish", content_kind="channel_post",
                status="pending", requested_by_member_id=owner_id,
            )
            s.add(cmd)
            await s.commit()
            cmd_id = cmd.id

        async with _client_for(app) as client:
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=90_000),
            )
        assert r2.status_code == 201, r2.text
        body2 = r2.json()
        assert body2["status"] == "pending", "승인 뒤 예산 변경은 재승인 대기로 되돌아가야 한다"
        assert body2["reapproval_required"] is True
        assert body2["sealed_ads_budget_minor"] == 90_000

        async with Session() as s:
            cmd_after = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == cmd_id)
            )).scalar_one()
            assert cmd_after.status == "voided", "재오픈 시 대기 중이던 명령이 voided로 전이해야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_higher_budget_returns_422_and_seal_unchanged_while_pending():
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session, org_id, project_id, owner_id, pub, _, ad_conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=100_000),
            )
            assert r1.status_code == 201, r1.text
            gate_id = uuid.UUID(r1.json()["gate_id"])

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=150_000),
            )
        assert r2.status_code == 422, r2.text
        detail = r2.json()["error"]
        assert detail["code"] == "ADS_BUDGET_EXCEEDS_SEAL"
        assert detail["sealed_budget_minor"] == 100_000
        assert detail["requested_budget_minor"] == 150_000

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.sealed_ads_budget_minor == 100_000, "거부된 증액 시도가 봉인값을 건드리면 안 된다"
            assert gate.status == "pending"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_higher_budget_while_approved_returns_422_and_gate_stays_approved():
    """자동 증액 불가는 pending뿐 아니라 approved 게이트에도 똑같이 걸려야 한다 —
    「승인된 예산을 몰래 더 올려 재상신」류 우회를 막는 게 이 규칙의 존재 이유."""
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session, org_id, project_id, owner_id, pub, _, ad_conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=100_000),
            )
        assert r1.status_code == 201, r1.text
        gate_id = uuid.UUID(r1.json()["gate_id"])

        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)

        async with _client_for(app) as client:
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=ad_conn_id, budget_minor=200_000),
            )
        assert r2.status_code == 422, r2.text
        assert r2.json()["error"]["code"] == "ADS_BUDGET_EXCEEDS_SEAL"

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "approved", "거부된 증액 시도가 승인 상태를 재오픈시키면 안 된다"
            assert gate.sealed_ads_budget_minor == 100_000
            assert gate.reapproval_required is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_ad_connection_id_returns_422():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, _ad_conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=uuid.uuid4()),
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_INVALID_AD_CONNECTION"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_wrong_channel_ad_connection_returns_422():
    """boost 대상 원 발행물의 threads 연결을 광고 계정으로 잘못 준 경우 — 채널
    축(meta_ads|ads_sandbox)이 아니면 존재/활성 여부와 무관하게 거부돼야 한다."""
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, _ad_conn_id = await _setup(await _session_factory())
    try:
        async with Session() as s:
            wrong_channel_conn = await _seed_channel_connection(s, org_id, channel="threads")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=wrong_channel_conn.id),
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_INVALID_AD_CONNECTION"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_inactive_ad_connection_returns_422():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, _ad_conn_id = await _setup(
        await _session_factory(), ad_status="expired",
    )
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=_ad_conn_id),
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_INVALID_AD_CONNECTION"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_ad_connection_returns_422():
    """타 org 소유 광고 계정 연결을 지정하면 — publication_not_found(404)과 달리
    이 필드는 호출자가 이미 자기 org 목록에서 고른 값이라는 전제가 있어(카드 예외
    docstring), IDOR 방지 목적의 404 은폐가 아니라 명시 422로 거부한다."""
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, _ad_conn_id = await _setup(await _session_factory())
    try:
        async with Session() as s:
            other_org_id, _ = await _seed_org(s)
            other_org_ad_conn = await _seed_channel_connection(s, other_org_id, channel="ads_sandbox")
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
                json=_boost_body(ad_connection_id=other_org_ad_conn.id),
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_INVALID_AD_CONNECTION"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
