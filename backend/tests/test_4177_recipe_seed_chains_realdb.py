"""story #4177(E-RECIPE-2·도구 검증) — 레시피 2~4호(블로그 · 뉴스레터 · SNS 텍스트)의 **실 시드 정의** 하나를 처음부터 끝까지
한 번에 돈다. 구간 테스트(4174 · 4175 · 4176 · 4189 · 4190 · 4192 · 4214 · 4242)는 각자 픽스처라 구간 사이 이음매를 재지 않았다
(4242가 감사로만 드러난 부류).

체인 한 회차:
- 적용: 실 시드 정의에 에이전트 멤버(Creator · Publisher) + 테스트 사람 멤버(Director = org owner) + 0-reach 채널 연결을
  적용 엔드포인트로 묶는다.
- 시작: 사람이 스토리에서 첫 단계를 발행한다(FE «레시피 시작»과 같은 `POST /api/v2/events/publish`).
- 에이전트 단계: 직전 멘션(단계 이벤트 본문 또는 게이트 승인 알림)의 `publish_event({...})` 예시를 **그대로** 발행한다.
  테스트가 예시를 새로 쓰지 않는다(최저 지능 기준). 예외 1곳만 이름 붙여 둔다 — 블로그 `pending_approval` 예시의
  `site_post_draft_id` 자리 표시를 제출한 초안 id로 바꾸는 치환(`_SITE_DRAFT_PLACEHOLDER_SUBSTITUTIONS`).
- 게이트: 테스트 사람 멤버가 실 전이 엔드포인트로 승인한다.
- 발행: 0-reach 어댑터(블로그 WordPress 스텁 · 뉴스레터 stibee_sandbox · SNS sandbox). 실 채널 · 실 도메인 · 실 수신자 0.
- 끝: 마지막 단계 이벤트 정확히 1.

이음매 단언: 모든 단계 이벤트의 수신자 ≥ 1(서버가 낸 단계 포함, 리졸버 결과 그 자체 — 대화 참가자엔 시스템 발신자가
섞여 수로 못 잰다) · 게이트 봉인 필드 안내가 다음 담당자의 멘션에 도달.

실 시드: 이 하네스는 스키마 재생성(create_all) 위에서 돈다. 시드 행은 시드 마이그레이션의 `upgrade()`를 **그대로 실행**해
심는다(상수를 테스트에 옮겨 적지 않는다 · 뒤따른 패치 0400 · 0401 · 0402도 그대로). 이 레시피들을 건드리는 마이그레이션이
새로 생기면 `test_seed_migration_list_covers_every_migration_touching_these_recipes`가 목록 갱신을 요구한다.

체인이 멈추는 자리는 이 PR에서 제품 코드를 고치지 않는다 — 새 결함 카드로 연다(카드 경계).
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from tests.recipe_reviewed_draft import reviewed_draft_body_via
from tests.test_4090_ac2_recipe_auto_publish_realdb import (
    _client_for,
    _realdb_session,
    _seed_agent,
    _seed_default_role,
    _seed_org_with_owner,
    _seed_sandbox_connection,
    _seed_story,
    _seed_system_publisher_teammember_shim,
    _setup_org_scoped_app,
)
from tests.test_3330_gate_verdict_notification import _seed_preset_gate_verdict_definition
from tests.test_3497_insight_snapshots import _seed_channel_connection
from tests.test_e4fc29fa_site_post_orchestration import (  # noqa: F401 — live_wordpress_stub는 fixture
    _seed_wordpress_connection,
    live_wordpress_stub,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_BLOG = "preset.marketing.blog_article"
_NEWSLETTER = "preset.marketing.newsletter"
_SNS_TEXT = "preset.marketing.social_text_post"

_VERSIONS_DIR = Path(__file__).resolve().parents[1] / "alembic" / "versions"
# 이 세 레시피의 시드 행을 만들거나 바꾸는 마이그레이션 — 리비전 순서 그대로.
_SEED_MIGRATIONS = ("0396", "0398", "0399", "0400", "0401", "0402")

# 블로그 `verification` 멘션의 `pending_approval` 예시는 `site_post_draft_id`를 자리 표시로 싣는다(events.py — 그 멘션을
# 그리는 시점엔 아직 제출된 초안이 없다). 체인이 예시를 고치는 곳은 이 한 곳뿐이다.
_SITE_DRAFT_PLACEHOLDER_SUBSTITUTIONS = 1


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


# ── 실 시드 ────────────────────────────────────────────────────────────────────────────────────────────


def _migration_path(revision: str) -> Path:
    return next(_VERSIONS_DIR.glob(f"{revision}_*.py"))


def _load_migration(revision: str):
    import importlib.util

    spec = importlib.util.spec_from_file_location(f"_m4177_{revision}", _migration_path(revision))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _install_real_seeds() -> None:
    """시드 마이그레이션의 `upgrade()`를 그대로 실행한다(ON CONFLICT DO NOTHING · jsonb_set이라 한 DB에서 여러 번 불러도 같다).
    alembic과 같은 동기 드라이버(psycopg2 — alembic/env.py가 asyncpg URL을 바꾸는 규칙 그대로)로 돈다. 0400 · 0401 · 0402는
    경로를 문자열로 넘겨 `CAST(:path AS text[])`로 바꾸는데, asyncpg는 그 인자를 배열로만 받는다."""
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import create_engine

    url = _REAL_DB_URL
    for prefix in ("postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg2://" + url[len(prefix):]
            break
    modules = [_load_migration(revision) for revision in _SEED_MIGRATIONS]
    engine = create_engine(url)
    try:
        with engine.begin() as conn, Operations.context(MigrationContext.configure(connection=conn)):
            for module in modules:
                module.upgrade()
    finally:
        engine.dispose()


def test_seed_migration_list_covers_every_migration_touching_these_recipes():
    """새 마이그레이션이 이 레시피 시드를 바꾸면 체인이 옛 시드로 돌지 않게 — 목록에 넣으라고 알린다."""
    touching = sorted(
        path.name.split("_", 1)[0]
        for path in _VERSIONS_DIR.glob("*.py")
        if any(key in path.read_text(encoding="utf-8") for key in (_BLOG, _NEWSLETTER, _SNS_TEXT))
    )
    assert touching == sorted(_SEED_MIGRATIONS), touching


# ── 세계 · 행동 ────────────────────────────────────────────────────────────────────────────────────────


async def _world(Session, slug: str) -> dict:
    async with Session() as s:
        # 게이트 승인 알림(다음 단계 담당에게 가는 멘션)의 정의 — 여러 마이그레이션이 쌓아 만든 행이라 기존 하네스 그대로 심는다.
        await _seed_preset_gate_verdict_definition(s)
        org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug=f"{slug}-{uuid.uuid4().hex[:6]}")
        await _seed_default_role(s, org_id)
        await _seed_system_publisher_teammember_shim(s, org_id, project_id)
        creator_id = await _seed_agent(s, org_id, project_id, name="Creator 에이전트")
        publisher_id = await _seed_agent(s, org_id, project_id, name="Publisher 에이전트")
        story_id = await _seed_story(s, org_id, project_id, title=f"레시피 체인 {slug}")
    return {
        "org_id": org_id, "project_id": project_id, "owner_member_id": owner_member_id, "owner_user_id": owner_user_id,
        "creator_id": creator_id, "publisher_id": publisher_id, "story_id": story_id,
    }


def _as_owner(app, Session, w) -> None:
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=w["owner_user_id"], agent=False)


def _as_agent(app, Session, w, agent_id) -> None:
    _setup_org_scoped_app(app, Session, w["org_id"], user_id=agent_id, agent=True)


async def _definition_id(Session, key: str) -> uuid.UUID:
    from sqlalchemy import select

    from app.models.event_definition import EventDefinition

    async with Session() as s:
        return (await s.execute(
            select(EventDefinition.id).where(EventDefinition.key == key, EventDefinition.org_id.is_(None))
        )).scalar_one()


async def _apply(app, Session, w, key: str, role_mapping: dict[str, uuid.UUID]) -> None:
    """적용 창과 같은 엔드포인트 — 사람(org owner)이 역할을 묶는다."""
    definition_id = await _definition_id(Session, key)
    _as_owner(app, Session, w)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/events/definitions/{definition_id}/apply",
            json={"project_id": str(w["project_id"]), "role_mapping": {k: str(v) for k, v in role_mapping.items()}},
        )
    assert r.status_code == 201, r.text
    assert r.json()["bindings_upserted"] == len(role_mapping), r.json()


async def _publish(app, Session, w, *, actor: str, body: dict) -> dict:
    """actor = "owner" | 에이전트 멤버 id 키("creator_id" · "publisher_id")."""
    if actor == "owner":
        _as_owner(app, Session, w)
    else:
        _as_agent(app, Session, w, w[actor])
    async with _client_for(app) as client:
        r = await client.post("/api/v2/events/publish", json=body)
    assert r.status_code == 201, f"{body['payload'].get('stage')} 발행 실패: {r.status_code} {r.text}"
    return r.json()


async def _start(app, Session, w, key: str, first_stage: str) -> None:
    await _publish(app, Session, w, actor="owner", body={
        "definition_key": key,
        "payload": {"stage": first_stage, "work_item_type": "story", "work_item_id": str(w["story_id"])},
    })


async def _approve(app, Session, w, gate_id: uuid.UUID, *, note: str) -> dict:
    """결재함과 같은 전이 엔드포인트 — 테스트 사람 멤버(org owner)가 승인한다. 승인 화면에 초안이 보이면 그 초안을 본 것으로 싣는다."""
    reviewed = await reviewed_draft_body_via(Session, org_id=w["org_id"], work_item_id=w["story_id"])
    _as_owner(app, Session, w)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/gates/{gate_id}/transition",
            json={"status": "approved", "note": note, "evidence_viewed": True, **reviewed},
        )
    assert r.status_code == 200, r.text
    return r.json()


# ── 멘션 · 수신자 ──────────────────────────────────────────────────────────────────────────────────────


def _publish_example(content: str) -> dict:
    """멘션 본문의 `publish_event({...})` 예시 — 그대로 발행할 body."""
    marker = "publish_event("
    assert marker in content, f"멘션에 발행 예시가 없다:\n{content}"
    example, _end = json.JSONDecoder().raw_decode(content, content.index(marker) + len(marker))
    return example


async def _stage_message(Session, w, key: str, stage: str):
    from app.routers.events import _find_existing_stage_publish

    async with Session() as s:
        message = await _find_existing_stage_publish(
            s, org_id=w["org_id"], definition_key=key, work_item_type="story", work_item_id=str(w["story_id"]), stage=stage,
        )
    assert message is not None, f"{key} {stage} 단계 이벤트가 안 났다 — 체인이 여기서 멈췄다"
    return message


async def _stage_event_count(Session, w, key: str, stage: str) -> int:
    from sqlalchemy import text

    async with Session() as s:
        return (await s.execute(text(
            "SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id "
            "WHERE c.org_id = :org AND m.metadata->'event'->>'event_key' = :key "
            "AND m.metadata->'event'->'payload'->>'stage' = :stage "
            "AND m.metadata->'event'->'payload'->>'work_item_id' = :wi"
        ), {"org": w["org_id"], "key": key, "stage": stage, "wi": str(w["story_id"])})).scalar_one()


async def _assert_reaches(Session, w, key: str, stage: str, expected_member_id: uuid.UUID) -> None:
    """이음매 — 그 단계 이벤트의 수신자(리졸버 결과) = 그 단계를 이어 갈 멤버 1명 이상이고, 그 멤버가 이벤트 대화에 있다."""
    from sqlalchemy import select

    from app.models.conversation import ConversationParticipant
    from app.services.event_routing_resolver import _resolve_recipe_role_binding

    message = await _stage_message(Session, w, key, stage)
    async with Session() as s:
        recipients = await _resolve_recipe_role_binding(
            s, org_id=w["org_id"], definition_key=key,
            payload={"stage": stage, "work_item_type": "story", "work_item_id": str(w["story_id"])},
        )
        participants = set((await s.execute(
            select(ConversationParticipant.member_id).where(ConversationParticipant.conversation_id == message.conversation_id)
        )).scalars().all())
    assert recipients, f"{key} {stage} 단계 이벤트의 수신자가 0이다 — 흐름이 여기서 끊긴다"
    assert expected_member_id in recipients, (stage, recipients)
    assert expected_member_id in participants, f"{stage} 단계 담당이 이벤트 대화에 없다"


async def _gate(Session, w, gate_type: str):
    from sqlalchemy import select

    from app.models.gate import Gate

    async with Session() as s:
        return (await s.execute(
            select(Gate).where(Gate.org_id == w["org_id"], Gate.work_item_id == w["story_id"], Gate.gate_type == gate_type)
            .order_by(Gate.created_at.desc()).limit(1)
        )).scalar_one()


async def _verdict_message(Session, w, gate_id: uuid.UUID):
    """게이트 승인 알림(preset.gate.verdict) — 승인 뒤 다음 단계 담당이 받는 멘션."""
    from sqlalchemy import select, text

    from app.models.conversation import ConversationMessage

    async with Session() as s:
        message = (await s.execute(
            select(ConversationMessage).where(
                text("conversation_messages.metadata->'event'->>'event_key' = 'preset.gate.verdict'"),
                text("conversation_messages.metadata->'event'->'payload'->>'gate_id' = :gate_id"),
            ).params(gate_id=str(gate_id))
        )).scalars().first()
    assert message is not None, f"게이트 {gate_id} 승인 알림이 없다"
    return message


# ── 0-reach 초안 ───────────────────────────────────────────────────────────────────────────────────────


async def _create_site_draft(app, Session, w, connection_id, slug: str) -> uuid.UUID:
    _as_agent(app, Session, w, w["creator_id"])
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/organizations/{w['org_id']}/site-posts/drafts",
            json={
                "work_item_id": str(w["story_id"]), "title": "체인 글", "slug": slug, "lang": "ko",
                "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
                "connection_id": str(connection_id),
            },
        )
    assert r.status_code == 201, r.text
    return uuid.UUID(r.json()["draft_id"])


async def _submit_site_draft(app, Session, w, draft_id: uuid.UUID) -> uuid.UUID:
    _as_agent(app, Session, w, w["creator_id"])
    async with _client_for(app) as client:
        r = await client.post(f"/api/v2/organizations/{w['org_id']}/site-posts/drafts/{draft_id}/submit", json={})
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["gate_id"])


async def _submit_channel_draft(app, Session, w, connection_id, *, text: str, channel_payload: dict | None = None) -> None:
    _as_agent(app, Session, w, w["creator_id"])
    body = {"work_item_id": str(w["story_id"]), "connection_id": str(connection_id), "text": text}
    if channel_payload is not None:
        body["channel_payload"] = channel_payload
    async with _client_for(app) as client:
        r = await client.post(f"/api/v2/organizations/{w['org_id']}/channel-posts/drafts", json=body)
        assert r.status_code == 201, r.text
        r_submit = await client.post(
            f"/api/v2/organizations/{w['org_id']}/channel-posts/drafts/{r.json()['draft_id']}/submit", json={},
        )
    assert r_submit.status_code == 200, r_submit.text


# ── 체인 ───────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_blog_article_seed_runs_start_to_publish_checked(live_wordpress_stub):
    """블로그(7단계) — 기획 → 컨셉 승인(게이트) → 작성 → 검수 → 발행 승인 대기(초안 게이트) → 발행(서버 · WordPress 스텁)
    → 발행 확인."""
    from app.main import app
    from app.routers.dev_wordpress_stub import _POSTS
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _realdb_session()
    try:
        _install_real_seeds()
        w = await _world(Session, "blog")
        creator, publisher, owner = w["creator_id"], w["publisher_id"], w["owner_member_id"]
        async with Session() as s:
            wordpress_id = await _seed_wordpress_connection(s, w["org_id"], site_url=live_wordpress_stub)
        await _apply(app, Session, w, _BLOG, {
            "planning": creator, "concept_confirmed": owner, "writing": creator, "verification": creator,
            "pending_approval": owner, "published": publisher, "publish_checked": publisher,
        })
        posts_before = len(_POSTS)

        await _start(app, Session, w, _BLOG, "planning")
        await _assert_reaches(Session, w, _BLOG, "planning", creator)

        example = _publish_example((await _stage_message(Session, w, _BLOG, "planning")).content)
        await _publish(app, Session, w, actor="creator_id", body=example)
        await _assert_reaches(Session, w, _BLOG, "concept_confirmed", owner)

        concept_gate = await _gate(Session, w, "concept_approval")
        await _approve(app, Session, w, concept_gate.id, note="컨셉 승인")
        example = _publish_example((await _verdict_message(Session, w, concept_gate.id)).content)
        await _publish(app, Session, w, actor="creator_id", body=example)
        await _assert_reaches(Session, w, _BLOG, "writing", creator)

        # 작성 단계 일: 초안을 만든다(draft_site_post).
        draft_id = await _create_site_draft(app, Session, w, wordpress_id, slug=f"chain-{uuid.uuid4().hex[:6]}")
        example = _publish_example((await _stage_message(Session, w, _BLOG, "writing")).content)
        await _publish(app, Session, w, actor="creator_id", body=example)
        await _assert_reaches(Session, w, _BLOG, "verification", creator)
        # PO 판정 자료(자리 표시가 필요한가) — 검수 멘션을 그리는 시점에 이 스토리의 블로그 초안은 이미 하나 있다(작성 단계가 만든 것 ·
        # 아직 제출 전). 멘션은 그 초안 id 대신 자리 표시를 싣는다.
        async with Session() as s:
            from sqlalchemy import select

            from app.models.site_post_draft import SitePostDraft

            drafts_at_render = (await s.execute(
                select(SitePostDraft.id, SitePostDraft.status).where(SitePostDraft.work_item_id == w["story_id"])
            )).all()
        assert [(d.id, d.status) for d in drafts_at_render] == [(draft_id, "draft")], drafts_at_render

        # 검수 단계 일: 초안을 제출한다(submit_site_post). 예시의 초안 자리 표시는 제출한 초안 id로 바꾼다(유일한 치환).
        site_gate_id = await _submit_site_draft(app, Session, w, draft_id)
        example = _publish_example((await _stage_message(Session, w, _BLOG, "verification")).content)
        substitutions = 0
        if example["payload"].get(RECIPE_SITE_DRAFT_LINK_FIELD, "").startswith("<"):
            example["payload"][RECIPE_SITE_DRAFT_LINK_FIELD] = str(draft_id)
            substitutions += 1
        assert substitutions == _SITE_DRAFT_PLACEHOLDER_SUBSTITUTIONS
        await _publish(app, Session, w, actor="creator_id", body=example)
        await _assert_reaches(Session, w, _BLOG, "pending_approval", owner)

        # 사람이 초안 게이트를 승인 → 발행 명령 → 워커가 WordPress 스텁에 발행 → 서버가 published를 낸다.
        await _approve(app, Session, w, site_gate_id, note="발행 승인")
        async with Session() as s:
            counts = await process_due_publication_commands(s)
            await s.commit()
        assert counts.get("completed") == 1, counts
        assert len(_POSTS) == posts_before + 1, "WordPress 스텁에 글이 안 올라갔다"
        assert await _stage_event_count(Session, w, _BLOG, "published") == 1
        await _assert_reaches(Session, w, _BLOG, "published", publisher)

        example = _publish_example((await _stage_message(Session, w, _BLOG, "published")).content)
        await _publish(app, Session, w, actor="publisher_id", body=example)
        await _assert_reaches(Session, w, _BLOG, "publish_checked", publisher)
        assert await _stage_event_count(Session, w, _BLOG, "publish_checked") == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def _count_sandbox_sends(monkeypatch) -> list[str]:
    import app.services.stibee_sandbox_campaign as sandbox_module

    sends: list[str] = []
    real_send = sandbox_module.send_campaign

    async def _counting_send(**kwargs):
        sends.append(kwargs["campaign_id"])
        return await real_send(**kwargs)

    monkeypatch.setattr(sandbox_module, "send_campaign", _counting_send)
    return sends


async def _newsletter_chain_to_send_approval(app, Session, w):
    """뉴스레터 — 소재 → 초안 → 검수(외부 발행 게이트 · stibee_sandbox 초안) → 캠페인 생성(서버) → 발송 요청(봉인 게이트) 승인까지.
    (발송 요청 예시, 발송 게이트)를 돌려준다."""
    from app.services.recipe_gate_hooks import _GATE_TYPE_SEALED_FIELDS

    creator, publisher, owner = w["creator_id"], w["publisher_id"], w["owner_member_id"]
    async with Session() as s:
        stibee = await _seed_channel_connection(s, w["org_id"], channel="stibee_sandbox")
    await _apply(app, Session, w, _NEWSLETTER, {
        "collect": creator, "draft": creator, "review": owner, "campaign_created": stibee.id,
        "send_requested": publisher, "send_checked": publisher,
    })

    await _start(app, Session, w, _NEWSLETTER, "collect")
    await _assert_reaches(Session, w, _NEWSLETTER, "collect", creator)

    example = _publish_example((await _stage_message(Session, w, _NEWSLETTER, "collect")).content)
    await _publish(app, Session, w, actor="creator_id", body=example)
    await _assert_reaches(Session, w, _NEWSLETTER, "draft", creator)

    # 초안 단계 일: 같은 스토리에 채널 초안을 만들어 제출(멘션의 자동 발행 안내 그대로) → 검수 단계로.
    await _submit_channel_draft(
        app, Session, w, stibee.id, text="이번 달 소식입니다.", channel_payload={"subject": "체인 소식지"},
    )
    example = _publish_example((await _stage_message(Session, w, _NEWSLETTER, "draft")).content)
    await _publish(app, Session, w, actor="creator_id", body=example)
    await _assert_reaches(Session, w, _NEWSLETTER, "review", owner)

    # 사람이 검수 게이트를 승인 → 서버가 sandbox 캠페인을 만들고 campaign_created를 낸다 → 발송 요청 담당에게 간다(4242).
    review_gate = await _gate(Session, w, "external_publish")
    await _approve(app, Session, w, review_gate.id, note="캠페인 만들기 승인")
    assert await _stage_event_count(Session, w, _NEWSLETTER, "campaign_created") == 1
    await _assert_reaches(Session, w, _NEWSLETTER, "campaign_created", publisher)

    # 봉인 필드 안내가 다음 담당자의 멘션에 도달 — 예시에 세 필드가 실값으로 실려 있다.
    campaign_message = await _stage_message(Session, w, _NEWSLETTER, "campaign_created")
    example = _publish_example(campaign_message.content)
    for spec in _GATE_TYPE_SEALED_FIELDS["newsletter_send"]:
        assert spec.name in example["payload"], f"봉인 필드 {spec.name} 안내가 발송 요청 담당에게 안 갔다"
    assert example["payload"]["publication_id"] == campaign_message.msg_metadata["event"]["payload"]["publication_id"]
    await _publish(app, Session, w, actor="publisher_id", body=example)
    await _assert_reaches(Session, w, _NEWSLETTER, "send_requested", publisher)

    send_gate = await _gate(Session, w, "newsletter_send")
    await _approve(app, Session, w, send_gate.id, note="발송 승인")
    return example, send_gate


@pytest.mark.anyio
async def test_newsletter_seed_runs_start_to_send_checked(monkeypatch):
    """뉴스레터(6단계) — 발송 요청 승인 → 발송(크론 · 워커 · sandbox) → 발송 결과 확인(서버) 정확히 1.
    발송 승인 알림의 발행 예시는 여기서 따르지 않는다 — 열린 결함 4254(아래 xfail 테스트가 잰다)."""
    from app.main import app
    from app.services.newsletter_send_execution import process_due_newsletter_sends
    from app.services.publication_command import process_due_publication_commands

    sends = _count_sandbox_sends(monkeypatch)
    engine, Session = await _realdb_session()
    try:
        _install_real_seeds()
        w = await _world(Session, "newsletter")
        example, _send_gate = await _newsletter_chain_to_send_approval(app, Session, w)
        scheduled_at = datetime.fromisoformat(example["payload"]["scheduled_at"])
        async with Session() as s:
            assert (await process_due_newsletter_sends(s, now=scheduled_at + timedelta(minutes=1))).get("queued") == 1
        async with Session() as s:
            await process_due_publication_commands(s, now=scheduled_at + timedelta(minutes=2))
        assert len(sends) == 1, "sandbox 발송이 정확히 한 번 일어나지 않았다"
        assert await _stage_event_count(Session, w, _NEWSLETTER, "send_checked") == 1
        await _assert_reaches(Session, w, _NEWSLETTER, "send_checked", w["publisher_id"])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.xfail(
    strict=True, raises=AssertionError,
    reason="열린 결함 story #4254 — 발송 요청 승인 알림이 send_checked 발행 예시를 준다(발송 전 거짓 완료)",
)
@pytest.mark.anyio
async def test_newsletter_send_approval_notice_does_not_advance_before_the_send():
    """발송 요청 승인 알림을 담당이 그대로 따라도(최저 지능 기준) 실제 발송 전에 «발송 결과 확인»이 나지 않는다."""
    from app.main import app

    engine, Session = await _realdb_session()
    try:
        _install_real_seeds()
        w = await _world(Session, "newsletter-verdict")
        _example, send_gate = await _newsletter_chain_to_send_approval(app, Session, w)
        verdict = await _verdict_message(Session, w, send_gate.id)
        if "publish_event(" in verdict.content:
            await _publish(app, Session, w, actor="publisher_id", body=_publish_example(verdict.content))
        assert await _stage_event_count(Session, w, _NEWSLETTER, "send_checked") == 0, (
            "발송 승인 알림이 발송 전에 send_checked 발행을 시켰다:\n" + verdict.content
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def _social_text_chain_to_published(app, Session, w) -> None:
    """SNS 텍스트(5단계) — 초안 → 컨셉 승인(게이트) → 다듬기 → 최종 발행 승인(외부 발행 게이트 · sandbox 초안) → 게시(서버)."""
    from sqlalchemy import select

    from app.models.channel_publication import ChannelPublication

    creator, owner = w["creator_id"], w["owner_member_id"]
    async with Session() as s:
        sandbox_id = await _seed_sandbox_connection(s, w["org_id"])
    await _apply(app, Session, w, _SNS_TEXT, {
        "draft": creator, "concept_confirmed": owner, "editing": creator, "pending_approval": owner,
        "published": sandbox_id,
    })

    await _start(app, Session, w, _SNS_TEXT, "draft")
    await _assert_reaches(Session, w, _SNS_TEXT, "draft", creator)

    example = _publish_example((await _stage_message(Session, w, _SNS_TEXT, "draft")).content)
    await _publish(app, Session, w, actor="creator_id", body=example)
    await _assert_reaches(Session, w, _SNS_TEXT, "concept_confirmed", owner)

    concept_gate = await _gate(Session, w, "concept_approval")
    await _approve(app, Session, w, concept_gate.id, note="컨셉 승인")
    example = _publish_example((await _verdict_message(Session, w, concept_gate.id)).content)
    await _publish(app, Session, w, actor="creator_id", body=example)
    await _assert_reaches(Session, w, _SNS_TEXT, "editing", creator)

    # 다듬기 단계 일: 같은 스토리에 채널 초안을 만들어 제출(멘션의 자동 발행 안내 그대로) → 최종 발행 승인 단계로.
    await _submit_channel_draft(app, Session, w, sandbox_id, text="체인 게시 본문 #레시피")
    example = _publish_example((await _stage_message(Session, w, _SNS_TEXT, "editing")).content)
    await _publish(app, Session, w, actor="creator_id", body=example)
    await _assert_reaches(Session, w, _SNS_TEXT, "pending_approval", owner)

    publish_gate = await _gate(Session, w, "external_publish")
    await _approve(app, Session, w, publish_gate.id, note="최종 발행 승인")
    async with Session() as s:
        publications = (await s.execute(
            select(ChannelPublication).where(ChannelPublication.org_id == w["org_id"])
        )).scalars().all()
    assert [p.status for p in publications] == ["published"], "sandbox 게시가 정확히 한 번 일어나지 않았다"
    assert await _stage_event_count(Session, w, _SNS_TEXT, "published") == 1


@pytest.mark.anyio
async def test_social_text_post_seed_runs_start_to_published():
    """SNS 텍스트 — sandbox 게시 1 · 마지막 단계(published) 이벤트 정확히 1. 그 이벤트의 수신자는 열린 결함 4255(아래 xfail)."""
    from app.main import app

    engine, Session = await _realdb_session()
    try:
        _install_real_seeds()
        w = await _world(Session, "sns")
        await _social_text_chain_to_published(app, Session, w)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.xfail(
    strict=True, raises=AssertionError,
    reason="열린 결함 story #4255 — 마지막 단계가 서버 stage(published)면 수신자 0(게시 결과가 아무에게도 안 감)",
)
@pytest.mark.anyio
async def test_social_text_post_last_server_stage_reaches_previous_stage_member():
    """마지막 단계 published(서버 게시)의 이벤트가 직전 단계(최종 발행 승인) 담당에게 간다(PO 처방 방향 · 4255)."""
    from app.main import app

    engine, Session = await _realdb_session()
    try:
        _install_real_seeds()
        w = await _world(Session, "sns-last")
        await _social_text_chain_to_published(app, Session, w)
        await _assert_reaches(Session, w, _SNS_TEXT, "published", w["owner_member_id"])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
