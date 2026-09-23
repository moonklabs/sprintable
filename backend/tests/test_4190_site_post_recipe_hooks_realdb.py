"""story #4190(E-RECIPE-2·P2) — 레시피 external_publish 승인의 승계(훅A)·캐스케이드(훅B)·발행 명령.

PO 판정(2026-09-23 07:36Z) «사람 승인은 그 사람이 본 내용에만 유효하다»:
- 레시피 unscoped 게이트가 승인되는 순간 승인 화면이 보여 준 초안(`find_ready_recipe_channel_drafts()[0]`)의
  id·버전을 neutral_facts[`approved_draft`]에 봉인한다. 승계(훅A 채널·사이트)와 캐스케이드(훅B)는 봉인된 초안·
  버전에만 — 승인 뒤 새 초안·재제출한 새 버전은 scoped 게이트 pending(사람 승인).
- 사이트 초안은 승인 화면에 안 보여 봉인되지 않는다(승계 0) — 블로그의 발행 승인은 내용이 봉인된 초안 게이트
  하나다(PO 08:49Z · 4174 (a)).
- PO diff(08:49Z): 캐스케이드와 «대신 결재» 표시는 판정 함수 하나(`recipe_approval_cascade_target`)를 같이 쓴다.
까디르 QA:
- P2 승인된 게이트의 새 버전 → 옛 발행 명령을 같은 트랜잭션에서 무효화.
- P3 캐스케이드의 «단일 목적지» 판정이 승인된 다른 목적지도 센다.

세팅은 기존 하네스 재사용(발명 0): site = test_e4fc29fa_site_post_orchestration, channel = test_4090_ac2.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.recipe_reviewed_draft import reviewed_draft_body_via, reviewed_draft_for

from tests.test_e4fc29fa_site_post_orchestration import (
    _client_for,
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


# ─── site post 하네스 ────────────────────────────────────────────────────────────


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


async def _gate(Session, gate_id):
    from app.models.gate import Gate

    async with Session() as s:
        return await s.get(Gate, gate_id)


async def _commands(Session, gate_id, *, status=None):
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        q = select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
        if status is not None:
            q = q.where(PublicationCommand.status == status)
        return list((await s.execute(q)).scalars().all())


async def _post_site_version(app, Session, w, connection_id, slug, body="본문"):
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["agent_id"], agent=True)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/organizations/{w['org_id']}/site-posts/drafts",
            json={
                "work_item_id": str(w["story_id"]), "title": "제목", "slug": slug, "lang": "ko",
                "summary": "요약", "tags": [], "body_md": body, "media_manifest": [],
                "connection_id": str(connection_id),
            },
        )
        assert r.status_code == 201, r.text
        return uuid.UUID(r.json()["draft_id"])


async def _submit_site(app, Session, w, draft_id):
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["agent_id"], agent=True)
    async with _client_for(app) as client:
        r = await client.post(f"/api/v2/organizations/{w['org_id']}/site-posts/drafts/{draft_id}/submit", json={})
        assert r.status_code == 200, r.text
        return uuid.UUID(r.json()["gate_id"])


# ─── site post ──────────────────────────────────────────────────────────────────


async def test_site_recipe_approved_first_then_new_blog_draft_is_not_inherited():
    """승인 뒤 새로 만든 초안 → 승계 0 · 명령 0(사람 승인). 뮤테이션: 훅A 봉인 대조 제거 → approved로 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_site_world(s)
            wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://o1.example.com")
        recipe_id = await _recipe_gate(Session, w)
        await _approve(Session, w, recipe_id)

        draft_id = await _post_site_version(app, Session, w, wp, "order-1")
        gate_id = await _submit_site(app, Session, w, draft_id)
        gate = await _gate(Session, gate_id)
        assert gate.status == "pending" and gate.requires_human is True
        assert await _commands(Session, gate_id) == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_site_draft_not_shown_on_approval_screen_is_not_cascaded():
    """초안 먼저 → 레시피 승인. 블로그 초안은 승인 화면에 안 보여 봉인되지 않는다 → 캐스케이드 0 · 명령 0.
    뮤테이션: 판정 함수의 ready[0] 대조 제거 → approved·명령 1로 RED."""
    from app.main import app
    from app.services.gate_service import RECIPE_APPROVED_DRAFT_FACT

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_site_world(s)
            wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://o2.example.com")
        recipe_id = await _recipe_gate(Session, w)
        draft_id = await _post_site_version(app, Session, w, wp, "order-2")
        gate_id = await _submit_site(app, Session, w, draft_id)

        await _approve(Session, w, recipe_id)
        recipe = await _gate(Session, recipe_id)
        assert RECIPE_APPROVED_DRAFT_FACT not in (recipe.neutral_facts or {})
        gate = await _gate(Session, gate_id)
        assert gate.status == "pending"
        assert await _commands(Session, gate_id) == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_site_gate_not_shown_on_approval_screen_is_not_marked_deferred():
    """#4139 «레시피가 대신 결재»(deferred_to_gate_id → 인박스에서 숨김)는 승인 화면이 보여 주고 봉인할 초안에만.
    블로그 초안 게이트를 숨기면 레시피 승인 뒤에도 사람이 못 찾는다. 뮤테이션: gates.py의 ready[0] 대조 제거 →
    deferred_to_gate_id가 채워져 RED."""
    from app.main import app
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_site_world(s)
            wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://d.example.com")
        await _recipe_gate(Session, w)
        gate_id = await _submit_site(app, Session, w, await _post_site_version(app, Session, w, wp, "deferred"))
        async with Session() as s:
            resp = await to_gate_response(s, w["org_id"], await s.get(Gate, gate_id))
        assert resp.deferred_to_gate_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_site_new_version_of_approved_gate_voids_old_command_and_is_not_reinherited():
    """까디르 P2(재현) — 승인된 블로그 게이트(명령 1)에 본문을 바꾼 v2 → 옛 명령 즉시 void(CONTENT_CHANGED) · 게이트
    pending · 재제출해도(레시피가 승인돼 있어도) 승계 0 · 새 명령 0. 뮤테이션: 새 버전 훅의 void 제거 → 옛 명령 pending으로 RED."""
    from app.main import app
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_site_world(s)
            wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://o4.example.com")
        recipe_id = await _recipe_gate(Session, w)
        draft_id = await _post_site_version(app, Session, w, wp, "p2-version")
        gate_id = await _submit_site(app, Session, w, draft_id)
        async with Session() as s:
            await transition_gate(s, w["org_id"], gate_id, "approved", resolver_id=w["human_id"])
            await s.commit()
        await _approve(Session, w, recipe_id)
        [v1_command] = await _commands(Session, gate_id)
        assert v1_command.status == "pending"

        await _post_site_version(app, Session, w, wp, "p2-version", body="바뀐 본문")
        voided = await _commands(Session, gate_id, status="voided")
        assert [c.id for c in voided] == [v1_command.id] and voided[0].reason_code == "CONTENT_CHANGED"
        assert (await _gate(Session, gate_id)).status == "pending"

        await _submit_site(app, Session, w, draft_id)
        gate = await _gate(Session, gate_id)
        assert gate.status == "pending" and gate.requires_human is True
        assert await _commands(Session, gate_id, status="pending") == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()

async def test_site_resubmit_of_approved_gate_voids_its_pending_command():
    """까디르 P2(제출 경로) — 이미 approved인 블로그 게이트를 새 버전 없이 재상신해 다시 봉인하면(여기선 예상 비용만
    바뀜) 그 승인으로 만든 대기 명령을 같은 트랜잭션에서 무효화 — channel_posts 재상신과 같은 사유 우선순위.
    뮤테이션: submit의 was_approved void 제거 → 명령 pending으로 RED."""
    from app.main import app
    from app.services.gate_service import transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_site_world(s)
            wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://p2.example.com")
        draft_id = await _post_site_version(app, Session, w, wp, "p2-submit")
        gate_id = await _submit_site(app, Session, w, draft_id)
        async with Session() as s:
            await transition_gate(s, w["org_id"], gate_id, "approved", resolver_id=w["human_id"])
            await s.commit()
        [command] = await _commands(Session, gate_id)
        assert command.status == "pending"

        _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["agent_id"], agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{w['org_id']}/site-posts/drafts/{draft_id}/submit",
                json={"estimated_cost_minor": 1200},
            )
            assert r.status_code == 200, r.text
        voided = await _commands(Session, gate_id, status="voided")
        assert [c.id for c in voided] == [command.id] and voided[0].reason_code == "BUDGET_CHANGED"
        assert (await _gate(Session, gate_id)).status == "pending"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_two_pending_destinations_do_not_inherit_recipe_approval():
    """#3478 — 목적지가 둘이면 각자 사람 승인."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            w = await _seed_site_world(s)
            wp = await _seed_wordpress_connection(s, w["org_id"], site_url="https://m.example.com")
            wh = await _seed_webhook_connection(s, w["org_id"], target_url_builder=lambda cid: f"https://h2.example.com/{cid}")
        first = await _submit_site(app, Session, w, await _post_site_version(app, Session, w, wp, "multi-a"))
        second = await _submit_site(app, Session, w, await _post_site_version(app, Session, w, wh, "multi-b"))
        recipe_id = await _recipe_gate(Session, w)
        await _approve(Session, w, recipe_id)

        for gid in (first, second):
            assert (await _gate(Session, gid)).status == "pending"
            assert await _commands(Session, gid) == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── channel post ───────────────────────────────────────────────────────────────


async def _channel_world(Session, slug):
    from tests.test_4090_ac2_recipe_auto_publish_realdb import (
        _seed_agent as _ch_seed_agent,
        _seed_default_role as _ch_seed_default_role,
        _seed_definition,
        _seed_org_with_owner,
        _seed_recipe_channel_binding,
        _seed_sandbox_connection,
        _seed_story as _ch_seed_story,
        _seed_system_publisher_teammember_shim,
        _walk_to_pending_approval_with_abc_approved,
    )

    async with Session() as s:
        org_id, project_id, owner_member_id, _ = await _seed_org_with_owner(s, slug=slug)
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
    return {
        "org_id": org_id, "owner_member_id": owner_member_id, "creator_id": creator_id, "story_id": story_id,
        "connection_id": connection_id, "gate_d_id": gate_d_id,
    }


async def _channel_draft_and_submit(app, Session, c, text, *, scheduled_at=None):
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _client_for as _ch_client_for
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _setup_org_scoped_app as _ch_setup

    _ch_setup(app, Session, c["org_id"], user_id=c["creator_id"], agent=True)
    async with _ch_client_for(app) as client:
        r_draft = await client.post(
            f"/api/v2/organizations/{c['org_id']}/channel-posts/drafts",
            json={"work_item_id": str(c["story_id"]), "connection_id": str(c["connection_id"]), "text": text},
        )
        assert r_draft.status_code == 201, r_draft.text
        draft_id = uuid.UUID(r_draft.json()["draft_id"])
        r_submit = await client.post(
            f"/api/v2/organizations/{c['org_id']}/channel-posts/drafts/{draft_id}/submit",
            json={"scheduled_at": scheduled_at} if scheduled_at else {},
        )
        assert r_submit.status_code == 200, r_submit.text
        return draft_id, uuid.UUID(r_submit.json()["gate_id"])


async def _approve_d(Session, c):
    from app.services.gate_service import transition_gate

    async with Session() as s:
        reviewed = await reviewed_draft_for(s, org_id=c["org_id"], work_item_id=c["story_id"])
        await transition_gate(
            s, c["org_id"], c["gate_d_id"], "approved", c["owner_member_id"], "발행 승인", reviewed_draft=reviewed,
        )
        await s.commit()


async def test_channel_shown_draft_is_sealed_and_scheduled_cascade_commands_once():
    """채널 예약 초안(승인 화면에 보이는 초안) → 레시피 승인이 그 id·버전을 봉인 → 캐스케이드 승계 → 명령 정확히 1
    (캐스케이드 훅 + publish_recipe_approved_draft 두 번 불러도 create_or_get 멱등)."""
    from app.main import app
    from app.services.gate_service import RECIPE_APPROVED_DRAFT_FACT
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190a")
        scheduled_at = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        draft_id, scoped_id = await _channel_draft_and_submit(app, Session, c, "예약 본문", scheduled_at=scheduled_at)
        await _approve_d(Session, c)

        recipe = await _gate(Session, c["gate_d_id"])
        sealed = (recipe.neutral_facts or {})[RECIPE_APPROVED_DRAFT_FACT]
        scoped = await _gate(Session, scoped_id)
        assert sealed["draft_id"] == str(draft_id) and sealed["version"] == scoped.sealed_content_version
        assert scoped.status == "approved"
        assert len(await _commands(Session, scoped_id)) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_new_draft_after_recipe_approval_is_not_inherited():
    """승인 뒤 새 채널 초안 → 승계 0(예전 #4069 훅A는 승계했다 — PO 판정으로 정정)."""
    from app.main import app
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190b")
        await _approve_d(Session, c)
        _draft_id, scoped_id = await _channel_draft_and_submit(app, Session, c, "승인 뒤 본문")
        scoped = await _gate(Session, scoped_id)
        assert scoped.status == "pending" and scoped.requires_human is True
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_resubmitted_new_version_is_not_inherited():
    """봉인된 v1 승계 뒤 본문을 바꾼 v2 재제출 → 승계 0 · 옛 명령 void · 새 명령 0.
    뮤테이션: 채널 훅A의 봉인 대조 제거 → v2 게이트 approved로 RED."""
    from app.main import app
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190c")
        scheduled_at = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        _draft_id, scoped_id = await _channel_draft_and_submit(app, Session, c, "v1 본문", scheduled_at=scheduled_at)
        await _approve_d(Session, c)
        [v1_command] = await _commands(Session, scoped_id)

        await _channel_draft_and_submit(app, Session, c, "v2 바뀐 본문", scheduled_at=scheduled_at)
        scoped = await _gate(Session, scoped_id)
        assert scoped.status == "pending" and scoped.requires_human is True
        voided = await _commands(Session, scoped_id, status="voided")
        assert [x.id for x in voided] == [v1_command.id]
        assert await _commands(Session, scoped_id, status="pending") == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_deferred_display_and_cascade_share_one_judgment():
    """PO diff(08:49Z) — «대신 결재» 표시와 캐스케이드가 같은 판정(`recipe_approval_cascade_target`)을 쓴다. 다른 목적지
    A가 이미 approved이고 B가 단일 pending이면: 표시 = 안 숨김(deferred 없음) · 레시피 승인 = B에 캐스케이드 안 함(까디르 P3).
    뮤테이션: 표시 쪽을 옛 조건(sole pending만)으로 되돌리면 deferred가 채워져 RED · 판정 함수에서 다른 목적지 검사를 빼면
    둘 다 뒤집혀 RED."""
    from app.main import app
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response
    from app.services.gate_service import transition_gate
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session, _seed_sandbox_connection

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190d")
        _draft_a, gate_a = await _channel_draft_and_submit(app, Session, c, "A안")
        async with Session() as s:
            await transition_gate(s, c["org_id"], gate_a, "approved", c["owner_member_id"], "A 직접 승인")
            await s.commit()
        async with Session() as s:
            connection_b = await _seed_sandbox_connection(s, c["org_id"], account_id="p3-b")
        _draft_b, gate_b = await _channel_draft_and_submit(app, Session, c | {"connection_id": connection_b}, "B안")

        async with Session() as s:
            resp = await to_gate_response(s, c["org_id"], await s.get(Gate, gate_b))
        assert resp.deferred_to_gate_id is None, "인박스가 숨겼는데"

        await _approve_d(Session, c)
        assert (await _gate(Session, gate_b)).status == "pending", "레시피 승인이 걸지 않아야"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_sole_shown_draft_is_marked_deferred_and_cascaded():
    """양성 쌍 — 단일 목적지 채널 초안(승인 화면에 보임)은 표시 = «대신 결재» · 레시피 승인 = 캐스케이드. 두 표면이 같은 답."""
    from app.main import app
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190e")
        _draft_id, scoped_id = await _channel_draft_and_submit(app, Session, c, "단일 목적지 본문")
        async with Session() as s:
            resp = await to_gate_response(s, c["org_id"], await s.get(Gate, scoped_id))
        assert resp.deferred_to_gate_id == c["gate_d_id"]

        await _approve_d(Session, c)
        assert (await _gate(Session, scoped_id)).status == "approved"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_edited_after_approval_is_not_cascaded_until_resubmitted():
    """판정 함수의 버전 조건 — 사람이 승인한 채널 초안을 고치면(새 버전) 게이트는 pending으로 돌아가지만 봉인은 옛
    버전이다. 이때 레시피 승인은 사람이 본 적 없는 새 내용이라 캐스케이드하지 않고, 표시도 «대신 결재»가 아니다.
    뮤테이션: 판정 함수에서 버전 대조를 빼면 캐스케이드·표시 둘 다 뒤집혀 RED."""
    from app.main import app
    from app.models.gate import Gate
    from app.routers.gates import to_gate_response
    from app.services.gate_service import transition_gate
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _client_for as _ch_client_for
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _setup_org_scoped_app as _ch_setup

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190f")
        scheduled_at = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        _draft_id, scoped_id = await _channel_draft_and_submit(app, Session, c, "v1 본문", scheduled_at=scheduled_at)
        async with Session() as s:
            await transition_gate(s, c["org_id"], scoped_id, "approved", c["owner_member_id"], "v1 직접 승인")
            await s.commit()

        _ch_setup(app, Session, c["org_id"], user_id=c["creator_id"], agent=True)
        async with _ch_client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{c['org_id']}/channel-posts/drafts",
                json={"work_item_id": str(c["story_id"]), "connection_id": str(c["connection_id"]), "text": "v2 고친 본문"},
            )
            assert r.status_code == 201, r.text
        scoped = await _gate(Session, scoped_id)
        assert scoped.status == "pending" and scoped.reapproval_required is True

        async with Session() as s:
            resp = await to_gate_response(s, c["org_id"], await s.get(Gate, scoped_id))
        assert resp.deferred_to_gate_id is None

        await _approve_d(Session, c)
        assert (await _gate(Session, scoped_id)).status == "pending", "사람이 안 본 v2에 레시피 승인이 걸렸다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_new_version_between_seal_and_cascade_is_not_inherited(monkeypatch):
    """까디르 4564 CHANGES — 봉인(v1)과 캐스케이드 대상 계산 사이에 v2가 커밋·재봉인되면(인터리빙) 캐스케이드는 봉인
    v1과 대조해 승계 0. 결정적 재현: 봉인 직후 같은 흐름에서 v2를 만든다(pending scoped 게이트가 v2로 재봉인).
    뮤테이션: 캐스케이드가 봉인 반환값 대신 ready[0]을 재조회하고 명시 대조(②)도 빼면 v2를 승계해 RED."""
    import app.services.gate_service as gs
    from app.services.channel_posts import create_channel_post_draft_version
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190g")
        scheduled_at = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        from app.main import app as app_

        _draft_id, scoped_id = await _channel_draft_and_submit(app_, Session, c, "v1 본문", scheduled_at=scheduled_at)
        real_seal = gs.seal_recipe_approved_draft

        async def seal_then_v2(session, gate, **kw):
            sealed = await real_seal(session, gate, **kw)
            await create_channel_post_draft_version(
                session, org_id=c["org_id"], work_item_id=c["story_id"], connection_id=c["connection_id"],
                text="v2 끼어든 본문", link_url=None, author_member_id=c["creator_id"], author_kind="agent",
            )
            return sealed

        monkeypatch.setattr(gs, "seal_recipe_approved_draft", seal_then_v2)
        await _approve_d(Session, c)

        scoped = await _gate(Session, scoped_id)
        assert scoped.status == "pending", "봉인 v1 뒤 끼어든 v2를 레시피 승인이 승계했다"
        assert await _commands(Session, scoped_id, status="pending") == []
    finally:
        app_.dependency_overrides.clear()
        await engine.dispose()


async def test_real_concurrent_edit_waits_for_the_approval_lock(monkeypatch):
    """실 PG 두 세션 — A(레시피 승인)가 봉인에서 초안 행을 잠근 채 멈춘 동안 B(새 버전)는 그 잠금에서 기다린다 · A 커밋 뒤
    B가 진행해 결과는 순차와 같다(A가 v1 승계 → B의 v2가 승인된 게이트를 재승인 대기로 되돌림 · v1 대기 명령 void).
    잠금 순서 레시피 게이트 → 초안 → scoped 게이트(B의 경로 초안 → scoped 게이트와 같은 방향 — 교착 없음)."""
    import asyncio

    import app.services.gate_service as gs
    from app.main import app
    from app.services.channel_posts import create_channel_post_draft_version
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190h")
        scheduled_at = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        _draft_id, scoped_id = await _channel_draft_and_submit(app, Session, c, "v1 본문", scheduled_at=scheduled_at)

        locked, release = asyncio.Event(), asyncio.Event()
        real_target = gs.recipe_approval_cascade_target

        async def paused_target(session, **kw):
            locked.set()
            await release.wait()
            return await real_target(session, **kw)

        monkeypatch.setattr(gs, "recipe_approval_cascade_target", paused_target)

        async def edit_v2():
            async with Session() as s:
                await create_channel_post_draft_version(
                    s, org_id=c["org_id"], work_item_id=c["story_id"], connection_id=c["connection_id"],
                    text="v2 동시 편집", link_url=None, author_member_id=c["creator_id"], author_kind="agent",
                )

        approve_task = asyncio.create_task(_approve_d(Session, c))
        await asyncio.wait_for(locked.wait(), timeout=10)
        edit_task = asyncio.create_task(edit_v2())
        await asyncio.sleep(0.8)
        assert not edit_task.done(), "승인이 초안을 잠근 동안 새 버전이 먼저 끝났다(잠금 없음)"
        release.set()
        await asyncio.wait_for(approve_task, timeout=20)
        await asyncio.wait_for(edit_task, timeout=20)

        scoped = await _gate(Session, scoped_id)
        assert scoped.status == "pending" and scoped.reapproval_required is True
        assert await _commands(Session, scoped_id, status="pending") == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()



async def test_stale_screen_click_is_409_and_nothing_is_approved():
    """PO 판정 11:49Z «본 버전 대조» — 승인 화면(v1)을 연 뒤 v2가 커밋되고 v1 화면에서 승인 클릭 → 409 GATE_DRAFT_CHANGED ·
    레시피 게이트 pending 그대로 · 초안 게이트 승계 0. 화면이 받은 linked_channel_draft에는 version이 실린다(FE가 돌려보낼
    재료). 뮤테이션: 봉인의 본 버전 대조 제거 → v2 봉인·승계로 RED."""
    from app.main import app
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _client_for as _ch_client_for
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _setup_org_scoped_app as _ch_setup

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190i")
        _draft_id, scoped_id = await _channel_draft_and_submit(app, Session, c, "v1 본문")
        owner_user_id = await _owner_user_id(Session, c)
        _ch_setup(app, Session, c["org_id"], user_id=owner_user_id, agent=False)
        async with _ch_client_for(app) as client:
            screen = (await client.get(f"/api/v2/gates/{c['gate_d_id']}")).json()
        seen = screen["linked_channel_draft"]
        assert seen["version"] == 1

        await _channel_draft_and_submit(app, Session, c, "v2 화면 뒤에 바뀐 본문")
        _ch_setup(app, Session, c["org_id"], user_id=owner_user_id, agent=False)
        async with _ch_client_for(app) as client:
            r = await client.post(f"/api/v2/gates/{c['gate_d_id']}/transition", json={
                "status": "approved", "note": "v1 보고 승인", "evidence_viewed": True,
                "reviewed_draft_id": seen["draft_id"], "reviewed_draft_version": seen["version"],
            })
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "GATE_DRAFT_CHANGED"
        assert (await _gate(Session, c["gate_d_id"])).status == "pending"
        assert (await _gate(Session, scoped_id)).status == "pending"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_approve_without_reviewed_draft_is_409_when_a_draft_is_shown():
    """fail-closed — 화면에 초안이 있는데 본 버전을 안 싣고 승인하면 409(merge 게이트 reviewed_head_sha 미전송과 같은 규칙).
    소유자 override(본 버전을 못 싣는 경로)도 500이 아니라 409."""
    from app.main import app
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _client_for as _ch_client_for
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _realdb_session
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _setup_org_scoped_app as _ch_setup

    engine, Session = await _realdb_session()
    try:
        c = await _channel_world(Session, "c4190j")
        await _channel_draft_and_submit(app, Session, c, "보여 줄 초안")
        owner_user_id = await _owner_user_id(Session, c)
        _ch_setup(app, Session, c["org_id"], user_id=owner_user_id, agent=False)
        async with _ch_client_for(app) as client:
            r = await client.post(f"/api/v2/gates/{c['gate_d_id']}/transition", json={
                "status": "approved", "note": "본 버전 없이", "evidence_viewed": True,
            })
            assert r.status_code == 409, r.text
            r_override = await client.post(f"/api/v2/gates/{c['gate_d_id']}/override", json={
                "decision": "approved", "reason": "강제 승인",
            })
        assert r_override.status_code == 409, r_override.text
        assert r_override.json()["error"]["code"] == "GATE_DRAFT_CHANGED"
        assert (await _gate(Session, c["gate_d_id"])).status == "pending"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _owner_user_id(Session, c):
    from sqlalchemy import select

    from app.models.project import OrgMember

    async with Session() as s:
        return (await s.execute(select(OrgMember.user_id).where(OrgMember.id == c["owner_member_id"]))).scalar_one()
