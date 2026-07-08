"""c60dd33c: fire_webhooks Discord 페이로드 정규화(AC1) + 타겟 게이팅(AC2) 가드.

BUG: fire_webhooks 가 ① raw envelope 를 Discord 에 그대로 POST(400) ② org 전 활성 webhook 에
무차별 fan-out. fix: discord URL 은 {content} 변환, recipient_member_ids 주어지면 member-bound
게이팅(broadcast 보존). None 이면 기존 동작(타 호출부 무회귀).
"""
from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import app.services.webhook_dispatch as wd
from app.services.discord_webhook import (
    is_discord_url,
    to_discord_event_payload,
    to_discord_message_payload,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── AC1: discord payload 정규화 ──────────────────────────────────────────────

def test_to_discord_event_payload_has_content_not_envelope():
    """이벤트 envelope 가 아니라 Discord {content} 형식이어야 400 안 난다."""
    out = to_discord_event_payload("story.status_changed", {
        "story_title": "[BE] 단일경로 전달", "old_status": "in-review", "new_status": "done",
        "actor_name": "오르테가",
    })
    assert "content" in out and "event" not in out and "data" not in out
    assert "story.status_changed" in out["content"]
    assert "in-review → done" in out["content"]
    assert len(out["content"]) <= 2000


def test_to_discord_event_payload_minimal_still_valid():
    """핵심 필드 없어도 최소 {content}(event명) 보장 — file_conflict 류도 204."""
    out = to_discord_event_payload("file_conflict", {"severity": "warn"})
    assert out["content"].strip() and "file_conflict" in out["content"]


def test_is_discord_url():
    assert is_discord_url("https://discord.com/api/webhooks/1/abc")
    assert is_discord_url("https://discordapp.com/api/webhooks/1/abc")
    assert not is_discord_url("https://hooks.example.com/x")


def test_conversation_message_payload_unchanged_regression():
    """AC3: 채팅 경로 discord payload 동형 유지(📩 새 메시지)."""
    out = to_discord_message_payload({"content": "안녕", "conversation_id": "c1", "thread_id": "t1"})
    assert out["content"].startswith("📩 **새 메시지**")
    assert "안녕" in out["content"] and "conversation_id: c1" in out["content"]


def test_message_id_line_reads_own_id_not_thread_id():
    """버그 fix(story ebd5cf18 크럭스 부수 발견): "message_id:" 라인은 이 메시지 자신의
    id(payload["message_id"])를 보여야 한다 — 예전엔 payload["thread_id"]를 오라벨해서,
    thread_id가 항상 None인 루트 메시지(새 A2A task 등)에선 표시가 통째로 사라졌다."""
    out = to_discord_message_payload({
        "content": "hi", "conversation_id": "c1", "message_id": "m1", "thread_id": None,
    })
    assert "message_id: m1" in out["content"]
    assert "message_id: None" not in out["content"]


def test_message_id_line_absent_when_no_message_id_in_payload():
    """message_id 자체가 payload에 없으면(예: deliver_injected_event_webhook 경로) 라인 생략."""
    out = to_discord_message_payload({"content": "hi", "conversation_id": "c1"})
    assert "message_id:" not in out["content"]


# ─── fire_webhooks 통합: discord 변환 + 게이팅 ────────────────────────────────

def _session(configs):
    """session.execute(...).all() → configs(list of (url, secret, events, member_id))."""
    res = MagicMock()
    res.all.return_value = configs
    s = MagicMock()
    s.execute = AsyncMock(return_value=res)
    return s


class _MockClient:
    def __init__(self, sink):
        self._sink = sink

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, content=None, headers=None):
        self._sink.append({"url": url, "body": content, "headers": headers or {}})
        return MagicMock()


def _patches(sink):
    return [
        patch.object(wd.httpx, "AsyncClient", lambda *a, **k: _MockClient(sink)),
        patch.object(wd, "validate_webhook_url_async", new=AsyncMock()),
    ]


DISCORD = "https://discord.com/api/webhooks/1/tok"
GENERIC = "https://hook.example.com/x"


@pytest.mark.anyio
async def test_discord_gets_content_generic_gets_envelope():
    """AC1: discord URL→{content}(서명 없음), generic→envelope(+서명)."""
    import contextlib
    sink: list = []
    member = uuid.uuid4()
    configs = [
        (DISCORD, None, [], member),
        (GENERIC, "sec", [], member),
    ]
    with contextlib.ExitStack() as st:
        for p in _patches(sink):
            st.enter_context(p)
        await wd.fire_webhooks(_session(configs), uuid.uuid4(), "story.status_changed",
                               {"story_title": "T"}, recipient_member_ids={member})

    by_url = {p["url"]: p for p in sink}
    dc = json.loads(by_url[DISCORD]["body"])
    assert "content" in dc and "event" not in dc
    assert "X-Sprintable-Signature" not in by_url[DISCORD]["headers"]  # discord 서명 없음
    gen = json.loads(by_url[GENERIC]["body"])
    assert gen["event"] == "story.status_changed" and "data" in gen
    assert "X-Sprintable-Signature" in by_url[GENERIC]["headers"]


@pytest.mark.anyio
async def test_gating_member_bound_only_relevant_broadcast_preserved():
    """AC2: recipient_member_ids 주어지면 member-bound는 관련자만·broadcast(null) 보존·무관 drop."""
    import contextlib
    sink: list = []
    relevant = uuid.uuid4()
    other = uuid.uuid4()
    configs = [
        ("https://discord.com/api/webhooks/relevant", None, [], relevant),  # 포함
        ("https://discord.com/api/webhooks/other", None, [], other),        # drop
        ("https://discord.com/api/webhooks/broadcast", None, [], None),     # 보존
    ]
    with contextlib.ExitStack() as st:
        for p in _patches(sink):
            st.enter_context(p)
        await wd.fire_webhooks(_session(configs), uuid.uuid4(), "story.status_changed",
                               {"story_title": "T"}, recipient_member_ids={relevant})

    urls = {p["url"] for p in sink}
    assert urls == {
        "https://discord.com/api/webhooks/relevant",
        "https://discord.com/api/webhooks/broadcast",
    }, "관련자 member-bound + broadcast만, 무관 member-bound drop"


@pytest.mark.anyio
async def test_none_recipient_keeps_existing_fanout():
    """AC3 무회귀: recipient_member_ids=None → 게이팅 0(전 활성 webhook 발송) = 기존 동작."""
    import contextlib
    sink: list = []
    configs = [
        ("https://discord.com/api/webhooks/a", None, [], uuid.uuid4()),
        ("https://discord.com/api/webhooks/b", None, [], uuid.uuid4()),
        ("https://discord.com/api/webhooks/c", None, [], None),
    ]
    with contextlib.ExitStack() as st:
        for p in _patches(sink):
            st.enter_context(p)
        await wd.fire_webhooks(_session(configs), uuid.uuid4(), "file_conflict",
                               {"severity": "warn"})  # recipient_member_ids 미전달

    assert len(sink) == 3, "None이면 전원 발송(기존 fan-out 유지)"


@pytest.mark.anyio
async def test_events_filter_still_applies():
    """이벤트 구독 필터(events) 회귀 가드 — 미구독 이벤트는 skip."""
    import contextlib
    sink: list = []
    member = uuid.uuid4()
    configs = [
        (DISCORD, None, ["other.event"], member),  # story.status_changed 미구독 → skip
    ]
    with contextlib.ExitStack() as st:
        for p in _patches(sink):
            st.enter_context(p)
        await wd.fire_webhooks(_session(configs), uuid.uuid4(), "story.status_changed",
                               {"story_title": "T"}, recipient_member_ids={member})
    assert sink == []
