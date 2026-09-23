"""story #4224 — en org 에이전트 이벤트 본문의 한국어 제거: 제네릭 폴백·판정 알림 머리 줄이 «[이벤트]» 하드코딩이던 자리를
stage 렌더와 같은 로케일 키(`events.event_line_header`)로. ko는 무변(«[이벤트] {key}»)."""
from __future__ import annotations

import contextlib
import re
import uuid
from types import SimpleNamespace

import pytest

from tests.test_3387_gate_verdict_agent_next_action import (  # noqa: F401
    _payload,
    _render,
    _stub_work_item_ref,
)

_HANGUL = re.compile(r"[가-힣]")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_generic_fallback_header_follows_locale():
    from app.routers.events import _generic_event_message_lines

    en = _generic_event_message_lines("org.custom.thing", {"stage": "draft", "n": 3}, "en")
    assert en == ["[Event] org.custom.thing", "- stage: draft", "- n: 3"]
    assert not _HANGUL.search("\n".join(en))
    ko = _generic_event_message_lines("org.custom.thing", {"stage": "draft"}, "ko")
    assert ko[0] == "[이벤트] org.custom.thing"


@pytest.mark.anyio
@pytest.mark.parametrize("stage_metadata,payload", [
    ({}, {"stage": "draft"}),  # 비사이클형 정의(stage_metadata 없음)
    ({"review": {"role": "Director", "action": "x"}}, {"stage": "draft"}),  # stage_metadata에 없는 stage
    ({"draft": {"role": "Creator"}}, {"stage": "draft"}),  # action 누락(옛 정의)
])
async def test_render_content_fallback_branches_pass_locale(stage_metadata, payload):
    """폴백 세 호출부(_render_event_message_content)가 모두 로케일을 넘긴다 — 하나라도 빠지면 en 머리 줄이 한국어."""
    from app.routers.events import _render_event_message_content

    definition = SimpleNamespace(key="org.custom.thing", org_id=uuid.uuid4(), stage_metadata=stage_metadata, payload_schema={})
    text = await _render_event_message_content(
        None, org_id=uuid.uuid4(), definition=definition, payload=payload, resolved_locale="en",
    )
    assert text.splitlines()[0] == "[Event] org.custom.thing"
    assert "[이벤트]" not in text


@pytest.mark.anyio
async def test_gate_verdict_header_follows_locale():
    en = await _render(_payload(gate_type="qa", verdict="approved"), resolved_locale="en")
    assert en.splitlines()[0] == "[Event] preset.gate.verdict"
    assert "[이벤트]" not in en
    ko = await _render(_payload(gate_type="qa", verdict="approved"))
    assert ko.splitlines()[0] == "[이벤트] preset.gate.verdict"


_BLOG_STAGE_META = {
    "planning": {"role": "Creator", "action": "주제·키워드 기획(제목 후보와 글 구성)"},
    "writing": {"role": "Creator", "action": "블로그 초안 작성"},
}
_BLOG_SCHEMA = {"properties": {"stage": {"enum": ["planning", "writing"]}}}


def _to_do_line(text: str) -> str:
    return next(line for line in text.splitlines() if line.startswith(("- To do: ", "- 할 일: ")))


@pytest.mark.anyio
async def test_platform_preset_to_do_line_en_from_fe_source_ko_unchanged():
    """«To do:» 본문 — 플랫폼 프리셋 en은 FE 원천 파생물의 en 문안(한국어 0) · ko는 시드 원문 그대로."""
    from app.routers.events import _render_event_message_content
    from app.services.recipe_preset_actions import _table

    definition = SimpleNamespace(
        key="preset.marketing.blog_article", org_id=None, stage_metadata=_BLOG_STAGE_META, payload_schema=_BLOG_SCHEMA,
    )
    payload = {"stage": "planning", "work_item_type": "story", "work_item_id": str(uuid.uuid4())}
    en = await _render_event_message_content(None, org_id=uuid.uuid4(), definition=definition, payload=payload, resolved_locale="en")
    assert _to_do_line(en) == f"- To do: {_table()['preset.marketing.blog_article:planning']['en']}"
    assert not _HANGUL.search(_to_do_line(en))
    ko = await _render_event_message_content(None, org_id=uuid.uuid4(), definition=definition, payload=payload, resolved_locale="ko")
    assert _to_do_line(ko) == "- 할 일: 주제·키워드 기획(제목 후보와 글 구성)"


@pytest.mark.anyio
async def test_org_custom_definition_keeps_its_own_action():
    """조직 커스텀 정의는 같은 key·stage 모양이어도 원문 그대로(FE presetAction과 같은 규칙 — 번역표는 플랫폼 프리셋 전용)."""
    from app.routers.events import _render_event_message_content

    definition = SimpleNamespace(
        key="preset.marketing.blog_article", org_id=uuid.uuid4(), stage_metadata=_BLOG_STAGE_META, payload_schema=_BLOG_SCHEMA,
    )
    payload = {"stage": "planning", "work_item_type": "story", "work_item_id": str(uuid.uuid4())}
    en = await _render_event_message_content(None, org_id=uuid.uuid4(), definition=definition, payload=payload, resolved_locale="en")
    assert _to_do_line(en) == "- To do: 주제·키워드 기획(제목 후보와 글 구성)"


class _Stop(Exception):
    pass


@pytest.mark.anyio
@pytest.mark.parametrize("given,expect_org_lookup", [(None, True), ("en", False)])
async def test_publish_core_falls_back_to_org_locale_only_without_request_locale(monkeypatch, given, expect_org_lookup):
    """서버 자동 발행 3곳(판정 알림·반복 스케줄러·channel_posts)은 로케일을 안 넘긴다 → core가 org 기준 언어로 푼다.
    요청 로케일이 있으면 그대로(org 조회 0)."""
    from app.routers import events as events_module

    calls: list[uuid.UUID] = []

    async def _fake_org_locale(_db, org_id):
        calls.append(org_id)
        raise _Stop

    monkeypatch.setattr(events_module, "resolve_org_locale", _fake_org_locale)
    org_id = uuid.uuid4()
    call = events_module._publish_registry_event_core(None, org_id, None, "preset.gate.verdict", {}, None, resolved_locale=given)
    if expect_org_lookup:
        with pytest.raises(_Stop):
            await call
    else:
        # 로케일이 주어진 갈래는 가짜 인자(db=None)로 더 진행하다 다른 예외로 멈춘다 — 여기선 org 조회 여부만 본다.
        with contextlib.suppress(Exception):
            await call
    assert calls == ([org_id] if expect_org_lookup else [])


@pytest.mark.anyio
@pytest.mark.parametrize("locale,accept_language,expected", [
    (None, None, None),  # 요청에 로케일이 전혀 없음 → core가 org 기준 언어로
    (None, "en-US,en;q=0.9", "en"),
    ("ko", "en-US", "ko"),  # 명시값 우선(행동 변화 0)
])
async def test_http_publish_passes_request_locale_or_none(monkeypatch, locale, accept_language, expected):
    from starlette.requests import Request

    from app.routers import events as events_module

    captured: dict = {}

    async def _fake_core(*_args, **kwargs):
        captured["resolved_locale"] = kwargs.get("resolved_locale")
        return {}

    monkeypatch.setattr(events_module, "_publish_registry_event_core", _fake_core)
    headers = [(b"accept-language", accept_language.encode())] if accept_language else []
    request = Request({"type": "http", "method": "POST", "path": "/", "headers": headers, "query_string": b""})
    body = SimpleNamespace(
        definition_key="k", payload={}, extra_broadcast_member_ids=None, conversation_id=None,
    )
    await events_module.publish_registry_event(
        body=body, request=request, background_tasks=None, locale=locale,
        db=None, auth=None, org_id=uuid.uuid4(),
    )
    assert captured["resolved_locale"] == expected
