"""story #3813(Phase3·3-4 PR4, 페드루 PO 確定 2026-09-12) — 뉴스레터 캘린더/승인
카드 표면. 세팅 헬퍼는 test_3813_newsletter_send_gate.py·test_3806_ads_boost_gate.py
와 동형(중복 재발명 금지).

계약 3축:
① `GET .../channel-posts/drafts` 응답의 `newsletter` 하위 객체(subject·segment_name·
   send_scheduled_at) — 뉴스레터 채널이 아니면 null(discriminator는 이미 있는
   `channel`, content_kind류 신규 필드 0).
② 캘린더 스케줄 축(`scheduled_at`, 필터 scheduled_from/to·unscheduled 전부) —
   newsletter_send 게이트 봉인 前=external_publish 게이트의 발행 예정, 봉인 뒤=
   그 게이트의 발송 예정으로 COALESCE.
③ 승인 카드(`GET /gates/{id}`)의 `estimated_recipient_count` — sandbox=고정
   4,200·실 stibee=미구현이라 null·조회 실패도 카드 전체를 안 죽이고 null.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory, _seed_default_role, _seed_agent
from tests.test_3475_publishing_metrics import _seed_human, _client_for, _setup_org_scoped_app
from tests.test_3806_ads_boost_gate import _seed_publication
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


async def _seed_newsletter_send_gate(
    session, *, org_id, work_item_id, publication_id, status="approved",
    segment_name="전체 구독자", scheduled_at=None, resolver_id=None,
):
    """PR2가 만든 `newsletter_send` 게이트를 실 HTTP 플로우 없이 직접 심는다(승인
    카드·캘린더 축 단위 테스트는 발송 실행까지 안 밟아도 되므로 test_3813_newsletter_
    send_gate.py의 전체 왕복과 달리 최단 경로로 구성)."""
    from app.models.gate import Gate

    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        gate_type="newsletter_send", scope_key=str(publication_id), status=status,
        sealed_newsletter_segment_name=segment_name, sealed_newsletter_scheduled_at=scheduled_at,
        sealed_newsletter_version_id=uuid.uuid4(), resolver_id=resolver_id,
        resolved_at=datetime.now(timezone.utc) if status == "approved" else None,
    )
    session.add(gate)
    await session.commit()
    return gate


@pytest.mark.anyio
async def test_draft_list_newsletter_object_present_for_stibee_null_for_others():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            stibee_connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")
            control_connection_id = await _seed_oauth_connection(s, org_id, channel="sandbox")
            story_id = await _seed_story(s, org_id, project_id)
            control_story_id = await _seed_story(s, org_id, project_id, title="대조군")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r_stibee = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(stibee_connection_id),
                    "text": "이번 달 소식", "channel_payload": {"subject": "9월 소식지"},
                },
            )
            assert r_stibee.status_code == 201, r_stibee.text
            r_control = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(control_story_id), "connection_id": str(control_connection_id), "text": "일반 포스트"},
            )
            assert r_control.status_code == 201, r_control.text

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            assert r_list.status_code == 200, r_list.text
        items = {item["draft_id"]: item for item in r_list.json()}
        stibee_item = items[r_stibee.json()["draft_id"]]
        control_item = items[r_control.json()["draft_id"]]

        assert stibee_item["newsletter"] == {
            "subject": "9월 소식지", "segment_name": None, "send_scheduled_at": None, "campaign_scheduled_at": None,
        }
        assert control_item["newsletter"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_calendar_schedule_axis_moves_from_publish_window_to_send_window_after_seal():
    """PO 자 — 봉인 前엔 발행(캠페인 생성) 예정 창에 뜨고, newsletter_send 게이트가
    봉인된 뒤엔 그 발송 예정 창으로 옮겨간다(같은 draft, scheduled_at 값 자체가
    바뀐 것처럼 캘린더에 보여야 한다)."""
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select, update

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        # 즉시 발행(campaign 생성) — scheduled_at을 submit에 실어 실제로 예약발행
        # 워커 경로를 밟게 하면 ChannelPublication이 동기로 안 생겨 테스트가 그
        # 비동기 시점까지 신경 써야 한다(이 테스트의 관심사가 아님). 대신 즉시
        # 발행 뒤 gate.sealed_scheduled_at을 직접 세팅해 "그 게이트가 예약 시각을
        # 봉인하고 있는" 상태만 재현 — COALESCE 로직 자체가 관심사.
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "발송 예정 소식", "channel_payload": {"subject": "발송 예정 소식지"},
                },
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        async with _client_for(app) as client:
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r_publish.status_code == 200, r_publish.text
        version_id = uuid.UUID(r_publish.json()["version_id"])

        from app.models.channel_publication import ChannelPublication

        publish_scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
        async with Session() as s:
            publication = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.version_id == version_id)
            )).scalar_one()
            await s.execute(update(Gate).where(Gate.id == gate_id).values(sealed_scheduled_at=publish_scheduled_at))
            await s.commit()

        # ── 양성① 봉인 前: 발행 예정 창(publish_scheduled_at ±1h)에 뜬다 ──
        window_from = publish_scheduled_at - timedelta(hours=1)
        window_to = publish_scheduled_at + timedelta(hours=1)
        async with _client_for(app) as client:
            r_before = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={"scheduled_from": window_from.isoformat(), "scheduled_to": window_to.isoformat()},
            )
        assert r_before.status_code == 200, r_before.text
        assert draft_id in {item["draft_id"] for item in r_before.json()}, "봉인 前엔 발행 예정 창에 떠야 한다"

        send_scheduled_at = datetime.now(timezone.utc) + timedelta(days=7)
        async with Session() as s:
            await _seed_newsletter_send_gate(
                s, org_id=org_id, work_item_id=story_id, publication_id=publication.id,
                status="approved", segment_name="전체 구독자", scheduled_at=send_scheduled_at,
                resolver_id=human_id,
            )

        # ── 양성② 봉인 뒤: 이제 옛 발행 예정 창엔 안 뜨고(발송 예정으로 옮겨감) ──
        async with _client_for(app) as client:
            r_after_old_window = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={"scheduled_from": window_from.isoformat(), "scheduled_to": window_to.isoformat()},
            )
        assert r_after_old_window.status_code == 200, r_after_old_window.text
        assert draft_id not in {item["draft_id"] for item in r_after_old_window.json()}, (
            "봉인 뒤엔 옛 발행 예정 창에서 빠져야 한다(발송 예정으로 옮겨감)"
        )

        send_window_from = send_scheduled_at - timedelta(hours=1)
        send_window_to = send_scheduled_at + timedelta(hours=1)
        async with _client_for(app) as client:
            r_after_new_window = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={"scheduled_from": send_window_from.isoformat(), "scheduled_to": send_window_to.isoformat()},
            )
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_after_new_window.status_code == 200, r_after_new_window.text
        assert draft_id in {item["draft_id"] for item in r_after_new_window.json()}, "봉인 뒤엔 발송 예정 창에 떠야 한다"
        assert r_detail.json()["scheduled_at"] == send_scheduled_at.isoformat().replace("+00:00", "+00:00")
        assert r_detail.json()["newsletter"]["send_scheduled_at"] is not None
        # 자체발견(라이브 데모 실측 2026-09-12) — 최상위 scheduled_at이 발송 예정으로
        # 넘어간 뒤에도 캠페인 만들기 예정 시각(external_publish 게이트 자신의
        # sealed_scheduled_at)이 이 필드로 계속 남아야 한다(두 시각 동시 노출).
        assert r_detail.json()["newsletter"]["campaign_scheduled_at"] == publish_scheduled_at.isoformat()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_non_newsletter_channel_unaffected_by_schedule_axis_change():
    """음성대조 — 뉴스레터가 아닌 채널은 이 PR의 새 조인·COALESCE 경로를 타도 결과가
    기존과 완전히 같다(회귀 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            connection_id = await _seed_oauth_connection(s, org_id, channel="sandbox")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "일반 포스트"},
            )
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"scheduled_at": scheduled_at.isoformat()},
            )
            assert r_submit.status_code == 200, r_submit.text

        async with _client_for(app) as client:
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        assert r_detail.status_code == 200, r_detail.text
        assert r_detail.json()["scheduled_at"] == scheduled_at.isoformat()
        assert r_detail.json()["newsletter"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approval_card_estimated_recipient_count_sandbox_fixed_value():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
            pub, work_item_id = await _seed_publication(s, org_id=org_id, connection_id=connection_id, channel="stibee_sandbox", work_item_id=story_id)
            gate = await _seed_newsletter_send_gate(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                status="approved", segment_name="VIP 세그먼트", resolver_id=human_id,
            )
            # 페드루 PO CHANGES(2026-09-12, 라이브 캡처 실측) — 승인 카드에 subject가
            # 없어 사람이 「무엇을」 보내는지 못 보고 승인하던 결함. subject는 봉인 축이
            # 아니라 publication.version_id가 가리키는 ChannelPostVersion.channel_payload
            # 에서 「지금」 값을 읽는다 — 여기서 직접 채운다.
            from app.models.channel_post_version import ChannelPostVersion
            from sqlalchemy import update

            await s.execute(
                update(ChannelPostVersion).where(ChannelPostVersion.id == pub.version_id)
                .values(channel_payload={"subject": "9월 소식지"})
            )
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/gates/{gate.id}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["estimated_recipient_count"] == 4_200
        assert body["sealed_newsletter_segment_name"] == "VIP 세그먼트"
        assert body["newsletter_subject"] == "9월 소식지"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approval_card_estimated_recipient_count_null_for_real_stibee():
    """실 stibee는 아직 미구현이라(PO 明示) 「미확인」 그대로 — 지어내지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            connection_id = await _seed_oauth_connection(s, org_id, channel="stibee")
            story_id = await _seed_story(s, org_id, project_id)
            pub, work_item_id = await _seed_publication(s, org_id=org_id, connection_id=connection_id, channel="stibee", work_item_id=story_id)
            gate = await _seed_newsletter_send_gate(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                status="approved", resolver_id=human_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/gates/{gate.id}")
        assert r.status_code == 200, r.text
        assert r.json()["estimated_recipient_count"] is None
        # subject를 안 심었으면(channel_payload 미설정) 지어내지 않고 null.
        assert r.json()["newsletter_subject"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_approval_card_lookup_failure_does_not_crash_card(monkeypatch):
    """PO 明示 — 조회 실패 예외가 카드 전체를 죽이지 않고 null만 두고 계속(fail-closed,
    warning 로그로 흡수). describe_segment를 강제로 예외 던지게 몽키패치."""
    from app.main import app

    async def _boom(*, segment_name):
        raise RuntimeError("simulated adapter lookup failure")

    import app.services.stibee_sandbox_campaign as stibee_sandbox_campaign_module
    monkeypatch.setattr(stibee_sandbox_campaign_module, "describe_segment", _boom)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")
            story_id = await _seed_story(s, org_id, project_id)
            pub, work_item_id = await _seed_publication(s, org_id=org_id, connection_id=connection_id, channel="stibee_sandbox", work_item_id=story_id)
            gate = await _seed_newsletter_send_gate(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                status="approved", resolver_id=human_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/gates/{gate.id}")
        assert r.status_code == 200, r.text
        assert r.json()["estimated_recipient_count"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
