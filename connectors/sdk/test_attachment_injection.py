"""#2568: 웹 첨부가 에이전트 SSE 주입에 안 실림 — 회귀 방지 pin.

백엔드(_msg_payload/_dispatch_conversation_event)는 payload.attachments를 정상 포함
(실측 확認, 코드 read) — 이 SDK의 `_parse_event`가 `images`(mime.startswith("image/")
필터)만 읽고 `attachments`는 아예 안 읽어 .md 등 비-이미지 첨부가 여기서 사라졌었다.
"""
from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sprintable_sse import (  # noqa: E402
    MessageAttachment,
    SprintableSSEClient,
    _normalize_attachments,
    render_attachment_notice,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _data(event_type="dispatched", content="", attachments=None, **extra):
    payload = {"event_type": event_type, "content": content, "event_id": "evt-attach"}
    if attachments is not None:
        payload["attachments"] = attachments
    payload.update(extra)
    return json.dumps(payload)


_ATTACHMENT = {
    "url": "https://storage.googleapis.com/bucket/notes.md",
    "name": "notes.md",
    "content_type": "text/markdown",
    "size": 1234,
    "asset_id": "5c1e1e1e-1111-2222-3333-444455556666",
}


def test_normalize_attachments_no_mime_filter():
    # _normalize_images would drop this (not image/*) — attachments must not.
    out = _normalize_attachments([_ATTACHMENT])
    assert len(out) == 1
    assert out[0].name == "notes.md"
    assert out[0].content_type == "text/markdown"
    assert out[0].asset_id == "5c1e1e1e-1111-2222-3333-444455556666"


def test_normalize_attachments_drops_items_without_url():
    out = _normalize_attachments([{"name": "no-url.md"}])
    assert out == []


def test_render_notice_uses_asset_text_endpoint_when_asset_id_present():
    a = MessageAttachment(url="https://x/y.md", name="y.md", content_type="text/markdown",
                           asset_id="abc-123")
    notice = render_attachment_notice([a])
    assert "GET /api/v2/assets/abc-123/text" in notice
    assert "y.md" in notice


def test_render_notice_falls_back_to_url_without_asset_id():
    a = MessageAttachment(url="https://x/y.md", name="y.md", content_type="text/markdown")
    notice = render_attachment_notice([a])
    assert "url: https://x/y.md" in notice
    assert "/text" not in notice


@pytest.mark.anyio
async def test_parse_event_populates_attachments_and_merges_notice_into_content():
    c = SprintableSSEClient(api_key="x")
    ctx = await c._parse_event(
        "message", "1", _data(content="여기 파일 첨부했음", attachments=[_ATTACHMENT]),
    )
    assert ctx is not None
    assert len(ctx.attachments) == 1
    assert ctx.attachments[0].name == "notes.md"
    # AC2/AC3: content에 첨부 안내가 병합돼 에이전트가 존재+회수 경로를 안다.
    assert "여기 파일 첨부했음" in ctx.content
    assert "notes.md" in ctx.content
    assert "GET /api/v2/assets/5c1e1e1e-1111-2222-3333-444455556666/text" in ctx.content


@pytest.mark.anyio
async def test_parse_event_not_dropped_when_only_attachment_no_text():
    # 순수 텍스트 없이 첨부만 보낸 메시지 — content-only 드롭체크에 안 걸려야 함.
    c = SprintableSSEClient(api_key="x")
    ctx = await c._parse_event(
        "message", "1", _data(content="", attachments=[_ATTACHMENT]),
    )
    assert ctx is not None
    assert "notes.md" in ctx.content


@pytest.mark.anyio
async def test_parse_event_attachments_read_from_payload_fallback():
    # 백엔드 실제 shape: attachments가 top-level data가 아니라 payload 안에 있음(_msg_payload).
    c = SprintableSSEClient(api_key="x")
    raw = json.dumps({
        "event_type": "dispatched", "event_id": "evt-payload-attach",
        "payload": {"content": "본문", "attachments": [_ATTACHMENT]},
    })
    ctx = await c._parse_event("message", "1", raw)
    assert ctx is not None
    assert len(ctx.attachments) == 1
    assert "notes.md" in ctx.content
