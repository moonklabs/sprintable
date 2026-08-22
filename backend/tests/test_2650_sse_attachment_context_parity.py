"""story #2650 — SSE/webhook 패리티: conversation_webhook.py가 이미 하는 첨부 컨텍스트 주입
(attachment_context.py, IDOR-safe·conversation 스코프)을 _dispatch_conversation_event()의
SSE payload에도 재사용한다. AC1 재검증(디디 그라운딩)이 뒤집은 원 클레임("에이전트는 어디로도
첨부 바이트를 못 받는다")을 "webhook 경로는 이미 되는데 SSE만 빠졌다"로 재정의한 뒤의 처방.

이 파일은 tests/test_event1config_message_gating.py의 mocking 관례(_DB/_msg/_sender/_patches)를
그대로 재사용 — 같은 함수를 다른 축(웹훅 게이팅이 아니라 첨부 주입)으로 가드한다."""
from __future__ import annotations

import contextlib
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

import app.routers.conversations as conv


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _result_all(rows: list):
    r = SimpleNamespace()
    r.all = lambda: rows
    return r


def _msg(*, content="hi", attachments=None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        conversation_id=uuid.uuid4(),
        thread_id=None,
        reply_count=0,
        last_reply_at=None,
        content=content,
        mentioned_ids=[],
        attachments=attachments if attachments is not None else [],
        created_at=datetime.now(timezone.utc),
        deleted_at=None,
    )


def _sender():
    # story #2901 — _msg_payload가 sender.avatar_url을 읽는다(ResolvedMember/TeamMember
    # 실 타입 둘 다 이 속성을 갖는다).
    return SimpleNamespace(id=uuid.uuid4(), name="송신자", type="human", avatar_url=None)


async def _assign_seq(_db, event):
    event.recipient_seq = 1


class _DB:
    def __init__(self, exec_rows: list):
        self._exec_rows = list(exec_rows)
        self.added: list = []
        self.add = lambda ev: self.added.append(ev)
        self.flush = AsyncMock()

    async def execute(self, *_a, **_k):
        return self._exec_rows.pop(0)


def _patches():
    return [
        patch.object(conv, "assign_recipient_seq", _assign_seq),
        patch("app.services.activity_stream.extract_activities_best_effort", AsyncMock()),
        patch("app.services.presence_events.emit_conversation_working", new=AsyncMock(return_value=None)),
        patch("app.services.presence_events.emit_presence", new=AsyncMock(return_value=None)),
    ]


async def _dispatch(db, conversation, msg, org_id, sender):
    with contextlib.ExitStack() as stack:
        for p in _patches():
            stack.enter_context(p)
        return await conv._dispatch_conversation_event(db, conversation, msg, org_id, sender)


def _one_recipient_db():
    """단일 human 참여자 — 첨부 주입 관찰에만 집중(웹훅 게이팅은 별개 테스트 관심사)."""
    recipient = uuid.uuid4()
    return recipient, _DB([
        _result_all([(recipient,)]),           # participants
        _result_all([(recipient, "human")]),    # types
    ])


# ── 첨부 있으면 build_attachment_context 호출 → content 병합 + images 실림 ──────
@pytest.mark.anyio
async def test_attachment_injection_merges_content_and_images():
    org_id = uuid.uuid4()
    sender = _sender()
    recipient, db = _one_recipient_db()
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg(content="hi", attachments=[{"name": "chart.png", "content_type": "image/png", "url": "u", "size": 1}])

    build = AsyncMock(return_value=(
        "\n\n--- 첨부 내용 ---\n![chart.png](https://signed/url)",
        [{"url": "https://signed/url", "name": "chart.png", "mime": "image/png", "expires_at": "2026-08-14T10:30:00+00:00"}],
    ))
    with patch("app.services.attachment_context.build_attachment_context", build):
        out = await _dispatch(db, conversation, msg, org_id, sender)

    build.assert_awaited_once_with(
        msg.attachments, project_id=conversation.project_id,
        conversation_id=conversation.id, org_id=org_id,
    )
    assert len(out) == 1
    _pid, payload = out[0]
    assert "![chart.png](https://signed/url)" in payload["content"]
    assert payload["content"].startswith("hi")  # 원 content 뒤에 이어붙는다(webhook과 동형)
    assert payload["images"] == [
        {"url": "https://signed/url", "name": "chart.png", "mime": "image/png", "expires_at": "2026-08-14T10:30:00+00:00"},
    ]


# ── 첨부 없으면 build_attachment_context 자체를 안 부른다(무회귀 pin) ───────────
@pytest.mark.anyio
async def test_no_attachments_no_injection_attempted():
    org_id = uuid.uuid4()
    sender = _sender()
    recipient, db = _one_recipient_db()
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg(content="plain message", attachments=[])

    build = AsyncMock()
    with patch("app.services.attachment_context.build_attachment_context", build):
        out = await _dispatch(db, conversation, msg, org_id, sender)

    build.assert_not_awaited()
    _pid, payload = out[0]
    assert payload["content"] == "plain message"
    assert "images" not in payload  # 첨부 자체가 없으면 이 키를 아예 안 심는다


# ── 주입 실패(best-effort) — 전달 자체는 막지 않는다, webhook 경로와 동형 ─────────
@pytest.mark.anyio
async def test_injection_failure_does_not_block_delivery():
    org_id = uuid.uuid4()
    sender = _sender()
    recipient, db = _one_recipient_db()
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg(content="original content", attachments=[{"name": "x.pdf", "content_type": "application/pdf", "url": "u", "size": 1}])

    build = AsyncMock(side_effect=RuntimeError("gcs down"))
    with patch("app.services.attachment_context.build_attachment_context", build):
        out = await _dispatch(db, conversation, msg, org_id, sender)

    assert len(out) == 1  # Event는 그대로 생성됨 — 주입 실패가 발송 자체를 막지 않는다
    _pid, payload = out[0]
    assert payload["content"] == "original content"  # 원본 content 그대로 보존(오염 없음)
    assert "images" not in payload


# ── 첨부는 있지만 텍스트 추출/이미지 둘 다 빈 결과(예: 전부 접근범위 밖) — images는 빈 리스트로 실린다 ──
@pytest.mark.anyio
async def test_empty_extraction_result_still_sets_images_key_when_attachments_present():
    org_id = uuid.uuid4()
    sender = _sender()
    recipient, db = _one_recipient_db()
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg(content="hi", attachments=[{"name": "x.png", "content_type": "image/png", "url": "u", "size": 1}])

    build = AsyncMock(return_value=("", []))  # 예: scope 밖이라 안내 라인만 남고 총량 0(극단 케이스 시뮬)
    with patch("app.services.attachment_context.build_attachment_context", build):
        out = await _dispatch(db, conversation, msg, org_id, sender)

    _pid, payload = out[0]
    assert payload["content"] == "hi"  # 빈 _ctx면 원 content 그대로(치환 없음)
    assert payload["images"] == []  # 첨부가 있었으므로 images 키는 심되 빈 리스트


# ── 원 content가 빈 문자열이어도(첨부-단독 메시지) 병합이 안전하다 ────────────────
@pytest.mark.anyio
async def test_empty_original_content_with_attachment_uses_stripped_context():
    org_id = uuid.uuid4()
    sender = _sender()
    recipient, db = _one_recipient_db()
    conversation = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    msg = _msg(content="", attachments=[{"name": "chart.png", "content_type": "image/png", "url": "u", "size": 1}])

    build = AsyncMock(return_value=("\n\n--- 첨부 내용 ---\n![chart.png](https://signed/url)", [
        {"url": "https://signed/url", "name": "chart.png", "mime": "image/png", "expires_at": "x"},
    ]))
    with patch("app.services.attachment_context.build_attachment_context", build):
        out = await _dispatch(db, conversation, msg, org_id, sender)

    _pid, payload = out[0]
    # webhook 경로와 동형: base가 비어있으면 lstrip()된 컨텍스트만 남는다(선행 개행 없음).
    assert payload["content"] == "--- 첨부 내용 ---\n![chart.png](https://signed/url)"
