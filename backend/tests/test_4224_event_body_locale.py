"""story #4224 — en org 에이전트 이벤트 본문의 한국어 제거: 제네릭 폴백·판정 알림 머리 줄이 «[이벤트]» 하드코딩이던 자리를
stage 렌더와 같은 로케일 키(`events.event_line_header`)로. ko는 무변(«[이벤트] {key}»)."""
from __future__ import annotations

import contextlib
import re
import uuid
from types import SimpleNamespace

import pytest

from tests.test_3387_gate_verdict_agent_next_action import _payload, _render

_HANGUL = re.compile(r"[가-힣]")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _stub_work_item_ref(monkeypatch):
    """평문 알림 줄의 work item 참조 어댑터 대역 — 제목은 영문(본문 전체 «한국어 0» 판정이 픽스처 데이터에 흔들리지 않게)."""
    from app.routers import events as events_module

    async def _fake_ref(*_args, **_kwargs):
        return "[Title](entity:story:11111111-1111-1111-1111-111111111111)"

    monkeypatch.setattr(events_module, "_work_item_ref_token", _fake_ref)


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


_LOOP_STAGE_META = {
    "generate_variants": {
        "role": "Agent",
        "action": "brief를 바탕으로 복수의 실행안(variant)을 생성해 loop_artifacts로 등록",
        "action_i18n": {"en": "Generate several variants from the brief and register them as loop_artifacts"},
    },
    "loop_decision": {"role": "Human", "action": "실행안 중 하나를 선택(choose)하고 이유를 기록"},
}
_LOOP_SCHEMA = {"properties": {"stage": {"enum": ["generate_variants", "loop_decision"]}}}


def _to_do_line(text: str) -> str:
    return next(line for line in text.splitlines() if line.startswith(("- To do: ", "- 할 일: ")))


def _definition(org_id=None, stage_metadata=None):
    return SimpleNamespace(
        key="preset.workflow.loop_agency", org_id=org_id, stage_metadata=stage_metadata or _LOOP_STAGE_META, payload_schema=_LOOP_SCHEMA,
    )


@pytest.mark.anyio
async def test_to_do_line_en_from_seed_action_i18n_keeps_tool_names_ko_unchanged():
    """«To do:» 본문 — 에이전트 지시는 시드가 원천: en = 단계 메타 action_i18n.en(도구 이름 유지) · ko = 시드 원문 그대로."""
    from app.routers.events import _render_event_message_content

    payload = {"stage": "generate_variants", "work_item_type": "story", "work_item_id": str(uuid.uuid4())}
    en = await _render_event_message_content(None, org_id=uuid.uuid4(), definition=_definition(), payload=payload, resolved_locale="en")
    assert _to_do_line(en) == "- To do: Generate several variants from the brief and register them as loop_artifacts"
    ko = await _render_event_message_content(None, org_id=uuid.uuid4(), definition=_definition(), payload=payload, resolved_locale="ko")
    assert _to_do_line(ko) == "- 할 일: brief를 바탕으로 복수의 실행안(variant)을 생성해 loop_artifacts로 등록"


@pytest.mark.anyio
async def test_to_do_line_without_action_i18n_falls_back_to_seed_action():
    """action_i18n이 없는 단계(조직 커스텀 등)는 원문 그대로 — 지어내지 않는다."""
    from app.routers.events import _render_event_message_content

    payload = {"stage": "loop_decision", "work_item_type": "story", "work_item_id": str(uuid.uuid4())}
    en = await _render_event_message_content(None, org_id=uuid.uuid4(), definition=_definition(org_id=uuid.uuid4()), payload=payload, resolved_locale="en")
    assert _to_do_line(en) == "- To do: 실행안 중 하나를 선택(choose)하고 이유를 기록"


@pytest.mark.anyio
async def test_cycle_body_en_has_no_korean_including_previous_output_label(monkeypatch):
    """AC2 — 사이클 본문 전체(머리 줄 · 할 일 · 앞 단계 산출물 · 다음 단계)에 한국어 0(en)."""
    from app.routers import events as events_module

    async def _fake_doc_ref(*_a, **_k):
        return "[Brief](entity:doc:11111111-1111-1111-1111-111111111111)"

    monkeypatch.setattr(events_module, "_render_event_notification_doc_ref", _fake_doc_ref)
    payload = {
        "stage": "generate_variants", "work_item_type": "story", "work_item_id": str(uuid.uuid4()),
        "previous_output_doc_id": "11111111-1111-1111-1111-111111111111",
    }
    en = await events_module._render_event_message_content(None, org_id=uuid.uuid4(), definition=_definition(), payload=payload, resolved_locale="en")
    assert "- Previous stage output: [Brief]" in en
    assert not _HANGUL.search(en), en
    ko = await events_module._render_event_message_content(None, org_id=uuid.uuid4(), definition=_definition(), payload=payload, resolved_locale="ko")
    assert "- 앞 단계 산출물: [Brief]" in ko


@pytest.mark.anyio
@pytest.mark.parametrize("gate_type,verdict,note", [
    ("qa", "approved", "Looks good"),
    ("qa", "rejected", "Fix the title"),
    ("qa", "rejected", "discontinue — do not publish"),
    ("external_publish", "approved", None),
])
async def test_gate_verdict_body_en_has_no_korean(gate_type, verdict, note):
    """AC2 — 판정 알림 본문 전체에 한국어 0(en · 판정 줄 · 사유 · 다음 행동 갈래)."""
    en = await _render(_payload(gate_type=gate_type, verdict=verdict, resolution_note=note), resolved_locale="en")
    assert not _HANGUL.search(en), en
    assert f"- Gate: {gate_type} → {verdict}" in en
    ko = await _render(_payload(gate_type=gate_type, verdict=verdict, resolution_note=note))
    assert f"- 게이트: {gate_type} → {verdict}" in ko


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


@pytest.mark.parametrize("action_i18n,ok", [
    ({"en": "Write the draft"}, True),
    ({"en": ""}, False),
    ({"fr": "Écrire"}, False),
    ("Write the draft", False),
])
def test_validate_stage_metadata_action_i18n_shape(action_i18n, ok):
    """action_i18n은 선택 필드 — 있으면 {지원 로케일: 비어있지 않은 문자열}만."""
    from app.services.event_definition_registry import InvalidStageMetadataError, validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["draft"]}}}
    meta = {"draft": {"role": "Creator", "action": "초안 작성", "action_i18n": action_i18n}}
    if ok:
        validate_stage_metadata(schema, meta)
    else:
        with pytest.raises(InvalidStageMetadataError):
            validate_stage_metadata(schema, meta)
