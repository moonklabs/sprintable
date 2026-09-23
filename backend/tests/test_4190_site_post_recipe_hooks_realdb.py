"""story #4190(E-RECIPE-2·P2) — 외부 블로그(site post)의 레시피 승인 승계(훅A)와 승계 승인 뒤 발행 명령(훅B).

AC1 두 순서, 외부 블로그(WordPress) 초안:
  ① 레시피 승인 먼저 → 초안 제출 → 추가 승인 없이 초안 게이트 approved + 발행 명령 정확히 1.
  ② 초안 먼저 → 레시피 승인 → 초안 게이트 승계 approved + 발행 명령 정확히 1(예전엔 0 — «초록인데 안 나감»).
  목적지가 둘이면 승계하지 않는다(#3478).
AC2 channel post 무회귀 · 캐스케이드 승계 게이트가 발행 명령 훅을 타도 예약 채널 초안에 명령이 중복되지 않는다.

세팅은 기존 하네스 재사용(발명 0): site = test_e4fc29fa_site_post_orchestration, channel = test_4090_ac2.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

_RECIPE_FACTS = {"triggered_by_event": "preset.marketing.blog_article", "stage": "pending_approval"}


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


async def _seed_site_world(s):
    org_id, project_id = await _seed_org(s)
    role_id = await _seed_default_role(s, org_id)
    agent_id = await _seed_agent(s, org_id, project_id)
    _, human_id = await _seed_human(s, org_id)
    story_id = await _seed_story(s, org_id, project_id)
    return {"org_id": org_id, "role_id": role_id, "agent_id": agent_id, "human_id": human_id, "story_id": story_id}


async def _recipe_gate(Session, w):
    from app.services.gate_service import create_gate

    async with Session() as s:
        gate = await create_gate(
            s, w["org_id"], w["story_id"], "story", "external_publish", w["agent_id"], w["role_id"],
            neutral_facts=dict(_RECIPE_FACTS), notify=False,
        )
        await s.commit()
        return gate.id


async def _approve(Session, w, gate_id):
    from app.services.gate_service import transition_gate

    async with Session() as s:
        await transition_gate(s, w["org_id"], gate_id, "approved", resolver_id=w["human_id"])
        await s.commit()


async def _gate_and_commands(Session, gate_id):
    from sqlalchemy import func, select

    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        gate = await s.get(Gate, gate_id)
        n = (await s.execute(
            select(func.count()).select_from(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
        )).scalar_one()
        return gate, n


async def _submit(app, Session, w, connection_id, slug):
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["agent_id"], agent=True)
    async with _client_for(app) as client:
        _, gate_id = await _create_and_submit_site_post_draft(
            client, org_id=w["org_id"], story_id=w["story_id"], connection_id=connection_id, slug=slug,
        )
    return gate_id


async def test_order_1_recipe_approved_first_then_blog_submit_inherits_and_commands_once():
    """AC1 ① — 뮤테이션: site_posts 훅A 제거 → 초안 게이트가 pending으로 남아 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_site_world(s)
            wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://o1.example.com")
        recipe_id = await _recipe_gate(Session, w)
        await _approve(Session, w, recipe_id)

        gate_id = await _submit(app, Session, w, wp, "order-1")
        gate, commands = await _gate_and_commands(Session, gate_id)
        assert gate.status == "approved", gate.resolution_note
        assert "auto_satisfied_by_recipe_external_publish_gate" in (gate.resolution_note or "")
        assert commands == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_order_2_blog_submit_first_then_recipe_approval_cascades_and_commands_once():
    """AC1 ② — 뮤테이션: 캐스케이드의 발행 명령 훅 호출 제거 → 게이트는 approved인데 명령 0(옛 결함)으로 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_site_world(s)
            wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://o2.example.com")
        recipe_id = await _recipe_gate(Session, w)
        gate_id = await _submit(app, Session, w, wp, "order-2")
        gate, commands = await _gate_and_commands(Session, gate_id)
        assert gate.status == "pending" and commands == 0

        await _approve(Session, w, recipe_id)
        gate, commands = await _gate_and_commands(Session, gate_id)
        assert gate.status == "approved", gate.resolution_note
        assert commands == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_two_destinations_do_not_inherit_recipe_approval():
    """#3478 — 목적지가 둘이면 각자 사람 승인. 두 번째 제출은 승계하지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_site_world(s)
            wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://m.example.com")
            wh = await _seed_webhook_connection(s, w["org_id"], target_url_builder=lambda cid: f"https://h.example.com/{cid}")
        first_gate = await _submit(app, Session, w, wp, "multi-a")
        second_gate = await _submit(app, Session, w, wh, "multi-b")
        recipe_id = await _recipe_gate(Session, w)
        await _approve(Session, w, recipe_id)

        for gid in (first_gate, second_gate):
            gate, commands = await _gate_and_commands(Session, gid)
            assert gate.status == "pending", "목적지가 둘인데 레시피 승인이 승계됐다"
            assert commands == 0

        third_wp = None
        async with Session() as s:
            third_wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://m3.example.com")
        third_gate = await _submit(app, Session, w, third_wp, "multi-c")
        gate, _ = await _gate_and_commands(Session, third_gate)
        assert gate.status == "pending", "다른 목적지 게이트가 살아 있는데 훅A가 승계했다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_scheduled_draft_cascade_creates_exactly_one_command():
    """AC2 — 채널 예약 초안: 캐스케이드 승계 게이트가 이제 발행 명령 훅을 직접 타고, publish_recipe_approved_draft도
    같은 훅을 부르지만 명령은 정확히 1(create_or_get 멱등)."""
    from app.main import app
    from tests.test_4090_ac2_recipe_auto_publish_realdb import (
        _client_for as _ch_client_for,
        _realdb_session,
        _seed_agent as _ch_seed_agent,
        _seed_default_role as _ch_seed_default_role,
        _seed_definition,
        _seed_org_with_owner,
        _seed_recipe_channel_binding,
        _seed_sandbox_connection,
        _seed_story as _ch_seed_story,
        _seed_system_publisher_teammember_shim,
        _setup_org_scoped_app as _ch_setup,
        _walk_to_pending_approval_with_abc_approved,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id, _ = await _seed_org_with_owner(s, slug="c4190")
            await _ch_seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _ch_seed_agent(s, org_id, project_id, name="댄")
            story_id = await _ch_seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)
            gate_d_id = await _walk_to_pending_approval_with_abc_approved(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
            )

        scheduled_at = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        _ch_setup(app, Session, org_id, user_id=creator_id, agent=True)
        async with _ch_client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={"work_item_id": str(story_id), "connection_id": str(connection_id), "text": "예약 본문"},
            )
            draft_id = uuid.UUID(r_draft.json()["draft_id"])
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"scheduled_at": scheduled_at},
            )
            assert r_submit.status_code == 200, r_submit.text
            scoped_gate_id = uuid.UUID(r_submit.json()["gate_id"])

        from app.services.gate_service import transition_gate

        async with Session() as s:
            await transition_gate(s, org_id, gate_d_id, "approved", owner_member_id, "발행 승인")
            await s.commit()

        gate, commands = await _gate_and_commands(Session, scoped_gate_id)
        assert gate.status == "approved"
        assert commands == 1, f"예약 채널 초안에 발행 명령이 {commands}건 — 중복"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
