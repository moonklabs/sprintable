"""story #4174(E-RECIPE-2·레시피 2호) — «블로그 글» 프리셋(0399 시드)의 실 PG 계약.

AC1 시드: org_id NULL · 레지스트리 검증 함수 통과(시드는 raw SQL이라 등록 API 검증을 안 탄다).
    설명 문구의 «7단계»(유나 문안 — ko 시드·en messages 둘 다)가 실제 stage 수와 같다.
AC2 멘션 자기설명(#4076): 각 단계 멘션에 할 일이 있고, 에이전트가 발행하는 다음 단계면 발행 예시가 있다. 다음
    단계가 «서버가 실제 발행 뒤 내는» 단계(`site_post_auto_publish`)면 발행 예시 대신 대기 안내 — 에이전트가 먼저
    `published`를 내면 발행 안 된 글이 «발행됨»으로 보인다. 발행 승인은 초안 게이트 하나라(PO 판정 (a)) 레시피
    단계에는 게이트가 기획 승인뿐이다.
AC4 레시피 문맥 판별(`resolve_site_post_recipe_context`) · 승인 알림 «다음 행동»이 레시피 문맥이면 서버 자동 발행
    문구, 아니면 기존 문구 그대로(레시피 밖 블로그 무회귀).
"""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_KEY = "preset.marketing.blog_article"
_EN_MESSAGES = Path(__file__).resolve().parents[2] / "apps/web/messages/en.json"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _with_session(fn):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_async_url())
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as s:
            return await fn(s)
    finally:
        await engine.dispose()


async def _definition(session):
    from sqlalchemy import select

    from app.models.event_definition import EventDefinition

    row = (await session.execute(
        select(EventDefinition).where(EventDefinition.key == _KEY, EventDefinition.org_id.is_(None))
    )).scalar_one_or_none()
    assert row is not None, f"{_KEY} 시드가 안 보임 — DB가 alembic heads인지 확인"
    return row


def _stages(d) -> list[str]:
    return list(d.payload_schema["properties"]["stage"]["enum"])


async def test_seeded_as_platform_definition_and_passes_registry_validation():
    from app.services import event_definition_registry as reg

    async def body(s):
        d = await _definition(s)
        assert d.enabled is True
        reg.validate_event_definition_key(d.key, org_id=None, org_slug=None)
        reg.validate_event_routing(d.routing)
        reg.validate_event_payload_schema_shape(d.payload_schema)
        reg.validate_block_template(d.block_template)
        reg.validate_block_template_refs(d.payload_schema, d.block_template)
        reg.validate_stage_metadata(d.payload_schema, d.stage_metadata)
        reg.validate_role_actor_kinds(d.stage_metadata, d.role_actor_kinds)

    await _with_session(body)


async def test_description_stage_count_matches_seed():
    """유나 문안의 «7단계»는 숫자로 한 주장 — 시드 stage 수와 ko(시드 원문)·en(messages) 둘 다 대조."""
    async def body(s):
        d = await _definition(s)
        n = len(_stages(d))
        assert re.search(rf"(^|\D){n}단계", d.description), (n, d.description)
        en = json.loads(_EN_MESSAGES.read_text())["recipePreset"]["blogArticleDescription"]
        assert en.startswith(f"{n} stages"), (n, en)

    await _with_session(body)


async def test_only_concept_gate_on_recipe_stages_publish_approval_is_on_the_draft():
    """PO 판정 (a) — 레시피 단계의 사람 게이트는 기획 승인 하나. 발행 승인은 내용이 봉인된 블로그 초안 게이트다
    (레시피 external_publish 게이트를 두면 내용을 못 본 승인이 하나 더 생긴다 — story #4190 봉인 원칙)."""
    async def body(s):
        d = await _definition(s)
        gates = {st: m["gate"]["type"] for st, m in d.stage_metadata.items() if m.get("gate")}
        assert gates == {"concept_confirmed": "concept_approval"}
        assert "게시" not in json.dumps(d.stage_metadata, ensure_ascii=False)  # 유나: 라벨표 «발행»과 섞지 않음

    await _with_session(body)


async def test_every_stage_mention_is_self_describing_and_server_driven_stage_is_not_published_by_agent():
    from app.routers.events import _SERVER_DRIVEN_CAPABILITY_KINDS, _render_event_message_content

    async def body(s):
        d = await _definition(s)
        order = _stages(d)
        org_id = uuid.uuid4()
        base = {"work_item_type": "story", "work_item_id": str(uuid.uuid4())}
        checked_wait = 0
        for i, stage in enumerate(order):
            meta = d.stage_metadata[stage]
            if meta.get("gate"):
                continue  # 게이트 stage는 «승인 대기» 문구(#4076 스코프 B)
            content = await _render_event_message_content(s, org_id=org_id, definition=d, payload={**base, "stage": stage})
            assert f"- 할 일: {meta['action']}" in content, (stage, content)
            nxt = order[i + 1] if i + 1 < len(order) else None
            next_kind = ((d.stage_metadata.get(nxt) or {}).get("capability") or {}).get("kind") if nxt else None
            if next_kind in _SERVER_DRIVEN_CAPABILITY_KINDS:
                checked_wait += 1
                assert "publish_event(" not in content, f"{stage}: 서버가 낼 단계의 발행 예시를 에이전트에게 줬다"
                assert "서버가 다음 단계로 넘겨요" in content, content
            elif nxt is not None:
                assert "publish_event(" in content, (stage, content)
        assert checked_wait == 1

    await _with_session(body)


async def test_site_post_stages_carry_their_tool_hints():
    from app.routers.events import _render_event_message_content

    async def body(s):
        d = await _definition(s)
        org_id = uuid.uuid4()
        base = {"work_item_type": "story", "work_item_id": str(uuid.uuid4())}
        expect = {
            "editing": "create_site_post_draft",
            "verification": "submit_site_post_draft",
            "published": "get_site_post_publication",
        }
        for stage, tool in expect.items():
            content = await _render_event_message_content(s, org_id=org_id, definition=d, payload={**base, "stage": stage})
            assert tool in content, (stage, content)

    await _with_session(body)


def test_blog_capability_kinds_are_not_org_connector_readiness_targets():
    """적용 화면 준비 경고는 org 커넥터 kind만 본다 — 블로그 kind 셋이 거기 걸리면 «연결하세요» 거짓 경고."""
    from app.routers.events import _AGENT_TOOL_CAPABILITY_KINDS

    assert {"draft_site_post", "submit_site_post", "site_post_auto_publish"} <= set(_AGENT_TOOL_CAPABILITY_KINDS)


def _fake_latest(stage: str, draft_id: str | None = None):
    payload = {"stage": stage}
    if draft_id is not None:
        payload["site_post_draft_id"] = draft_id
    return SimpleNamespace(msg_metadata={"event": {"payload": payload}})


async def test_recipe_context_requires_the_draft_linked_by_this_run(monkeypatch):
    """까디르 P1(4572 CHANGES) — 레시피 문맥 = 현재 단계가 «서버가 낼 단계» 바로 앞(발행 승인 대기) **이고** 그 단계 발행이
    연결한 초안(site_post_draft_id)이 바로 이 초안일 때만. 음성: ① 버려진 회차가 남은 work item의 무관 초안(연결 id가 다름)
    ② 같은 회차의 다른 목적지 초안(연결 id가 다름) ③ 연결 필드 없음 ④ 초안 id 없음 ⑤ 발행 승인 대기가 아닌 단계.
    뮤테이션: 연결 대조 제거 → ①②③이 문맥으로 잡혀 RED."""
    import app.routers.events as events

    linked, other = str(uuid.uuid4()), str(uuid.uuid4())

    async def body(s):
        for latest, draft_id, expected in (
            (_fake_latest("pending_approval", linked), linked, (_KEY, "published")),
            (_fake_latest("pending_approval", linked), other, None),
            (_fake_latest("pending_approval", other), linked, None),
            (_fake_latest("pending_approval"), linked, None),
            (_fake_latest("pending_approval", linked), None, None),
            (_fake_latest("verification", linked), linked, None),
            (None, linked, None),
        ):
            async def fake(db, *, _latest=latest, **kw):
                return _latest if kw["definition_key"] == _KEY else None

            monkeypatch.setattr(events, "_find_latest_stage_publish", fake)
            got = await events.resolve_site_post_recipe_context(
                s, org_id=uuid.uuid4(), work_item_type="story", work_item_id=uuid.uuid4(), draft_id=draft_id,
            )
            assert got == expected, (latest, draft_id, got)

    await _with_session(body)


async def test_pending_approval_payload_accepts_the_draft_link_and_example_carries_it():
    """연결 필드는 스키마에 열려 있고(additionalProperties false라 안 열면 에이전트 발행이 422), 발행 승인 대기로 넘어가는
    멘션 예시에 그 자리가 실린다(최저 지능 에이전트가 예시만 보고 연결)."""
    from app.routers.events import RECIPE_SITE_DRAFT_LINK_FIELD, _render_event_message_content
    from app.services.event_definition_registry import validate_event_payload

    async def body(s):
        d = await _definition(s)
        validate_event_payload(d.payload_schema, {
            "stage": "pending_approval", "work_item_type": "story", "work_item_id": str(uuid.uuid4()),
            RECIPE_SITE_DRAFT_LINK_FIELD: str(uuid.uuid4()),
        })
        content = await _render_event_message_content(s, org_id=uuid.uuid4(), definition=d, payload={
            "stage": "verification", "work_item_type": "story", "work_item_id": str(uuid.uuid4()),
        })
        assert RECIPE_SITE_DRAFT_LINK_FIELD in content, content

    await _with_session(body)


async def test_server_driven_next_stage_line_is_localized():
    """까디르 P2 — 새 «다음 단계» 줄이 en 로케일에서 영어(카탈로그 키)."""
    from app.routers.events import _render_event_message_content

    async def body(s):
        d = await _definition(s)
        content = await _render_event_message_content(s, org_id=uuid.uuid4(), definition=d, payload={
            "stage": "pending_approval", "work_item_type": "story", "work_item_id": str(uuid.uuid4()),
        }, resolved_locale="en")
        assert "Next stage: published" in content, content
        assert "다음 단계: published" not in content, content

    await _with_session(body)


async def test_every_next_stage_line_is_localized():
    """PO 11:58Z — 같은 렌더러의 «다음 단계» 세 줄(게이트가 이미 열린 단계 · 보통 단계 · 마지막 단계)이 모두 en 로케일에서
    영어이고 한국어 리터럴이 남지 않는다. ko는 기존 문구 그대로(무회귀)."""
    from app.routers.events import _render_event_message_content

    cases = {
        "concept_confirmed": ("Next stage: editing (Creator)", "다음 단계: editing (Creator)"),
        "draft": ("Next stage: concept_confirmed (Director)", "다음 단계: concept_confirmed (Director)"),
        "publish_checked": ("Next stage: none (last stage)", "다음 단계: 없음(마지막 stage)"),
    }

    async def body(s):
        d = await _definition(s)
        for stage, (en_line, ko_line) in cases.items():
            payload = {"stage": stage, "work_item_type": "story", "work_item_id": str(uuid.uuid4())}
            en = await _render_event_message_content(s, org_id=uuid.uuid4(), definition=d, payload=payload, resolved_locale="en")
            assert f"- {en_line}" in en, (stage, en)
            assert "다음 단계" not in en, (stage, en)
            ko = await _render_event_message_content(s, org_id=uuid.uuid4(), definition=d, payload=payload, resolved_locale="ko")
            assert f"- {ko_line}" in ko, (stage, ko)

    await _with_session(body)


async def test_verdict_next_action_uses_recipe_line_only_in_recipe_context(monkeypatch):
    """승인 알림 «다음 행동»(실 자사 블로그 초안·게이트 행으로 렌더): 레시피 문맥이면 자동 발행 문구 · 레시피 밖이면
    기존 «발행은 휴먼이 화면에서» 그대로(무회귀). 레시피 문맥 판별 자체는 위 테스트가 잰다 — 여기선 그 결과만 바꾼다.
    뮤테이션: 렌더러의 레시피 문맥 분기 제거 → 문맥 있음 쪽이 human 문구로 RED."""
    import app.routers.events as events
    from app.main import app
    from app.services.i18n_catalog import t
    from tests.test_4189_hosted_site_gate_scope_realdb import (
        _create_and_submit_hosted_draft,
        _seed,
        _session_factory,
    )

    recipe_line = t("events.gate_verdict_next_action_recipe_site_auto_publish", "ko")
    human_line = t("events.gate_verdict_next_action_publish_human_only", "ko")

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        _body, submit = await _create_and_submit_hosted_draft(app, Session, seeded)
        payload = {
            "work_item_type": "story", "work_item_id": str(seeded["story_id"]), "gate_type": "external_publish",
            "verdict": "approved", "resolver_member_id": str(seeded["om_id"]), "gate_id": submit["gate_id"],
        }
        rendered = {}
        for ctx in ((_KEY, "published"), None):
            async def fake_ctx(db, **kw):
                return ctx

            monkeypatch.setattr(events, "resolve_site_post_recipe_context", fake_ctx)
            async with Session() as s:
                rendered[ctx is not None] = await events._render_gate_verdict_message(
                    s, org_id=seeded["org_id"], payload=payload,
                )
        assert recipe_line in rendered[True], rendered[True]
        assert human_line in rendered[False] and recipe_line not in rendered[False], rendered[False]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
