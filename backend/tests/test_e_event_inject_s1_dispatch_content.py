"""E-EVENT-INJECT S1: dispatch 이벤트 content 주입 — connector 드롭 방지.

connector(adapter.py:189) `content = data.get("content") or payload.get("content")`;
`if not content: return`. 따라서 dispatched에 content 부여 + SSE top-level 노출이 핵심.
"""
from __future__ import annotations

import datetime
import json
import uuid
from types import SimpleNamespace

from app.routers.events import _event_to_payload
from app.routers.agent_gateway import _row_to_payload


def _ev(payload):
    return SimpleNamespace(
        id=uuid.uuid4(), event_type="dispatched",
        source_entity_type="story", source_entity_id=uuid.uuid4(),
        sender_id=None, payload=payload, created_at=datetime.datetime.now(),
    )


def _row(payload):
    return SimpleNamespace(
        event_id=uuid.uuid4().hex, event_type="dispatched", recipient_seq=1,
        source_entity_type="story", source_entity_id=str(uuid.uuid4()),
        sender_id=None, payload=payload, created_at=datetime.datetime.now(),
    )


# ── SSE 직렬화: content top-level 노출 ────────────────────────────────────────

def test_event_to_payload_hoists_content_top_level():
    p = _event_to_payload(_ev({"content": "[story] Build — ship it", "title": "Build"}))
    assert p["content"] == "[story] Build — ship it"  # top-level
    assert p["payload"]["content"] == "[story] Build — ship it"  # payload에도 유지


def test_event_to_payload_content_none_when_absent():
    p = _event_to_payload(_ev({"title": "no content"}))
    assert p["content"] is None  # 없으면 None (안전)


def test_row_to_payload_hoists_content_dict_and_str():
    # dict payload
    assert _row_to_payload(_row({"content": "X"}))["content"] == "X"
    # JSON string payload
    assert _row_to_payload(_row(json.dumps({"content": "Y"})))["content"] == "Y"
    # 없으면 None
    assert _row_to_payload(_row({"title": "t"}))["content"] is None


# ── connector 드롭 조건 시뮬레이션 (content 비어있지 않아야 주입됨) ─────────────

def _connector_would_inject(sse_data: dict) -> bool:
    payload = sse_data.get("payload") or {}
    content = (sse_data.get("content") or payload.get("content") or "").strip()
    return bool(content)  # adapter.py: `if not content: return` 의 역


def test_dispatched_event_is_not_dropped():
    # dispatch.py가 부여하는 content 형태
    entity_type, title, detail = "story", "Fix login", "급함"
    content = f"[{entity_type}] {title}" + (f" — {detail}" if detail else "")
    sse = _event_to_payload(_ev({"content": content, "title": title}))
    assert _connector_would_inject(sse) is True  # 드롭 안 됨 → work-turn 주입


def test_contentless_event_still_dropped():
    sse = _event_to_payload(_ev({"title": "system note"}))
    assert _connector_would_inject(sse) is False  # content 없으면 기존대로 드롭(의도된 동작)
