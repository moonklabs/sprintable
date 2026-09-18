"""story #3813(Phase3·3-4 PR3, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송 결과
(opens/delivered) 캡처. 새 워커 신설 0 — 기존 `schedule_insight_snapshots`
(1d/7d 관례)를 「발행」이 아니라 「발송 완료」 시점에 부르도록 앵커만 옮긴다
(channel_posts.py 자체 발견: 발행 시점에 예약하면 발송 前에 재는 오차가 생김).
세팅 헬퍼는 test_3813_newsletter_send_gate.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory, _seed_default_role, _seed_agent
from tests.test_3475_publishing_metrics import _seed_human, _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_gate import _approve_gate, _seed_publication
from tests.test_f8f7cb0f_channel_post_publish import (
    _approve_gate_directly, _seed_connection as _seed_oauth_connection, _seed_story,
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


@pytest.fixture(autouse=True)
def _register_stibee_sandbox(monkeypatch):
    """`stibee_sandbox`는 CHANNEL_ADAPTERS의 SANDBOX_CHANNEL_ENABLED 조건부 블록
    안에 등재된다(test_3813_stibee_esp_connection.py 선례와 동형) — 모듈이 이미
    import된 뒤라 딕셔너리에 직접 주입한다. 단 이 PR(PR3)은 `insight_metrics`를
    읽는 첫 소비처라 PR1 테스트의 스텁(insight_metrics 없음)을 그대로 재사용하면
    안 되고, channel_adapters.py:657 실물 등재값(opens·delivered·clicks)과 동형
    으로 맞춘다 — 스텁과 실물이 갈리면 이 테스트가 실물 배선 갭을 못 잡는다."""
    import app.services.channel_adapters as adapters_mod

    stibee_sandbox_cfg = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="",
        refresh_mode="manual", credential_kind="none", display_name="Stibee Sandbox", kind="social",
        insight_metrics=("opens", "delivered", "clicks"),
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "stibee_sandbox", stibee_sandbox_cfg)
    yield


@pytest.fixture(autouse=True)
def _enable_sandbox_adapter(monkeypatch):
    """대조군(비-뉴스레터 채널) 실험용 — test_3497_insight_snapshots.py의 선례와
    동형. "threads"는 실 HTTP 호출을 타 목(mock) 없이는 쓸 수 없어, 발행 시점
    스냅샷 예약 억제 여부를 확인하는 대조군으로는 이미 이 레포에 확립된
    "sandbox"(신규 HTTP 0)를 쓴다."""
    import app.services.channel_adapters as adapters_mod

    sandbox_config = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="sandbox_publish,sandbox_delete",
        refresh_mode="manual", display_name="Sandbox", credential_kind="none", max_text_length=500,
        utm_source="sandbox", utm_medium="test", supports_unpublish=True,
        unpublish_required_scope="sandbox_delete",
        image_formats=("image/jpeg", "image/png"), image_max_bytes=8 * 1024 * 1024,
        image_aspect_max=10.0, image_width_min=320, image_width_max=1440,
        image_color_space="sRGB", image_max_count=1,
        insight_metrics=("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions"),
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "sandbox", sandbox_config)
    yield


def _send_body(*, segment_name="전체 구독자", hours_from_now=1):
    return {
        "segment_name": segment_name,
        "scheduled_at": (datetime.now(timezone.utc) + timedelta(hours=hours_from_now)).isoformat(),
    }


def test_normalized_keys_include_opens_and_delivered():
    from app.services.insight_snapshots import NORMALIZED_KEYS

    assert "opens" in NORMALIZED_KEYS
    assert "delivered" in NORMALIZED_KEYS
    # clicks는 기존 7키에 이미 있다 — 새로 안 만들었는지 회귀(중복 방지).
    assert NORMALIZED_KEYS.count("clicks") == 1


@pytest.mark.anyio
async def test_publishing_stibee_campaign_does_not_schedule_insight_snapshot():
    """자체발견 처방 회귀 — 「발행」(캠페인 생성) 시점엔 스냅샷을 안 연다(발송
    前에 재는 오차 방지). 다른 채널(sandbox)은 그대로 예약되는 대조군도 같이 확認."""
    from app.main import app
    from app.models.insight_snapshot import InsightSnapshot
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            stibee_connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")
            control_connection_id = await _seed_oauth_connection(s, org_id, channel="sandbox")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)

        async def _publish(connection_id, text):
            async with _client_for(app) as client:
                r_draft = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": text},
                )
                assert r_draft.status_code == 201, r_draft.text
                draft_id = r_draft.json()["draft_id"]
                r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
                gate_id = uuid.UUID(r_submit.json()["gate_id"])
            async with Session() as s:
                await _approve_gate_directly(s, gate_id)
            async with _client_for(app) as client:
                r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r_publish.status_code == 200, r_publish.text
            return uuid.UUID(r_publish.json()["version_id"])

        stibee_version_id = await _publish(stibee_connection_id, "뉴스레터 캠페인 본문")
        control_version_id = await _publish(control_connection_id, "일반 채널 포스트")

        from app.models.channel_publication import ChannelPublication

        async with Session() as s:
            stibee_pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.version_id == stibee_version_id)
            )).scalar_one()
            control_pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.version_id == control_version_id)
            )).scalar_one()

            stibee_snapshots = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == stibee_pub.id)
            )).scalars().all()
            control_snapshots = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == control_pub.id)
            )).scalars().all()

        assert stibee_snapshots == [], "stibee 캠페인 발행 시점엔 스냅샷이 예약되면 안 된다"
        assert len(control_snapshots) == 2, "대조군(sandbox)은 그대로 1d/7d 예약돼야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_send_completion_schedules_insight_snapshots_1d_7d():
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.models.insight_snapshot import InsightSnapshot
    from app.models.publication_command import PublicationCommand
    from app.services.newsletter_send_execution import process_due_newsletter_sends, process_one_newsletter_send_command
    from sqlalchemy import select, update

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "뉴스레터 본문"},
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        async with _client_for(app) as client:
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        version_id = uuid.UUID(r_publish.json()["version_id"])

        async with Session() as s:
            publication = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.version_id == version_id)
            )).scalar_one()
            publication_id = publication.id

        async with _client_for(app) as client:
            r_send = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{publication_id}/newsletter-sends",
                json=_send_body(),
            )
        send_gate_id = uuid.UUID(r_send.json()["gate_id"])

        async with Session() as s:
            await _approve_gate(s, send_gate_id, human_id)
            await s.execute(
                update(Gate).where(Gate.id == send_gate_id).values(
                    sealed_newsletter_scheduled_at=datetime.now(timezone.utc) - timedelta(minutes=1),
                )
            )
            await s.commit()
            await process_due_newsletter_sends(s)
            await s.commit()

        async with Session() as s:
            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == send_gate_id, PublicationCommand.operation == "send")
            )).scalar_one()
            before = datetime.now(timezone.utc)
            await process_one_newsletter_send_command(s, command, now=before)
            await s.commit()
            assert command.status == "completed", command.last_error

        async with Session() as s:
            snapshots = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == publication_id)
            )).scalars().all()
            assert len(snapshots) == 2, snapshots
            due_deltas = sorted((row.due_at - before) for row in snapshots)
            assert timedelta(hours=23) < due_deltas[0] < timedelta(hours=25), due_deltas[0]
            assert timedelta(days=6, hours=23) < due_deltas[1] < timedelta(days=7, hours=1), due_deltas[1]
            assert all(row.channel == "stibee_sandbox" for row in snapshots)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_captured_stibee_sandbox_snapshot_has_fixed_opens_delivered_clicks():
    from app.main import app
    from app.models.channel_publication import ChannelPublication
    from app.models.gate import Gate
    from app.models.insight_snapshot import InsightSnapshot
    from app.models.publication_command import PublicationCommand
    from app.services.insight_snapshots import process_due_insight_snapshots
    from app.services.newsletter_send_execution import process_due_newsletter_sends, process_one_newsletter_send_command
    from sqlalchemy import select, update

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "뉴스레터 본문"},
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
        async with Session() as s:
            await _approve_gate_directly(s, gate_id)
        async with _client_for(app) as client:
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        version_id = uuid.UUID(r_publish.json()["version_id"])

        async with Session() as s:
            publication_id = (await s.execute(
                select(ChannelPublication.id).where(ChannelPublication.version_id == version_id)
            )).scalar_one()

        async with _client_for(app) as client:
            r_send = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{publication_id}/newsletter-sends",
                json=_send_body(),
            )
        send_gate_id = uuid.UUID(r_send.json()["gate_id"])

        now = datetime.now(timezone.utc)
        async with Session() as s:
            await _approve_gate(s, send_gate_id, human_id)
            await s.execute(
                update(Gate).where(Gate.id == send_gate_id).values(sealed_newsletter_scheduled_at=now - timedelta(minutes=1))
            )
            await s.commit()
            await process_due_newsletter_sends(s)
            await s.commit()
        async with Session() as s:
            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == send_gate_id, PublicationCommand.operation == "send")
            )).scalar_one()
            await process_one_newsletter_send_command(s, command, now=now)
            await s.commit()

        fake_now = now + timedelta(days=1, minutes=1)

        # +1일 뒤로 가짜 시각을 전진시켜 첫 캡처만 due로 만든다(3809 PR4a 선례 —
        # due_at을 되미는 헬퍼 대신 now를 전진).
        async with Session() as s:
            counts = await process_due_insight_snapshots(s, now=fake_now)
        assert counts["captured"] == 1, counts

        async with Session() as s:
            captured = (await s.execute(
                select(InsightSnapshot).where(
                    InsightSnapshot.publication_id == publication_id, InsightSnapshot.status == "captured",
                )
            )).scalar_one()
            assert captured.normalized["opens"] == 1_200
            assert captured.normalized["delivered"] == 4_200
            assert captured.normalized["clicks"] == 300
            for key in ("impressions", "reach", "views", "engagements", "spend", "conversions"):
                assert captured.normalized[key] is None, f"{key}는 stibee_sandbox 미선언이라 null이어야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_real_stibee_fetch_populates_delivered_leaves_opens_null(monkeypatch):
    """story #3813 PR5-b(페드루 PO 確定 2026-09-12) — 실 stibee(sandbox 아님) 발송
    결과 캡처. `stibee_client.fetch_send_result`를 monkeypatch(실 네트워크 0)해
    `_fetch_for_snapshot` 디스패치가 실제로 도달하는지·정규화가 delivered만
    채우고 opens는 null로 남기는지(actionName 미확認, 지어내지 않는다) 확認."""
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import _fetch_for_snapshot
    from app.services.channel_credential_crypto import encrypt_channel_credential

    captured_call = {}

    async def _fake_fetch_send_result(client, *, api_key, email_id):
        captured_call["api_key"] = api_key
        captured_call["email_id"] = email_id
        return {"counts": {"DELIVERED": 4200, "SOME_UNKNOWN_ACTION": 800}, "delivered": 4200, "opens": None, "truncated": False}

    import app.services.stibee_client as stibee_client_module
    monkeypatch.setattr(stibee_client_module, "fetch_send_result", _fake_fetch_send_result)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            conn = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="stibee", account_id="default",
                account_label="777", credential_kind="pasted_secret", status="active",
                refresh_mode="manual", encrypted_access_token=encrypt_channel_credential("real-key"),
            )
            s.add(conn)
            await s.commit()
            pub = ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=uuid.uuid4(),
                connection_id=conn.id, channel="stibee", status="published", external_id="9999",
                published_at=datetime.now(timezone.utc),
            )
            s.add(pub)
            await s.commit()
            snapshot = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, publication_kind="channel_publication",
                work_item_id=uuid.uuid4(), channel="stibee", due_at=datetime.now(timezone.utc), status="pending",
            )
            s.add(snapshot)
            await s.commit()

            result = await _fetch_for_snapshot(s, snapshot)

        assert captured_call["api_key"] == "real-key"
        assert captured_call["email_id"] == 9999
        assert result["values"] == {"delivered": 4200}
        assert "opens" not in result["values"], "opens는 미확認이라 values에 아예 없어야 한다(_normalize가 null로 처리)"
        assert result["raw"]["counts"] == {"DELIVERED": 4200, "SOME_UNKNOWN_ACTION": 800}
    finally:
        await engine.dispose()
