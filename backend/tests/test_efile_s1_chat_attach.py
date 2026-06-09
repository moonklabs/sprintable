"""E-FILE S1: 채팅 첨부 BE — payload 검증 + _msg_payload 직렬화.

GCS 업로드는 FE-proxy 담당. BE는 URL+메타 수신·저장·직렬화만 (경량).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.routers.conversations import (
    MessageAttachment,
    SendMessageRequest,
    _msg_payload,
    _MAX_ATTACHMENTS,
)

_GOOD = {"url": "https://storage.googleapis.com/bucket/a.png", "name": "a.png",
         "content_type": "image/png", "size": 1024}


# ── payload 계약 ──────────────────────────────────────────────────────────────

def test_attachment_accepts_valid():
    a = MessageAttachment(**_GOOD)
    assert a.url.startswith("https://") and a.name == "a.png" and a.size == 1024


def test_attachment_rejects_non_https():
    with pytest.raises(ValidationError):
        MessageAttachment(**{**_GOOD, "url": "http://insecure/a.png"})


def test_attachment_rejects_empty_name_or_type():
    with pytest.raises(ValidationError):
        MessageAttachment(**{**_GOOD, "name": "  "})
    with pytest.raises(ValidationError):
        MessageAttachment(**{**_GOOD, "content_type": ""})


def test_attachment_rejects_negative_or_oversized():
    with pytest.raises(ValidationError):
        MessageAttachment(**{**_GOOD, "size": -1})
    with pytest.raises(ValidationError):
        MessageAttachment(**{**_GOOD, "size": 200 * 1024 * 1024})


def test_send_message_request_defaults_and_limit():
    assert SendMessageRequest(content="hi").attachments == []
    # 최대 개수 초과 거부
    with pytest.raises(ValidationError):
        SendMessageRequest(content="hi", attachments=[_GOOD] * (_MAX_ATTACHMENTS + 1))


# ── 직렬화 (_msg_payload) ─────────────────────────────────────────────────────

def _fake_msg(attachments):
    return SimpleNamespace(
        id=uuid.uuid4(), conversation_id=uuid.uuid4(), thread_id=None,
        reply_count=0, last_reply_at=None, content="hi", mentioned_ids=[],
        attachments=attachments, created_at=datetime.now(timezone.utc),
    )


def test_msg_payload_includes_attachments():
    atts = [_GOOD]
    payload = _msg_payload(_fake_msg(atts), sender=None)
    assert payload["attachments"] == atts


def test_msg_payload_non_list_attachments_safe():
    # None/레거시/mock → [] (KeyError·shape 깨짐 방지)
    assert _msg_payload(_fake_msg(None), sender=None)["attachments"] == []
    assert _msg_payload(_fake_msg(object()), sender=None)["attachments"] == []
