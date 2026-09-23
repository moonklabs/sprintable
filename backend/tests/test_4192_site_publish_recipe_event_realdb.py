"""story #4192(E-RECIPE-2·P4) — 블로그(site post) 발행이 실제로 끝난 순간 레시피 `published` 단계 이벤트.

블로그 레시피(0399 `preset.marketing.blog_article`, story #4174)는 «발행 승인 대기»(게이트 없음) 다음 단계
`published`를 서버가 낸다(capability `site_post_auto_publish`). 이 파일은 그 «서버가 낸다»를 잰다:
AC1·AC2 외부 블로그 — 초안 게이트 승인 → 발행 명령 → 워커 발행 성공 → 이벤트 정확히 1(겹친 tick도 1) · 실패 0.
AC2 자사 블로그 — 레시피 회차면 초안 게이트 사람 승인 → 서버가 봉인 버전 발행 → 이벤트 1 · 발행 실패(일시 중지)면
    승인 유지 + `publish_outcome=publish_failed:…` + 이벤트 0.
AC3 레시피 밖 자사 블로그 — 승인 뒤 발행 안 됨(사람 클릭 흐름 그대로).
디디 발견 — channel_posts 모듈 logger 부재로 side-channel 격리 except가 NameError를 던지던 것.

세팅은 기존 하네스 재사용(발명 0): site = test_e4fc29fa_site_post_orchestration, 레시피 단계 발행 = test_4090_ac2.
"""
from __future__ import annotations

import logging
import os
import uuid

import pytest
from fastapi import BackgroundTasks

from tests.test_e4fc29fa_site_post_orchestration import (  # noqa: F401 — live_wordpress_stub는 fixture
    _client_for,
    _create_and_submit_site_post_draft,
    _seed_agent,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _seed_wordpress_connection,
    _session_factory,
    _setup_org_scoped_app,
    live_wordpress_stub,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

_KEY = "preset.marketing.blog_article"


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


def _load_0399():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "alembic/versions/0399_preset_marketing_blog_article.py"
    spec = importlib.util.spec_from_file_location("_mig_0399", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


async def _seed_blog_definition(s):
    """이 하네스는 마이그레이션이 아니라 스키마 재생성 위에서 돈다 — 블로그 프리셋 행을 0399의 값 그대로 심는다
    (값을 테스트에 다시 적지 않는다 — 시드와 갈라지지 않게)."""
    from sqlalchemy import select

    from app.models.event_definition import EventDefinition

    if (await s.execute(select(EventDefinition.id).where(EventDefinition.key == _KEY))).first() is not None:
        return
    m = _load_0399()
    s.add(EventDefinition(
        id=uuid.uuid4(), key=m._KEY, org_id=None, name=m._NAME, description=m._DESCRIPTION,
        payload_schema=m._PAYLOAD_SCHEMA, routing=m._ROUTING, block_template=m._BLOCK_TEMPLATE,
        stage_metadata=m._STAGE_METADATA, role_actor_kinds=m._ROLE_ACTOR_KINDS, enabled=True, version=1,
    ))
    await s.commit()


async def _world(Session):
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _seed_system_publisher_teammember_shim

    async with Session() as s:
        await _seed_blog_definition(s)
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        await _seed_system_publisher_teammember_shim(s, org_id, project_id)
        agent_id = await _seed_agent(s, org_id, project_id)
        _, human_id = await _seed_human(s, org_id)
        story_id = await _seed_story(s, org_id, project_id)
    return {"org_id": org_id, "agent_id": agent_id, "human_id": human_id, "story_id": story_id}


async def _publish_stage(Session, w, stage):
    from app.routers.events import EventPublishRequest, publish_registry_event
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _auth, _fake_request

    async with Session() as s:
        await publish_registry_event(
            EventPublishRequest(
                definition_key=_KEY,
                payload={"stage": stage, "work_item_type": "story", "work_item_id": str(w["story_id"])},
            ),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(w["agent_id"], w["org_id"]), org_id=w["org_id"],
        )
        await s.commit()


async def _walk_to_pending_approval(Session, w):
    """블로그 레시피 run을 «발행 승인 대기»까지(기획 승인 게이트는 사람이 승인 — 블로그 초안 제출의 선행 조건)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.gate_service import transition_gate

    await _publish_stage(Session, w, "draft")
    await _publish_stage(Session, w, "concept_confirmed")
    async with Session() as s:
        concept = (await s.execute(
            select(Gate).where(Gate.work_item_id == w["story_id"], Gate.gate_type == "concept_approval")
        )).scalar_one()
        await transition_gate(s, w["org_id"], concept.id, "approved", resolver_id=w["human_id"])
        await s.commit()
    for stage in ("editing", "verification", "pending_approval"):
        await _publish_stage(Session, w, stage)


async def _published_events(Session, w) -> int:
    from sqlalchemy import func, select, text

    from app.models.conversation import Conversation, ConversationMessage

    async with Session() as s:
        return (await s.execute(
            select(func.count()).select_from(ConversationMessage)
            .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
            .where(
                Conversation.org_id == w["org_id"],
                text("conversation_messages.metadata->'event'->>'event_key' = :k"),
                text("conversation_messages.metadata->'event'->'payload'->>'work_item_id' = :w"),
                text("conversation_messages.metadata->'event'->'payload'->>'stage' = 'published'"),
            ).params(k=_KEY, w=str(w["story_id"]))
        )).scalar_one()


async def _approve(Session, w, gate_id):
    from app.services.gate_service import transition_gate

    async with Session() as s:
        await transition_gate(s, w["org_id"], gate_id, "approved", resolver_id=w["human_id"])
        await s.commit()


async def _submit_external(app, Session, w, site_url, slug):
    async with Session() as s:
        connection_id = await _seed_wordpress_connection(s, w["org_id"], site_url=site_url)
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["agent_id"], agent=True)
    async with _client_for(app) as client:
        _draft_id, gate_id = await _create_and_submit_site_post_draft(
            client, org_id=w["org_id"], story_id=w["story_id"], connection_id=connection_id, slug=slug,
        )
    return gate_id


async def _submit_hosted(app, Session, w, slug):
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["agent_id"], agent=True)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/organizations/{w['org_id']}/site-posts/drafts",
            json={
                "work_item_id": str(w["story_id"]), "title": "제목", "slug": slug, "lang": "ko",
                "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
            },
        )
        assert r.status_code == 201, r.text
        draft_id = r.json()["draft_id"]
        r_submit = await client.post(f"/api/v2/organizations/{w['org_id']}/site-posts/drafts/{draft_id}/submit", json={})
        assert r_submit.status_code == 200, r_submit.text
        return uuid.UUID(r_submit.json()["gate_id"])


async def _site_posts(Session, w) -> int:
    from sqlalchemy import func, select

    from app.models.site_post import SitePost

    async with Session() as s:
        return (await s.execute(select(func.count()).select_from(SitePost).where(SitePost.org_id == w["org_id"]))).scalar_one()


async def test_external_blog_worker_success_emits_published_exactly_once(live_wordpress_stub):
    """AC1·AC2 — 레시피 회차 외부 블로그: 승인 → 워커 발행 성공 → published 1 · 두 번째 tick도 1(멱등).
    뮤테이션: 워커 성공 분기의 레시피 이벤트 호출 제거 → 0으로 RED."""
    from app.main import app
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_pending_approval(Session, w)
        gate_id = await _submit_external(app, Session, w, live_wordpress_stub, "ext-ok")
        assert await _published_events(Session, w) == 0

        await _approve(Session, w, gate_id)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
            await s.commit()
        assert counts["completed"] == 1, counts
        assert await _published_events(Session, w) == 1

        async with Session() as s:
            await process_due_publication_commands(s)
            await s.commit()
        assert await _published_events(Session, w) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_external_blog_worker_failure_emits_nothing():
    """AC1 — 발행 실패(도달 불가 사이트)면 이벤트 0."""
    from app.main import app
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_pending_approval(Session, w)
        gate_id = await _submit_external(app, Session, w, "https://unreachable.invalid", "ext-fail")
        await _approve(Session, w, gate_id)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
            await s.commit()
        assert counts.get("completed", 0) == 0, counts
        assert await _published_events(Session, w) == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_hosted_blog_in_recipe_is_published_by_server_on_approval():
    """AC2 — 레시피 회차 자사 블로그: 초안 게이트 사람 승인 → 서버가 봉인 버전 발행(사람 클릭 0) → published 1 ·
    승인 알림 «다음 행동»은 자동 발행 문구. 뮤테이션: transition_gate의 자사 블로그 자동 발행 호출 제거 → 발행 0으로 RED."""
    from app.main import app
    from app.models.gate import Gate
    from app.routers.events import _render_gate_verdict_message
    from app.services.i18n_catalog import t

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_pending_approval(Session, w)
        gate_id = await _submit_hosted(app, Session, w, "hosted-ok")
        await _approve(Session, w, gate_id)

        assert await _site_posts(Session, w) == 1
        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            assert gate.status == "approved" and gate.publish_outcome == "published"
            assert gate.resolver_id == w["human_id"]
            rendered = await _render_gate_verdict_message(s, org_id=w["org_id"], payload={
                "work_item_type": "story", "work_item_id": str(w["story_id"]), "gate_type": "external_publish",
                "verdict": "approved", "resolver_member_id": str(w["human_id"]), "gate_id": str(gate_id),
            })
        assert await _published_events(Session, w) == 1
        assert t("events.gate_verdict_next_action_recipe_site_auto_publish", "ko") in rendered, rendered
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_hosted_blog_publish_failure_keeps_approval_and_shows_failure():
    """AC2 — 발행 실패(조직 외부 발행 일시 중지)는 승인을 되돌리지 않고 publish_outcome으로 보인다 · 이벤트 0."""
    from app.main import app
    from app.models.gate import Gate
    from app.services.external_publish_pause import set_external_publish_pause

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_pending_approval(Session, w)
        gate_id = await _submit_hosted(app, Session, w, "hosted-paused")
        async with Session() as s:
            await set_external_publish_pause(
                s, org_id=w["org_id"], paused=True, reason="테스트", actor_member_id=w["human_id"],
            )
            await s.commit()
        await _approve(Session, w, gate_id)

        async with Session() as s:
            gate = await s.get(Gate, gate_id)
            assert gate.status == "approved"
            assert (gate.publish_outcome or "").startswith("publish_failed:"), gate.publish_outcome
        assert await _site_posts(Session, w) == 0
        assert await _published_events(Session, w) == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_hosted_blog_outside_recipe_is_not_auto_published():
    """AC3 무회귀 — 레시피 회차가 아닌 자사 블로그는 승인 뒤에도 발행되지 않는다(사람 클릭 흐름 그대로)."""
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        gate_id = await _submit_hosted(app, Session, w, "hosted-plain")
        await _approve(Session, w, gate_id)
        assert await _site_posts(Session, w) == 0
        async with Session() as s:
            assert (await s.get(Gate, gate_id)).publish_outcome is None
        assert await _published_events(Session, w) == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_emit_isolation_logs_instead_of_name_error(monkeypatch, caplog):
    """디디 발견 — emit_recipe_published_stage_event의 side-channel 격리 except가 모듈 logger 없이 NameError를 던졌다.
    이벤트 발행 실패를 흉내 내면 예외 없이 끝나고 경고 로그가 남아야 한다. 뮤테이션: 모듈 logger 제거 → NameError로 RED."""
    import app.routers.events as events
    from app.services import channel_posts

    async def boom(*a, **kw):
        raise RuntimeError("simulated publish failure")

    monkeypatch.setattr(events, "_publish_registry_event_core", boom)

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        caplog.set_level(logging.WARNING, logger="app.services.channel_posts")
        async with Session() as s:
            await channel_posts.emit_recipe_published_stage_event(
                s, org_id=w["org_id"], work_item_type="story", work_item_id=w["story_id"],
                definition_key=_KEY, next_stage="published",
            )
        assert any("recipe published stage 이벤트 발행 실패" in r.getMessage() for r in caplog.records), caplog.records
    finally:
        await engine.dispose()


async def _broken_event_core(db, *a, **kw):
    """이벤트 쓰기 도중 실제 SQL 오류(없는 테이블) — 트랜잭션을 중단 상태로 만드는 종류의 실패."""
    from sqlalchemy import text

    await db.execute(text("SELECT no_such_col FROM no_such_table_4192"))


async def test_site_worker_sql_error_in_event_keeps_completed_and_next_tick_does_not_republish(
    monkeypatch, live_wordpress_stub,
):
    """PO 09:34Z — 이벤트 쪽 DB 오류가 «completed»를 지우면 다음 tick이 같은 글을 외부에 다시 발행한다. 새 세션으로
    재조회해 completed · 두 번째 tick의 외부 발행 호출 0(스텁에 글 1개 그대로). 뮤테이션: 발행 성공 선커밋과 SAVEPOINT를
    둘 다 빼면 completed가 안 남아 RED."""
    import app.routers.events as events
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.routers.dev_wordpress_stub import _POSTS
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_pending_approval(Session, w)
        gate_id = await _submit_external(app, Session, w, live_wordpress_stub, "ext-sqlerr")
        await _approve(Session, w, gate_id)

        monkeypatch.setattr(events, "_publish_registry_event_core", _broken_event_core)
        async with Session() as s:
            await process_due_publication_commands(s)
            await s.commit()
        posts_after_first = len(_POSTS)
        assert posts_after_first == 1

        async with Session() as s:
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.gate_id == gate_id))).scalar_one()
            assert cmd.status == "completed", cmd.status
        async with Session() as s:
            counts = await process_due_publication_commands(s)
            await s.commit()
        assert counts.get("completed", 0) == 0, counts
        assert len(_POSTS) == posts_after_first, "같은 글이 외부에 다시 발행됐다"
        assert await _published_events(Session, w) == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_scheduled_worker_sql_error_in_event_keeps_completed(monkeypatch):
    """PO 09:34Z — 기존 채널 예약 발행 워커(#4093)도 같은 모양: 이벤트 쪽 SQL 오류 → 새 세션 재조회 completed ·
    두 번째 tick 발행 0."""
    from datetime import datetime, timedelta, timezone

    import app.routers.events as events
    from app.models.channel_publication import ChannelPublication
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import func, select
    from tests.conftest import seed_org_with_human_owner
    from tests.test_4093_scheduled_publish_event_realdb import (
        _approve_and_schedule_submit,
        _realdb_session,
        _seed_agent as _ch_seed_agent,
        _seed_default_role as _ch_seed_default_role,
        _seed_definition,
        _seed_recipe_channel_binding,
        _seed_sandbox_connection,
        _seed_story as _ch_seed_story,
        _seed_system_publisher_teammember_shim,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await seed_org_with_human_owner(s, slug="4192ch", org_name="Org4192")
            await _ch_seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _ch_seed_agent(s, org_id, project_id, name="댄")
            story_id = await _ch_seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)
            _gate_d, scoped_gate_id, _draft = await _approve_and_schedule_submit(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
                connection_id=connection_id,
            )

        monkeypatch.setattr(events, "_publish_registry_event_core", _broken_event_core)
        later = datetime.now(timezone.utc) + timedelta(minutes=10)
        async with Session() as s:
            await process_due_publication_commands(s, now=later)
            await s.commit()
        async with Session() as s:
            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == scoped_gate_id)
            )).scalar_one()
            assert cmd.status == "completed", cmd.status
            pubs = (await s.execute(
                select(func.count()).select_from(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one()
        async with Session() as s:
            counts = await process_due_publication_commands(s, now=later + timedelta(minutes=10))
            await s.commit()
        assert counts.get("completed", 0) == 0, counts
        async with Session() as s:
            assert (await s.execute(
                select(func.count()).select_from(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one() == pubs
    finally:
        await engine.dispose()
