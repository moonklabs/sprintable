"""E-EVENT-INJECT S2: 주입 allow-list (recommended ONLY) 검증.

connector가 recommended event_type만 work-turn으로 주입하고, content가 실린 FYI는 드롭함을 확인.
SDK(sprintable_sse) 기준 — hermes adapter.py는 동일 상수(INJECTABLE_EVENT_TYPES)를 import해 동일 게이트.
"""
from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sprintable_sse import (  # noqa: E402
    INJECTABLE_EVENT_TYPES,
    MessageImage,
    SprintableSSEClient,
    _normalize_images,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


_RECOMMENDED = (
    "dispatched", "story_assigned", "conversation.message_created", "conversation:mention",
    "kickoff", "review_request", "qa_request", "deploy_request", "handoff",
)
_FYI = (
    "status_changed", "story_status_changed", "task_completed",
    "agent_joined", "sprint_closed", "file_conflict",
)


def test_allowlist_recommended_in_fyi_out():
    for ok in _RECOMMENDED:
        assert ok in INJECTABLE_EVENT_TYPES, ok
    for bad in _FYI:
        assert bad not in INJECTABLE_EVENT_TYPES, bad


def _data(event_type, content="[story] do the thing", **extra):
    return json.dumps({"event_type": event_type, "content": content,
                       "event_id": "evt-" + event_type, **extra})


@pytest.mark.anyio
async def test_recommended_event_injected():
    c = SprintableSSEClient(api_key="x")
    ctx = await c._parse_event("message", "1", _data("dispatched"))
    assert ctx is not None  # 주입됨


@pytest.mark.anyio
async def test_fyi_dropped_even_with_content():
    c = SprintableSSEClient(api_key="x")
    # content가 실려있어도 status_changed는 allow-list 밖 → 드롭(poisoning 방지)
    ctx = await c._parse_event("message", "2", _data("status_changed", content="moved to done"))
    assert ctx is None


@pytest.mark.anyio
async def test_unknown_and_missing_type_dropped():
    c = SprintableSSEClient(api_key="x")
    assert await c._parse_event("message", "3", _data("task_completed")) is None
    assert await c._parse_event("message", "4", json.dumps({"content": "no type"})) is None


@pytest.mark.anyio
async def test_mention_and_message_created_injected():
    c = SprintableSSEClient(api_key="x")
    assert await c._parse_event("message", "5", _data("conversation:mention")) is not None
    assert await c._parse_event("message", "6", _data("conversation.message_created")) is not None


# ── E-INJECT-ADAPTERS AC1: vendored-copy sync guard ──────────────────────────
# The hermes adapters vendor INJECTABLE_EVENT_TYPES so a single-folder fresh
# install loads without the SDK on the path.  This SDK module stays canonical;
# guard that the vendored copies never silently drift from it.  Parsed via ast
# (not import) because the adapter modules import the Hermes ``gateway`` package
# which is not present in this connectors-only test environment.
def _vendored_allowlist(adapter_path):
    import ast
    tree = ast.parse(open(adapter_path, encoding="utf-8").read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "INJECTABLE_EVENT_TYPES" for t in node.targets
        ):
            call = node.value
            assert isinstance(call, ast.Call), "expected frozenset({...}) literal"
            return set(ast.literal_eval(call.args[0]))
    raise AssertionError(f"INJECTABLE_EVENT_TYPES not found in {adapter_path}")


@pytest.mark.parametrize("adapter", ["hermes-sprintable", "hermes-sprintable-prod"])
def test_adapter_vendored_allowlist_matches_sdk(adapter):
    here = os.path.dirname(os.path.abspath(__file__))
    adapter_path = os.path.join(here, "..", adapter, "adapter.py")
    assert _vendored_allowlist(adapter_path) == set(INJECTABLE_EVENT_TYPES)


# ── 39e0a69e: webhook payload images[] consume ───────────────────────────────
# BE(#1588) emits images:[{url(signed V4),name,mime}] alongside content.  The
# SDK surfaces them as MessageContext.images so SDK-based connectors can fetch
# and route them to a multimodal model instead of dropping them on the floor.
def test_normalize_images_happy_path():
    imgs = _normalize_images([
        {"url": "https://x/a.jpg", "name": "a.jpg", "mime": "image/jpeg"},
        {"url": "https://x/b.png", "name": "b.png", "mime": "image/png"},
    ])
    assert imgs == [
        MessageImage(url="https://x/a.jpg", name="a.jpg", mime="image/jpeg"),
        MessageImage(url="https://x/b.png", name="b.png", mime="image/png"),
    ]


def test_normalize_images_non_list_returns_empty():
    for bad in (None, "https://x/a.jpg", {"url": "x"}, 42):
        assert _normalize_images(bad) == []


def test_normalize_images_skips_garbage_items():
    imgs = _normalize_images([
        "not-a-dict",
        {"name": "no-url"},          # missing url → skip
        {"url": "   "},              # blank url → skip
        {"url": "https://x/ok.gif", "mime": "image/gif"},
    ])
    assert imgs == [MessageImage(url="https://x/ok.gif", name="", mime="image/gif")]


def test_normalize_images_filters_non_image_mime():
    imgs = _normalize_images([
        {"url": "https://x/doc.pdf", "mime": "application/pdf"},
        {"url": "https://x/p.png", "mime": "image/png"},
    ])
    assert imgs == [MessageImage(url="https://x/p.png", name="", mime="image/png")]


def test_normalize_images_accepts_mime_type_alias():
    imgs = _normalize_images([{"url": "https://x/a.webp", "mime_type": "image/webp"}])
    assert imgs == [MessageImage(url="https://x/a.webp", name="", mime="image/webp")]


@pytest.mark.anyio
async def test_image_only_message_is_injected():
    # content 없어도 image 첨부가 있으면 work-turn으로 주입돼야 함 (AC: image-only inject)
    c = SprintableSSEClient(api_key="x")
    data = json.dumps({
        "event_type": "conversation.message_created",
        "content": "",
        "event_id": "evt-img-only",
        "images": [{"url": "https://x/a.jpg", "name": "a.jpg", "mime": "image/jpeg"}],
    })
    ctx = await c._parse_event("message", "10", data)
    assert ctx is not None
    assert ctx.content == ""
    assert ctx.images == [MessageImage(url="https://x/a.jpg", name="a.jpg", mime="image/jpeg")]


@pytest.mark.anyio
async def test_text_plus_images_surfaces_both():
    c = SprintableSSEClient(api_key="x")
    data = json.dumps({
        "event_type": "dispatched",
        "content": "look at this",
        "event_id": "evt-txt-img",
        "images": [{"url": "https://x/a.png", "mime": "image/png"}],
    })
    ctx = await c._parse_event("message", "11", data)
    assert ctx is not None
    assert ctx.content == "look at this"
    assert len(ctx.images) == 1 and ctx.images[0].url == "https://x/a.png"


@pytest.mark.anyio
async def test_text_only_has_empty_images_no_regression():
    # AC5 무회귀: 이미지 없는 텍스트 메시지는 images == [] 로 정상 주입
    c = SprintableSSEClient(api_key="x")
    ctx = await c._parse_event("message", "12", _data("dispatched"))
    assert ctx is not None
    assert ctx.images == []


@pytest.mark.anyio
async def test_images_nested_in_payload_surfaced():
    c = SprintableSSEClient(api_key="x")
    data = json.dumps({
        "event_type": "dispatched",
        "event_id": "evt-payload-img",
        "payload": {
            "content": "",
            "images": [{"url": "https://x/n.jpg", "mime": "image/jpeg"}],
        },
    })
    ctx = await c._parse_event("message", "13", data)
    assert ctx is not None
    assert len(ctx.images) == 1 and ctx.images[0].url == "https://x/n.jpg"


@pytest.mark.anyio
async def test_non_image_attachment_only_is_dropped():
    # 이미지가 아닌 mime만 있고 content도 없으면 normalize 후 images==[] → 드롭
    c = SprintableSSEClient(api_key="x")
    data = json.dumps({
        "event_type": "dispatched",
        "content": "",
        "event_id": "evt-nonimg",
        "images": [{"url": "https://x/doc.pdf", "mime": "application/pdf"}],
    })
    assert await c._parse_event("message", "14", data) is None
