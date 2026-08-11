"""#2568: 웹 첨부가 에이전트 SSE 주입에 안 실림 — hermes adapter 회귀 방지 pin.

hermes-sprintable/adapter.py는 의도적으로 connectors/sdk를 import하지 않는 vendored
사본(모듈 docstring 참조 — standalone fresh-install에서 ImportError 0 보장 목적)이라
SDK 쪽 수정과 별개로 이 파일 자체에 동일 결함이 있었고, 동일하게 고쳤다. gateway.*
프레임워크(hermes-agent)가 로컬에 있을 때만 이 파일이 import 가능 — 없으면 skip
(CI가 hermes-agent 소스를 안 갖고 있을 수 있어 이식성 위해 importorskip).
"""
from __future__ import annotations

import os
import sys

import pytest

_HERMES_AGENT = os.path.expanduser("~/.hermes/hermes-agent")
if os.path.isdir(_HERMES_AGENT):
    sys.path.insert(0, _HERMES_AGENT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

adapter = pytest.importorskip(
    "adapter", reason="hermes-agent gateway.* framework not available on this machine",
)

_ATTACHMENT = {
    "url": "https://storage.googleapis.com/bucket/notes.md",
    "name": "notes.md",
    "content_type": "text/markdown",
    "size": 1234,
    "asset_id": "5c1e1e1e-1111-2222-3333-444455556666",
}


def test_normalize_attachment_items_no_mime_filter():
    # _normalize_image_items would drop this (not image/*) — attachments must not.
    out = adapter._normalize_attachment_items([_ATTACHMENT])
    assert len(out) == 1
    assert out[0]["name"] == "notes.md"
    assert out[0]["content_type"] == "text/markdown"
    assert out[0]["asset_id"] == "5c1e1e1e-1111-2222-3333-444455556666"


def test_normalize_attachment_items_drops_items_without_url():
    assert adapter._normalize_attachment_items([{"name": "no-url.md"}]) == []


def test_render_attachment_notice_uses_asset_text_endpoint():
    notice = adapter._render_attachment_notice(adapter._normalize_attachment_items([_ATTACHMENT]))
    assert "GET /api/v2/assets/5c1e1e1e-1111-2222-3333-444455556666/text" in notice
    assert "notes.md" in notice


def test_render_attachment_notice_falls_back_to_url_without_asset_id():
    item = dict(_ATTACHMENT)
    item["asset_id"] = ""
    notice = adapter._render_attachment_notice(adapter._normalize_attachment_items([item]))
    assert "url: https://storage.googleapis.com/bucket/notes.md" in notice
    assert "/text" not in notice
