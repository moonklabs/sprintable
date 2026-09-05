"""story #3478(Phase1·마케팅운영·설계갭, 페드루 PO 決定 2026-09-05) — external_publish
게이트 멱등 키에 `scope_key`(목적지) 축을 더한다. 그라운딩: `create_gate()`의 멱등키가
`(work_item_id, work_item_type, gate_type)`뿐이라 site_post가 같은 원문을 WordPress+
webhook 두 목적지로 상신·승인할 수 없었다(work_item당 1건) — channel_post도 100% 같은
제약을 진 공유 설계(story #3404/f6d14476)라, 두 도메인 다 같은 규칙으로 고친다.

세팅 헬퍼는 test_e4fc29fa_site_post_orchestration.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_e4fc29fa_site_post_orchestration import (
    _client_for,
    _create_and_submit_site_post_draft,
    _seed_agent,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _seed_webhook_connection,
    _seed_wordpress_connection,
    _session_factory,
    _setup_org_scoped_app,
    live_wordpress_stub,  # noqa: F401 — pytest fixture import
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


@pytest.mark.anyio
async def test_same_work_item_two_destinations_both_submit_and_approve():
    """(1) 양성대조·핵심 AC — 같은 work_item의 draft A(wordpress)·B(webhook) 둘 다
    상신 200·승인 가능(서로 다른 게이트, scope_key로 격리). #3478 이전엔 B의 상신이
    409 SITE_POST_GATE_ALREADY_HELD였다."""
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_wp = await _seed_wordpress_connection(s, org_id, site_url="https://a.example.com")
            connection_wh = await _seed_webhook_connection(
                s, org_id, target_url_builder=lambda cid: f"https://b.example.com/deliver/{cid}",
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_a, gate_a = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_wp, slug="dual-a",
            )
            draft_b, gate_b = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_wh, slug="dual-b",
            )
        assert gate_a != gate_b, "다른 목적지인데 같은 게이트를 공유했다 — scope_key 축이 안 먹은 것"

        async with Session() as s:
            gate_a_row = await transition_gate(s, org_id, gate_a, "approved", resolver_id=human_id)
            await s.commit()
            assert gate_a_row.status == "approved"
        async with Session() as s:
            gate_b_row = await transition_gate(s, org_id, gate_b, "approved", resolver_id=human_id)
            await s.commit()
            assert gate_b_row.status == "approved", "A 승인이 B의 상신·승인을 막지 않아야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_same_destination_second_slug_still_blocked_by_hold_guard():
    """(2) 부정대조 — 같은 work_item·같은 connection(목적지 동일)으로 slug만 다른
    draft 둘은 여전히 409로 막힌다(scope_key가 목적지 단위지 draft 단위가 아니다 —
    "무제한 분산"이 아니라 f6d14476 가드 자체는 유지)."""
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url="https://same.example.com")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_a, gate_a = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id, slug="same-dest-a",
            )
        async with Session() as s:
            await transition_gate(s, org_id, gate_a, "approved", resolver_id=human_id)
            await s.commit()

        async with _client_for(app) as client:
            r_draft_b = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "제목B", "slug": "same-dest-b",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문B", "media_manifest": [],
                    "connection_id": str(connection_id),
                },
            )
            assert r_draft_b.status_code == 201, r_draft_b.text
            draft_b_id = r_draft_b.json()["draft_id"]
            r_submit_b = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_b_id}/submit", json={})
        assert r_submit_b.status_code == 409, r_submit_b.text
        assert r_submit_b.json()["error"]["code"] == "SITE_POST_GATE_ALREADY_HELD"
        assert r_submit_b.json()["error"]["holding_draft_id"] == str(draft_a)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublished_gate_releases_hold_for_resubmit_same_destination(live_wordpress_stub):
    """(3) 페드루 決定③ — 발행 완료 뒤 회수(unpublish)하면 그 게이트는 더 이상 "쥐고
    있다"로 안 본다. 같은 목적지로 다른 draft를 상신하면 200(재발행 자체는 그 draft의
    새 승인이 원칙 — 옛 게이트를 재사용하지 않는다, 봉인 원칙 유지)."""
    from app.services.gate_service import transition_gate
    from app.services.publication_command import process_due_publication_commands
    from app.services.site_posts import request_site_post_external_unpublish
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_wordpress_connection(s, org_id, site_url=live_wordpress_stub)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_a, gate_a = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_id, slug="release-a",
            )
        async with Session() as s:
            await transition_gate(s, org_id, gate_a, "approved", resolver_id=human_id)
            await s.commit()
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        # draft B(같은 목적지) 상신 — A가 아직 "살아 있다"(unpublish 前)면 409.
        async with _client_for(app) as client:
            r_draft_b = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "제목B", "slug": "release-b",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문B", "media_manifest": [],
                    "connection_id": str(connection_id),
                },
            )
            draft_b_id = r_draft_b.json()["draft_id"]
            r_submit_b_before = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_b_id}/submit", json={},
            )
        assert r_submit_b_before.status_code == 409, r_submit_b_before.text

        # A를 회수(unpublish) — 워커까지 실행해 channel_publications.status를 실제로 바꾼다.
        async with Session() as s:
            await request_site_post_external_unpublish(
                s, org_id=org_id, draft_id=draft_a, requested_by_member_id=human_id,
            )
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts

        # 이제 B 상신은 200이어야 한다(A의 승인이 더 이상 "실려 있지" 않다).
        async with _client_for(app) as client:
            r_submit_b_after = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_b_id}/submit", json={},
            )
        assert r_submit_b_after.status_code == 200, r_submit_b_after.text
        # 봉인 원칙 — 게이트 "행"은 create_gate()의 기존 멱등 관례대로 재사용될 수
        # 있다(#3478이 그 관례를 안 바꾼다). 진짜 보장은 "옛 승인을 그대로 밀수출하지
        # 않는다" — B의 상신이 새 pending 사이클을 열어야 한다(A의 approved를 그대로
        # 재사용해 B가 무단으로 승인된 것처럼 보이면 안 된다).
        assert r_submit_b_after.json()["status"] == "pending", (
            "재상신이 A의 옛 approved 상태를 그대로 물려받았다 — 새 승인 사이클이 안 열린 것"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_two_connections_same_work_item_both_succeed():
    """(4) channel_post 회귀 — 같은 work_item·다른 connection 둘 다 상신 200(그라운딩
    대조: channel_post도 site_post와 100% 같은 공유 설계, 드리프트 0으로 같이 해소).
    channel_posts.py 쪽 전용 상세 테스트는 test_3404_channel_post_gate_already_held.py
    ::test_second_draft_submit_different_connection_both_succeed가 이미 잰다 — 여기선
    site_post·channel_post 교차 회귀(별개 도메인이 서로의 게이트에 안 닿는지)만 잰다."""
    from app.services.gate_service import transition_gate
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_user_id, human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_wp = await _seed_wordpress_connection(s, org_id, site_url="https://x.example.com")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            draft_a, gate_a = await _create_and_submit_site_post_draft(
                client, org_id=org_id, story_id=story_id, connection_id=connection_wp, slug="cross-a",
            )

        # 같은 work_item에 channel_post(Threads) draft도 만들어 submit — site_post의
        # 게이트를 안 건드려야 한다(다른 gate_type이라도 scope_key 축이 뒤섞이면 안 된다).
        async with Session() as s:
            from app.models.channel_connection import ChannelConnection
            from app.services.channel_credential_crypto import encrypt_channel_credential

            conn = ChannelConnection(
                id=uuid.uuid4(), org_id=org_id, channel="threads", account_id="acct-cross",
                status="active", credential_kind="oauth", refresh_mode="manual",
                encrypted_access_token=encrypt_channel_credential("token-abc"),
            )
            s.add(conn)
            await s.commit()
            channel_conn_id = conn.id

        async with _client_for(app) as client:
            r_cp_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(channel_conn_id), "text": "채널포스트 본문"},
            )
            assert r_cp_draft.status_code == 201, r_cp_draft.text
            cp_draft_id = r_cp_draft.json()["draft_id"]
            r_cp_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{cp_draft_id}/submit", json={},
            )
        assert r_cp_submit.status_code == 200, r_cp_submit.text
        cp_gate_id = uuid.UUID(r_cp_submit.json()["gate_id"])
        assert cp_gate_id != gate_a, "site_post와 channel_post가 게이트를 공유했다"

        async with Session() as s:
            gate_a_row = await transition_gate(s, org_id, gate_a, "approved", resolver_id=human_id)
            await s.commit()
            assert gate_a_row.status == "approved", "channel_post 상신이 site_post 게이트를 건드렸다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
