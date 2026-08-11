"""E-ACTIVATION Phase 2 (X · system-side non-invoke) — 관찰=턴안열기 검증.

설계문서 agent-agent-loop-termination-research §3·§4·§7. 배달을 «관찰 vs 호출»로 갈라
비지정(관찰) 이벤트면 모델을 «아예 안 깨우고» 버퍼에 쌓아 다음 활성화 때 hydrate 한다.
게이트는 SPRINTABLE_NONINVOKE_OBSERVATIONS=1 일 때만 — 기본 OFF = 현행 보존.

SDK(sprintable_sse)가 분류 로직 정본. hermes 어댑터는 vendored 사본 — drift 가드 포함.
"""
from __future__ import annotations

import ast
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sprintable_sse import (  # noqa: E402
    NONINVOKE_FLAG_ENV,
    OBS_BUFFER_MAX,
    SprintableSSEClient,
    classify_activation,
    render_observation_block,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── classify_activation (정본 분류기) ─────────────────────────────────────────

def test_classify_broadcast_is_addressed():
    # audience 미지정(broadcast) → 전체 대상 = 호출(현행 보존)
    at, addressed, kind, exp = classify_activation({"content": "hi"}, {})
    assert at is False and addressed is True


def test_classify_targeted_in_audience_is_addressed():
    at, addressed, _, _ = classify_activation(
        {"audience": ["me"], "recipient_id": "me"}, {}
    )
    assert at is True and addressed is True


def test_classify_targeted_out_of_audience_is_observation():
    at, addressed, _, _ = classify_activation(
        {"audience": ["someone-else"], "recipient_id": "me"}, {}
    )
    assert at is True and addressed is False


def test_classify_reads_payload_fallback_and_meta():
    at, addressed, kind, exp = classify_activation(
        {"recipient_id": "me"},
        {"audience": ["me"], "message_kind": "request", "expects_response": True},
    )
    assert (at, addressed, kind, exp) == (True, True, "request", True)


def test_classify_missing_recipient_targeted_is_observation():
    # audience 지정인데 내 recipient_id 를 모르면 «나를 향한 것»이라 단정 못 함 → 관찰
    at, addressed, _, _ = classify_activation({"audience": ["A", "B"]}, {})
    assert at is True and addressed is False


def test_classify_int_str_recipient_normalized_is_addressed():
    # str() 정규화가 «매칭을 성사»시키는 True-분기 실증 — 양성대조가 «틀릴 수 있어야».
    # 코드가 str() 없이 `recipient_id in audience` 였다면 int↔str 불일치로 addressed=False 가
    # 되어 이 테스트가 빨개진다 → 정규화 축을 «실제로» 잰다(카디르 QA Note 1 반영).
    at, addressed, _, _ = classify_activation({"audience": [123], "recipient_id": "123"}, {})
    assert at is True and addressed is True
    _, addressed, _, _ = classify_activation({"audience": ["123"], "recipient_id": 123}, {})
    assert addressed is True


# ── _parse_event 가 분류 결과를 MessageContext 에 실음 ─────────────────────────

@pytest.mark.anyio
async def test_parse_event_sets_activation_fields():
    c = SprintableSSEClient(api_key="x")
    ctx = await c._parse_event("message", "1", json.dumps({
        "event_type": "conversation.message_created", "content": "hi", "event_id": "e-fields",
        "audience": ["A"], "recipient_id": "me", "message_kind": "request",
        "expects_response": True, "conversation_id": "c1",
        "sender": {"id": "A", "name": "Alice"},
    }))
    assert ctx is not None
    assert ctx.addressed is False and ctx.audience_targeted is True
    assert ctx.message_kind == "request" and ctx.expects_response is True


@pytest.mark.anyio
async def test_parse_event_broadcast_defaults_addressed_true():
    c = SprintableSSEClient(api_key="x")
    ctx = await c._parse_event("message", "2", json.dumps({
        "event_type": "conversation.message_created", "content": "hi all", "event_id": "e-bcast",
        "conversation_id": "c1", "sender": {"id": "A", "name": "Alice"},
    }))
    assert ctx is not None and ctx.addressed is True and ctx.audience_targeted is False


# ── _dispatch_event: 관찰=미주입+버퍼 / 호출=flush+주입 (핵심 X 동작) ──────────

def _obs(event_id, seq, content="background chatter"):
    # SDK _parse_event 는 sender 를 payload.sender 에서 읽는다(실 SSE frame 형태).
    return json.dumps({
        "event_type": "conversation.message_created", "content": content,
        "audience": ["agent-A"], "recipient_id": "me", "event_id": event_id,
        "recipient_seq": seq, "conversation_id": "c1",
        "payload": {"sender": {"id": "agent-A", "name": "Alice"}, "conversation_id": "c1"},
    })


def _act(event_id, seq, content="please do X"):
    return json.dumps({
        "event_type": "conversation.message_created", "content": content,
        "audience": ["me"], "recipient_id": "me", "event_id": event_id,
        "recipient_seq": seq, "conversation_id": "c1",
        "payload": {"sender": {"id": "boss", "name": "Boss"}, "conversation_id": "c1"},
    })


@pytest.mark.anyio
async def test_observation_not_invoked_but_buffered(monkeypatch):
    monkeypatch.setenv(NONINVOKE_FLAG_ENV, "1")
    c = SprintableSSEClient(api_key="x")
    delivered = []

    async def on_msg(ctx):
        delivered.append(ctx.content)

    obs = await c._parse_event("message", "1", _obs("o1", 3))
    assert obs.addressed is False
    await c._dispatch_event(obs, on_msg)
    assert delivered == []                                   # 모델 «안 깨움»
    assert c._obs_buffer["c1"] == ["Alice: background chatter"]  # 버퍼에 보존


@pytest.mark.anyio
async def test_activation_flushes_buffer_into_context(monkeypatch):
    monkeypatch.setenv(NONINVOKE_FLAG_ENV, "1")
    c = SprintableSSEClient(api_key="x")
    delivered = []

    async def on_msg(ctx):
        delivered.append(ctx.content)

    await c._dispatch_event(await c._parse_event("message", "1", _obs("o1", 3)), on_msg)
    await c._dispatch_event(await c._parse_event("message", "2", _obs("o2", 4, "more chatter")), on_msg)
    assert delivered == []                                   # 관찰 2건 모두 미주입
    # 나를 향한 활성화 도착 → 쌓인 관찰이 context 로 hydrate 되어 «한 번» 주입
    await c._dispatch_event(await c._parse_event("message", "3", _act("a1", 5)), on_msg)
    assert len(delivered) == 1
    body = delivered[0]
    assert "please do X" in body                             # 활성화 본문
    assert "background chatter" in body and "more chatter" in body  # 다 봄(hydrate)
    assert "읽음" in body                                     # 관찰 블록 라벨
    assert "c1" not in c._obs_buffer                          # flush 후 비워짐


@pytest.mark.anyio
async def test_flag_off_observation_still_invoked_no_regression(monkeypatch):
    monkeypatch.delenv(NONINVOKE_FLAG_ENV, raising=False)
    c = SprintableSSEClient(api_key="x")
    delivered = []

    async def on_msg(ctx):
        delivered.append(ctx.content)

    obs = await c._parse_event("message", "1", _obs("o1", 3))
    await c._dispatch_event(obs, on_msg)
    assert delivered == ["background chatter"]                # 게이트 OFF = 현행대로 주입
    assert c._obs_buffer == {}                                # 버퍼 안 씀


@pytest.mark.anyio
async def test_broadcast_invoked_even_with_flag_on(monkeypatch):
    # audience 미지정 broadcast 는 X ON 이어도 «전체 대상»이라 정상 주입(현행 보존)
    monkeypatch.setenv(NONINVOKE_FLAG_ENV, "1")
    c = SprintableSSEClient(api_key="x")
    delivered = []

    async def on_msg(ctx):
        delivered.append(ctx.content)

    ctx = await c._parse_event("message", "1", json.dumps({
        "event_type": "conversation.message_created", "content": "hi all",
        "event_id": "b1", "recipient_seq": 2, "conversation_id": "c1",
        "sender": {"id": "A", "name": "Alice"},
    }))
    await c._dispatch_event(ctx, on_msg)
    assert delivered == ["hi all"]


# ── 버퍼 경계 ─────────────────────────────────────────────────────────────────

def test_buffer_is_bounded():
    from types import SimpleNamespace
    c = SprintableSSEClient(api_key="x")
    for i in range(OBS_BUFFER_MAX + 5):
        c._buffer_observation(SimpleNamespace(conversation_id="c", sender_name="S", content=f"m{i}"))
    buf = c._obs_buffer["c"]
    assert len(buf) == OBS_BUFFER_MAX                         # 오래된 것부터 폐기
    assert buf[-1] == f"S: m{OBS_BUFFER_MAX + 4}"             # 최신 보존


def test_render_observation_block_shape():
    block = render_observation_block(["Alice: a", "Bob: b"])
    assert "2건" in block and "- Alice: a" in block and "- Bob: b" in block


# ── vendored 분류기 drift 가드 (hermes 어댑터) ────────────────────────────────
# 어댑터는 gateway 패키지를 import 하므로 통째로는 import 불가 → classify_activation
# FunctionDef 만 AST 로 뽑아 격리 exec 후, SDK 정본과 «동일 표본에 동일 결과»인지 대조.
# (INJECTABLE_EVENT_TYPES 의 test_adapter_vendored_allowlist_matches_sdk 와 같은 취지.)

def _extract_func(adapter_path, name):
    tree = ast.parse(open(adapter_path, encoding="utf-8").read())
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            mod = ast.Module(body=[node], type_ignores=[])
            ast.fix_missing_locations(mod)
            ns: dict = {}
            exec(compile(mod, adapter_path, "exec"), ns)
            return ns[name]
    raise AssertionError(f"{name} not found in {adapter_path}")


_CASES = [
    ({"content": "x"}, {}),
    ({"audience": ["me"], "recipient_id": "me"}, {}),
    ({"audience": ["other"], "recipient_id": "me"}, {}),
    ({"recipient_id": "me"}, {"audience": ["me"], "message_kind": "request", "expects_response": True}),
    ({"audience": ["A", "B"]}, {}),
    ({"audience": [123], "recipient_id": "123"}, {}),  # int audience ↔ str recipient: 정규화로 매칭(addressed=True)
    ({"audience": ["me"], "recipient_id": 123}, {}),   # 타입 혼합·관찰(밖) 유지(addressed=False)
]


@pytest.mark.parametrize("adapter", ["hermes-sprintable", "hermes-sprintable-prod"])
def test_adapter_vendored_classifier_matches_sdk(adapter):
    here = os.path.dirname(os.path.abspath(__file__))
    adapter_path = os.path.join(here, "..", adapter, "adapter.py")
    vendored = _extract_func(adapter_path, "classify_activation")
    for data, payload in _CASES:
        assert vendored(data, payload) == classify_activation(data, payload), (adapter, data, payload)


@pytest.mark.parametrize("adapter", ["hermes-sprintable", "hermes-sprintable-prod"])
def test_adapter_has_noninvoke_gate(adapter):
    # X 게이트가 두 사본에 «다 있는지» 트립와이어 — 한 사본이 X 를 빠뜨리면 빨강.
    here = os.path.dirname(os.path.abspath(__file__))
    src = open(os.path.join(here, "..", adapter, "adapter.py"), encoding="utf-8").read()
    assert "SPRINTABLE_NONINVOKE_OBSERVATIONS" in src
    assert "_buffer_observation" in src and "_flush_observations" in src
    # 관찰이면 handle_message 전에 return 하는 조기-이탈이 존재해야 함
    assert "observation (non-invoke)" in src
