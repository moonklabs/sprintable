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
        human_user_id, human_id = await _seed_human(s, org_id)
        story_id = await _seed_story(s, org_id, project_id)
    return {"org_id": org_id, "agent_id": agent_id, "human_id": human_id, "human_user_id": human_user_id, "story_id": story_id}


async def _publish_stage(Session, w, stage, *, extra: dict | None = None):
    from app.routers.events import EventPublishRequest, publish_registry_event
    from tests.test_4090_ac2_recipe_auto_publish_realdb import _auth, _fake_request

    async with Session() as s:
        await publish_registry_event(
            EventPublishRequest(
                definition_key=_KEY,
                payload={"stage": stage, "work_item_type": "story", "work_item_id": str(w["story_id"]), **(extra or {})},
            ),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(w["agent_id"], w["org_id"]), org_id=w["org_id"],
        )
        await s.commit()


async def _walk_to_verification(Session, w):
    """블로그 레시피 run을 «검수»까지(기획 승인 게이트는 사람이 승인 — 블로그 초안 제출의 선행 조건). 4572: 블로그 전용
    슬러그 planning·writing. 초안은 이 단계에서 제출하고, 그 초안 id를 실어 «발행 승인 대기»로 넘어간다
    (`_walk_to_pending_approval`)."""
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.gate_service import transition_gate

    await _publish_stage(Session, w, "planning")
    await _publish_stage(Session, w, "concept_confirmed")
    async with Session() as s:
        concept = (await s.execute(
            select(Gate).where(Gate.work_item_id == w["story_id"], Gate.gate_type == "concept_approval")
        )).scalar_one()
        await transition_gate(s, w["org_id"], concept.id, "approved", resolver_id=w["human_id"])
        await s.commit()
    for stage in ("writing", "verification"):
        await _publish_stage(Session, w, stage)


async def _walk_to_pending_approval(Session, w, *, draft_id):
    """4572 P1 — «발행 승인 대기» 발행이 이 회차가 제출한 초안을 명시 연결(`site_post_draft_id`). 레시피 문맥·서버 발행은
    그 연결이 게이트의 초안과 같을 때만."""
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD

    await _publish_stage(
        Session, w, "pending_approval",
        extra={RECIPE_SITE_DRAFT_LINK_FIELD: str(draft_id)} if draft_id is not None else None,
    )


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
    """라우터(`gates.py` 전이 엔드포인트)와 같은 순서: 승인 커밋 → 자사 블로그면 커밋 뒤 격리 발행(까디르 4583 P1)."""
    from app.services.gate_service import transition_gate
    from app.services.site_posts import publish_recipe_approved_hosted_site_draft_after_commit

    async with Session() as s:
        gate = await transition_gate(s, w["org_id"], gate_id, "approved", resolver_id=w["human_id"])
        await s.commit()
        await publish_recipe_approved_hosted_site_draft_after_commit(s, gate_id=gate.id, resolver_id=gate.resolver_id)


async def _submit_external(app, Session, w, site_url, slug):
    async with Session() as s:
        connection_id = await _seed_wordpress_connection(s, w["org_id"], site_url=site_url)
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["agent_id"], agent=True)
    async with _client_for(app) as client:
        draft_id, gate_id = await _create_and_submit_site_post_draft(
            client, org_id=w["org_id"], story_id=w["story_id"], connection_id=connection_id, slug=slug,
        )
    return gate_id, draft_id


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
        return uuid.UUID(r_submit.json()["gate_id"]), uuid.UUID(draft_id)


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
        await _walk_to_verification(Session, w)
        gate_id, draft_id = await _submit_external(app, Session, w, live_wordpress_stub, "ext-ok")
        await _walk_to_pending_approval(Session, w, draft_id=draft_id)
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


async def test_external_blog_worker_failure_emits_no_next_stage_and_one_failure_notice():
    """AC1 — 발행 실패(도달 불가 사이트)면 다음 단계(published) 이벤트 0. story #4258 — 대신 레시피 실패 통지
    (`preset.recipe.publish_failed`) 1(예전 기대 «이벤트 0»을 갱신 · 통지 자체는 test_4258이 잰다)."""
    from app.main import app
    from app.services.publication_command import process_due_publication_commands
    from tests.test_4258_recipe_publish_stopped_notice_realdb import _install_notice_definition, _notices

    engine, Session = await _session_factory()
    try:
        _install_notice_definition()
        w = await _world(Session)
        await _walk_to_verification(Session, w)
        gate_id, draft_id = await _submit_external(app, Session, w, "https://unreachable.invalid", "ext-fail")
        await _walk_to_pending_approval(Session, w, draft_id=draft_id)
        await _approve(Session, w, gate_id)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
            await s.commit()
        assert counts.get("completed", 0) == 0, counts
        assert await _published_events(Session, w) == 0
        assert len(await _notices(Session, w["org_id"])) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_hosted_blog_in_recipe_is_published_by_server_on_approval():
    """AC2 — 레시피 회차 자사 블로그: 초안 게이트 사람 승인 → 서버가 봉인 버전 발행(사람 클릭 0) → published 1 ·
    승인 알림 «다음 행동»은 자동 발행 문구. 이 테스트는 `_approve`(전이 → 커밋 → 발행 함수 직접 호출)로 **발행 함수**를
    잰다. 라우터 배선(전이 엔드포인트가 커밋 뒤 발행을 부르는지)은
    `test_hosted_blog_in_recipe_is_published_through_the_real_transition_endpoint`(#4229)가 가른다."""
    from app.main import app
    from app.models.gate import Gate
    from app.routers.events import _render_gate_verdict_message
    from app.services.i18n_catalog import t

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_verification(Session, w)
        gate_id, draft_id = await _submit_hosted(app, Session, w, "hosted-ok")
        await _walk_to_pending_approval(Session, w, draft_id=draft_id)
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
        await _walk_to_verification(Session, w)
        gate_id, draft_id = await _submit_hosted(app, Session, w, "hosted-paused")
        await _walk_to_pending_approval(Session, w, draft_id=draft_id)
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
        gate_id, _draft_id = await _submit_hosted(app, Session, w, "hosted-plain")
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
    이벤트 발행 실패를 흉내 내면 예외 없이 끝나고 경고 로그가 남아야 한다(이제 격리·경고는 공용 헬퍼 한 곳)."""
    import app.routers.events as events
    from app.services import channel_posts

    async def boom(*a, **kw):
        raise RuntimeError("simulated publish failure")

    monkeypatch.setattr(events, "_publish_registry_event_core", boom)

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        # 4573 병합 뒤 통합 — 격리는 `isolated_side_effect.run_side_effect_in_own_session` 한 곳이 지고, 경고도 그 헬퍼 logger가
        # 이 입구의 설명(«recipe published stage event …»)과 함께 남긴다.
        caplog.set_level(logging.WARNING, logger="app.services.isolated_side_effect")
        async with Session() as s:
            await channel_posts.emit_recipe_published_stage_event(
                s, org_id=w["org_id"], work_item_type="story", work_item_id=w["story_id"],
                definition_key=_KEY, next_stage="published",
            )
        assert any(
            "recipe published stage event" in r.getMessage() and "부수 작업 실패" in r.getMessage() for r in caplog.records
        ), caplog.records
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
        await _walk_to_verification(Session, w)
        gate_id, draft_id = await _submit_external(app, Session, w, live_wordpress_stub, "ext-sqlerr")
        await _walk_to_pending_approval(Session, w, draft_id=draft_id)
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


async def test_event_raising_does_not_kill_the_worker_batch(monkeypatch, live_wordpress_stub):
    """PO 10:09Z(까디르 4573 실측) — 이벤트 쪽이 예외를 **던지면**(삼키는 SQL 오류와 달리 롤백 경로를 탄다) 호출자 세션
    ORM 객체가 만료돼 async에서 MissingGreenlet으로 워커 배치가 죽고, 같은 배치에 in_progress로 잡힌 다른 명령이 영구히
    멈췄다. 이벤트를 별도 세션에서 내므로: 한 배치의 명령 2개 → 둘 다 completed. 뮤테이션: emit을 호출자 세션+SAVEPOINT
    로 되돌리면 RED."""
    import app.routers.events as events
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    async def raising_core(*a, **kw):
        raise RuntimeError("simulated event failure")

    engine, Session = await _session_factory()
    try:
        worlds, gates = [], []
        for i in range(2):
            w = await _world(Session)
            await _walk_to_verification(Session, w)
            gate_id, draft_id = await _submit_external(app, Session, w, live_wordpress_stub, f"batch-{i}")
            await _walk_to_pending_approval(Session, w, draft_id=draft_id)
            await _approve(Session, w, gate_id)
            worlds.append(w)
            gates.append(gate_id)

        monkeypatch.setattr(events, "_publish_registry_event_core", raising_core)
        async with Session() as s:
            counts = await process_due_publication_commands(s)
            await s.commit()
        assert counts["completed"] == 2, counts
        async with Session() as s:
            statuses = [
                (await s.execute(select(PublicationCommand.status).where(PublicationCommand.gate_id == g))).scalar_one()
                for g in gates
            ]
        assert statuses == ["completed", "completed"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_concurrent_emits_for_same_work_item_publish_once(monkeypatch):
    """PO 10:09Z P2 — «조회 후 발행»은 같은 work item의 서로 다른 명령이 겹친 tick에 동시에 오면 2회 가능했다. 조회와
    발행 사이에 틈을 벌려도(지연 주입) advisory lock이 직렬화해 이벤트 1. 뮤테이션: 잠금 제거 → 2로 RED."""
    import asyncio

    import app.routers.events as events
    from app.services.channel_posts import emit_recipe_published_stage_event

    real_find = events._find_existing_stage_publish

    async def slow_find(*a, **kw):
        found = await real_find(*a, **kw)
        await asyncio.sleep(0.5)
        return found

    monkeypatch.setattr(events, "_find_existing_stage_publish", slow_find)

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_verification(Session, w)
        await _walk_to_pending_approval(Session, w, draft_id=None)

        async def one():
            async with Session() as s:
                await emit_recipe_published_stage_event(
                    s, org_id=w["org_id"], work_item_type="story", work_item_id=w["story_id"],
                    definition_key=_KEY, next_stage="published",
                )

        await asyncio.gather(one(), one())
        assert await _published_events(Session, w) == 1
    finally:
        await engine.dispose()


async def test_emit_never_touches_the_callers_session():
    """별도 세션 계약 고정 — 호출자 세션을 어떤 방식으로든 쓰면 터지는 대역을 넘겨도 이벤트는 정확히 1(이벤트 세션이 따로
    연다). 뮤테이션: emit이 호출자 세션(+SAVEPOINT)으로 이벤트를 내면 대역이 터져 이벤트 0으로 RED."""
    from unittest.mock import MagicMock

    from sqlalchemy.ext.asyncio import AsyncSession

    from app.services.channel_posts import emit_recipe_published_stage_event

    caller = MagicMock(spec=AsyncSession)
    for name in ("execute", "commit", "rollback", "flush", "get", "begin_nested", "scalar", "scalars", "add"):
        setattr(caller, name, MagicMock(side_effect=AssertionError(f"호출자 세션 {name} 사용")))

    engine, Session = await _session_factory()
    # 격리 세션은 호출자 세션과 **같은 엔진**에서 연다(`run_side_effect_in_own_session` — 4573 헬퍼). 대역은 엔진만 빌려 주고
    # 세션 메서드는 전부 터진다 — 이벤트가 정확히 1이면 호출자 세션을 한 번도 안 쓴 것.
    caller.bind = engine
    try:
        w = await _world(Session)
        await _walk_to_verification(Session, w)
        await _walk_to_pending_approval(Session, w, draft_id=None)
        await emit_recipe_published_stage_event(
            caller, org_id=w["org_id"], work_item_type="story", work_item_id=w["story_id"],
            definition_key=_KEY, next_stage="published",
        )
        assert await _published_events(Session, w) == 1
    finally:
        await engine.dispose()


async def test_hosted_blog_not_linked_by_this_run_is_not_auto_published():
    """4572 P1 연결(4192 발행 경로) — 레시피 회차가 «발행 승인 대기»에 연결한 초안이 이 자사 블로그 초안이 **아니면**(버려진
    회차·다른 초안) 승인해도 서버가 발행하지 않는다(사람 클릭 흐름) · published 이벤트 0. 양성 짝은
    `test_hosted_blog_in_recipe_is_published_by_server_on_approval`(연결 == 이 초안 → 발행 1 · 이벤트 1 · 서버가 낸 단계
    이벤트에도 연결을 실어 승인 알림이 레시피 문맥 문구 — 그 이벤트에서 연결을 빼면 양성 짝이 RED). 뮤테이션: resolver의
    연결 대조(`linked`)를 빼면 발행 1로 RED(실측)."""
    from app.main import app
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_verification(Session, w)
        gate_id, _draft_id = await _submit_hosted(app, Session, w, "hosted-unlinked")
        await _walk_to_pending_approval(Session, w, draft_id=uuid.uuid4())
        await _approve(Session, w, gate_id)

        assert await _site_posts(Session, w) == 0
        async with Session() as s:
            assert (await s.get(Gate, gate_id)).publish_outcome is None
        assert await _published_events(Session, w) == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()



def _pg_error_on_first_call_for_org(org_id, real):
    """실 PG 오류로 트랜잭션을 깨는 대역 — 지정 org의 **첫 호출**만 없는 테이블을 조회한 뒤 진짜 함수로 넘긴다(넘겨받은
    세션이 워커 세션이면 워커 트랜잭션이 aborted, 격리 세션이면 그 세션만)."""
    seen = {"n": 0}

    async def _wrapped(db, *a, **kw):
        if kw.get("org_id") == org_id and seen["n"] == 0:
            seen["n"] += 1
            from sqlalchemy import text

            await db.execute(text("SELECT * FROM no_such_table_4192_ctx"))
        return await real(db, *a, **kw)

    return _wrapped


async def test_site_worker_context_lookup_pg_error_does_not_break_the_batch(monkeypatch, live_wordpress_stub):
    """까디르 4583 P1 — «발행 뒤 레시피 처리»의 **앞단**(레시피 문맥 조회)에서 실 PG 오류가 나도 워커 배치가 산다: 같은 배치
    외부 블로그 명령 둘 → 둘 다 completed(새 세션 재조회) · 오류 난 쪽 이벤트 0 · 다른 쪽 이벤트 1. 이 배치 결과는 격리를
    빼도 같게 나온다(워커가 completed를 먼저 커밋 → 깨진 트랜잭션의 COMMIT이 조용한 ROLLBACK) — 격리 자체는
    `test_site_after_publish_recipe_step_never_touches_the_worker_session`이 가른다(실측)."""
    import app.routers.events as events
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        worlds, gates = [], []
        for i in range(2):
            w = await _world(Session)
            await _walk_to_verification(Session, w)
            gate_id, draft_id = await _submit_external(app, Session, w, live_wordpress_stub, f"ctx-{i}")
            await _walk_to_pending_approval(Session, w, draft_id=draft_id)
            await _approve(Session, w, gate_id)
            worlds.append(w)
            gates.append(gate_id)

        monkeypatch.setattr(
            events, "resolve_site_post_recipe_context",
            _pg_error_on_first_call_for_org(worlds[0]["org_id"], events.resolve_site_post_recipe_context),
        )
        async with Session() as s:
            counts = await process_due_publication_commands(s)
            await s.commit()
        assert counts["completed"] == 2, counts
        async with Session() as fresh:
            statuses = [
                (await fresh.execute(select(PublicationCommand.status).where(PublicationCommand.gate_id == g))).scalar_one()
                for g in gates
            ]
        assert statuses == ["completed", "completed"]
        assert await _published_events(Session, worlds[0]) == 0
        assert await _published_events(Session, worlds[1]) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_hosted_auto_publish_pg_error_keeps_the_approval_and_records_failure(monkeypatch):
    """까디르 4583 P1(승인 트랜잭션) + P2 — 레시피 회차 자사 블로그 초안 게이트를 **실 전이 엔드포인트**로 승인하는데 서버
    발행이 실 PG 오류로 실패해도: 응답 200(500 아님) · 새 세션 재조회로 승인 유지 · `publish_outcome=publish_failed:*` ·
    공개 글 0 · 이벤트 0 · 승인 알림 «다음 행동»은 «자동 발행돼요»가 아니라 실패 문구(P2). 뮤테이션: 발행을 격리 세션이
    아니라 호출자 세션에서 하면 RED(500 · 승인 소실)."""
    import app.services.site_posts as site_posts
    from app.main import app
    from app.models.gate import Gate
    from app.routers.events import _render_gate_verdict_message
    from app.services.i18n_catalog import t

    async def _broken_publish(db, **kw):
        from sqlalchemy import text

        await db.execute(text("SELECT * FROM no_such_table_4192_publish"))

    monkeypatch.setattr(site_posts, "publish_site_post_from_draft", _broken_publish)

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_verification(Session, w)
        gate_id, draft_id = await _submit_hosted(app, Session, w, "hosted-pgerr")
        await _walk_to_pending_approval(Session, w, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["human_user_id"], agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/gates/{gate_id}/transition", json={
                "status": "approved", "note": "발행 승인", "evidence_viewed": True,
            })
        assert r.status_code == 200, r.text

        async with Session() as fresh:
            gate = await fresh.get(Gate, gate_id)
            assert gate.status == "approved"
            assert (gate.publish_outcome or "").startswith("publish_failed:"), gate.publish_outcome
            rendered = await _render_gate_verdict_message(fresh, org_id=w["org_id"], payload={
                "work_item_type": "story", "work_item_id": str(w["story_id"]), "gate_type": "external_publish",
                "verdict": "approved", "resolver_member_id": str(w["human_id"]), "gate_id": str(gate_id),
            })
        assert await _site_posts(Session, w) == 0
        assert await _published_events(Session, w) == 0
        assert t("events.gate_verdict_next_action_recipe_site_auto_publish", "ko") not in rendered, rendered
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_scheduled_worker_context_lookup_pg_error_keeps_completed(monkeypatch):
    """까디르 4583 P1(채널 예약 분기) — 채널 예약 발행 성공 뒤 레시피 문맥 조회(`resolve_recipe_context_for_scheduled_
    publication`)에서 실 PG 오류가 나도: 워커 정상 종료 · 새 세션 재조회 completed · 두 번째 tick 발행 0. 레시피 게이트
    outcome 기록도 격리 세션이라 워커 트랜잭션을 안 건드린다. 뮤테이션: 조회를 워커 세션에서 하면 RED."""
    from datetime import datetime, timedelta, timezone

    import app.services.channel_posts as channel_posts
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
            org_id, project_id, owner_member_id = await seed_org_with_human_owner(s, slug="4192cx", org_name="Org4192cx")
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

        monkeypatch.setattr(
            channel_posts, "resolve_recipe_context_for_scheduled_publication",
            _pg_error_on_first_call_for_org(org_id, channel_posts.resolve_recipe_context_for_scheduled_publication),
        )
        later = datetime.now(timezone.utc) + timedelta(minutes=10)
        async with Session() as s:
            await process_due_publication_commands(s, now=later)
            await s.commit()
        async with Session() as fresh:
            cmd = (await fresh.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == scoped_gate_id)
            )).scalar_one()
            assert cmd.status == "completed", cmd.status
            pubs = (await fresh.execute(
                select(func.count()).select_from(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one()
        async with Session() as s:
            counts = await process_due_publication_commands(s, now=later + timedelta(minutes=10))
            await s.commit()
        assert counts.get("completed", 0) == 0, counts
        async with Session() as fresh:
            assert (await fresh.execute(
                select(func.count()).select_from(ChannelPublication).where(ChannelPublication.gate_id == scoped_gate_id)
            )).scalar_one() == pubs
    finally:
        await engine.dispose()


async def test_site_after_publish_recipe_step_never_touches_the_worker_session(live_wordpress_stub):
    """까디르 4583 P1 — 계약 고정: 외부 블로그 발행 뒤 레시피 처리(`_emit_recipe_published_for_site_post_command`)는 워커
    세션을 **읽기조차** 하지 않는다. 세션 메서드가 전부 터지는 대역(엔진만 빌려 줌)을 넘겨도 게이트 읽기·문맥 조회·이벤트가
    격리 세션에서 끝나 이벤트 1. (배치 테스트만으로는 이 경로의 격리를 못 가른다 — 워커가 completed를 먼저 커밋하므로 깨진
    트랜잭션의 COMMIT이 조용한 ROLLBACK이 돼 배치 결과가 같다.) 뮤테이션: 워커 세션에서 조회 → 대역 폭발로 이벤트 0 RED."""
    from unittest.mock import MagicMock

    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import _emit_recipe_published_for_site_post_command

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_verification(Session, w)
        gate_id, draft_id = await _submit_external(app, Session, w, live_wordpress_stub, "contract")
        await _walk_to_pending_approval(Session, w, draft_id=draft_id)
        await _approve(Session, w, gate_id)
        async with Session() as s:
            command = (await s.execute(select(PublicationCommand).where(PublicationCommand.gate_id == gate_id))).scalar_one()

        worker = MagicMock(spec=AsyncSession)
        for name in ("execute", "commit", "rollback", "flush", "get", "begin_nested", "scalar", "scalars", "add", "refresh"):
            setattr(worker, name, MagicMock(side_effect=AssertionError(f"워커 세션 {name} 사용")))
        worker.bind = engine
        await _emit_recipe_published_for_site_post_command(worker, command)
        assert await _published_events(Session, w) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_hosted_blog_in_recipe_is_published_through_the_real_transition_endpoint():
    """story #4229(까디르 4583 P3 ①) — 레시피 회차 자사 블로그 초안 게이트를 **실 전이 엔드포인트**
    (`POST /api/v2/gates/{id}/transition`)로 승인하면, 라우터가 승인 커밋 뒤 서버 발행까지 부른다: 응답 200 · 공개 글 1 ·
    `publish_outcome=published` · published 이벤트 1 · 승인 알림 «다음 행동»은 자동 발행 문구(전부 새 세션 재조회).
    뮤테이션: 전이 엔드포인트의 커밋 뒤 발행 호출(`publish_recipe_approved_hosted_site_draft_after_commit`)을 빼면 공개 글 0 ·
    이벤트 0으로 RED(실측)."""
    from app.main import app
    from app.models.gate import Gate
    from app.routers.events import _render_gate_verdict_message
    from app.services.i18n_catalog import t

    engine, Session = await _session_factory()
    try:
        w = await _world(Session)
        await _walk_to_verification(Session, w)
        gate_id, draft_id = await _submit_hosted(app, Session, w, "hosted-endpoint")
        await _walk_to_pending_approval(Session, w, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["human_user_id"], agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/gates/{gate_id}/transition", json={
                "status": "approved", "note": "발행 승인", "evidence_viewed": True,
            })
        assert r.status_code == 200, r.text

        assert await _site_posts(Session, w) == 1
        async with Session() as fresh:
            gate = await fresh.get(Gate, gate_id)
            assert gate.status == "approved" and gate.publish_outcome == "published", gate.publish_outcome
            assert gate.resolver_id == w["human_id"]
            rendered = await _render_gate_verdict_message(fresh, org_id=w["org_id"], payload={
                "work_item_type": "story", "work_item_id": str(w["story_id"]), "gate_type": "external_publish",
                "verdict": "approved", "resolver_member_id": str(w["human_id"]), "gate_id": str(gate_id),
            })
        assert await _published_events(Session, w) == 1
        assert t("events.gate_verdict_next_action_recipe_site_auto_publish", "ko") in rendered, rendered
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_channel_after_publish_recipe_step_never_touches_the_worker_session():
    """story #4229(까디르 4583 P3 ②) — site 쪽 `test_site_after_publish_recipe_step_never_touches_the_worker_session`의 채널
    짝: 예약 채널 발행 성공 뒤 레시피 처리(`_emit_recipe_published_for_channel_command`)는 워커 세션을 **읽기조차** 하지
    않는다. 세션 메서드가 전부 터지는 대역(엔진만 빌려 줌)을 넘겨도 레시피 문맥 조회 · 레시피 게이트
    `publish_outcome=published` 기록 · published 이벤트가 격리 세션에서 끝난다(새 세션 재조회). (배치 테스트
    `test_channel_scheduled_worker_context_lookup_pg_error_keeps_completed`만으로는 격리를 못 가른다 — 워커가 completed를
    먼저 커밋하므로 깨진 트랜잭션의 COMMIT이 조용한 ROLLBACK이 돼 배치 결과가 같다.)
    뮤테이션: 레시피 문맥 조회를 워커 세션(`db`)으로 되돌리면 대역이 터져 이벤트 0 · outcome 그대로로 RED(실측)."""
    from unittest.mock import MagicMock

    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.channel_post_draft import ChannelPostDraft
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.routers.events import _find_existing_stage_publish
    from app.services.publication_command import _emit_recipe_published_for_channel_command
    from tests.conftest import seed_org_with_human_owner
    from tests.test_4093_scheduled_publish_event_realdb import (
        _KEY as _CH_KEY,
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
            org_id, project_id, owner_member_id = await seed_org_with_human_owner(s, slug="4229ch", org_name="Org4229ch")
            await _ch_seed_default_role(s, org_id)
            await _seed_system_publisher_teammember_shim(s, org_id, project_id)
            creator_id = await _ch_seed_agent(s, org_id, project_id, name="댄")
            story_id = await _ch_seed_story(s, org_id, project_id)
            await _seed_definition(s)
            connection_id = await _seed_sandbox_connection(s, org_id)
            await _seed_recipe_channel_binding(s, org_id, connection_id)
            gate_d_id, scoped_gate_id, draft_id = await _approve_and_schedule_submit(
                s, org_id=org_id, story_id=story_id, creator_id=creator_id, owner_member_id=owner_member_id,
                connection_id=connection_id,
            )
        async with Session() as s:
            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == scoped_gate_id)
            )).scalar_one()
            draft = await s.get(ChannelPostDraft, draft_id)

        worker = MagicMock(spec=AsyncSession)
        for name in ("execute", "commit", "rollback", "flush", "get", "begin_nested", "scalar", "scalars", "add", "refresh"):
            setattr(worker, name, MagicMock(side_effect=AssertionError(f"워커 세션 {name} 사용")))
        worker.bind = engine
        await _emit_recipe_published_for_channel_command(worker, command, draft)

        async with Session() as fresh:
            assert (await fresh.get(Gate, gate_d_id)).publish_outcome == "published"
            assert await _find_existing_stage_publish(
                fresh, org_id=org_id, definition_key=_CH_KEY, work_item_type="story",
                work_item_id=str(story_id), stage="published",
            ) is not None
    finally:
        await engine.dispose()
