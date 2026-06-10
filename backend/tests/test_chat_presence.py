"""1aeecdde P2: 채팅 working/typing ephemeral 신호(chat_presence) 단위 테스트.

AC1: 답장 생성구간 working emit·TTL 자동 소멸. AC2: presence(online)와 별도 축.
"""
from __future__ import annotations

import time
import uuid

import pytest

from app.services import chat_presence


@pytest.fixture(autouse=True)
def _clear_store():
    """각 테스트 격리 — 모듈 전역 store 초기화."""
    chat_presence._working_store.clear()
    yield
    chat_presence._working_store.clear()


def test_set_then_list_returns_member():
    conv = str(uuid.uuid4())
    mid = str(uuid.uuid4())
    chat_presence.set_working(conv, mid)
    items = chat_presence.list_working(conv)
    assert len(items) == 1
    assert items[0]["member_id"] == mid
    assert items[0]["state"] == "working"


def test_clear_removes_member():
    conv, mid = str(uuid.uuid4()), str(uuid.uuid4())
    chat_presence.set_working(conv, mid)
    chat_presence.clear_working(conv, mid)
    assert chat_presence.list_working(conv) == []


def test_clear_missing_is_noop():
    """answer 없이 clear(휴먼 sender 등) — 예외 없이 no-op."""
    chat_presence.clear_working(str(uuid.uuid4()), str(uuid.uuid4()))  # 예외 없어야 함


def test_invalid_state_falls_back_to_working():
    conv, mid = str(uuid.uuid4()), str(uuid.uuid4())
    chat_presence.set_working(conv, mid, state="bogus")
    assert chat_presence.list_working(conv)[0]["state"] == "working"


def test_typing_state_preserved():
    conv, mid = str(uuid.uuid4()), str(uuid.uuid4())
    chat_presence.set_working(conv, mid, state="typing")
    assert chat_presence.list_working(conv)[0]["state"] == "typing"


def test_ttl_eviction():
    """TTL 초과 entry 는 list 시 제거(ephemeral 자동 소멸 — 미reply 안전망)."""
    conv, mid = str(uuid.uuid4()), str(uuid.uuid4())
    chat_presence.set_working(conv, mid)
    # updated_at 을 TTL 이전으로 backdate
    chat_presence._working_store[conv][mid].updated_at = time.time() - chat_presence._TTL_SEC - 1
    assert chat_presence.list_working(conv) == []
    # 전부 만료되면 conversation 키도 정리
    assert conv not in chat_presence._working_store


def test_multiple_members_independent():
    conv = str(uuid.uuid4())
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    chat_presence.set_working(conv, a)
    chat_presence.set_working(conv, b, state="typing")
    chat_presence.clear_working(conv, a)
    items = chat_presence.list_working(conv)
    assert len(items) == 1 and items[0]["member_id"] == b


def test_set_emit_hook_wired_in_dispatch():
    """_dispatch_conversation_event 가 agent recipient 에 set_working 호출하는지 소스 가드."""
    import inspect
    from app.routers.conversations import _dispatch_conversation_event
    src = inspect.getsource(_dispatch_conversation_event)
    assert "chat_presence.set_working" in src


def test_clear_emit_hook_wired_in_send_message():
    """send_message 가 clear_working 호출하는지 소스 가드(원본 conversation_id 기준)."""
    import inspect
    from app.routers.conversations import send_message
    src = inspect.getsource(send_message)
    assert "chat_presence.clear_working" in src


# ── eb1a8f95: 전 conversation 횡단 working 집계 ────────────────────────────────

def test_working_member_ids_aggregates_across_conversations():
    c1, c2 = str(uuid.uuid4()), str(uuid.uuid4())
    a, b, c = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    chat_presence.set_working(c1, a)
    chat_presence.set_working(c1, b)
    chat_presence.set_working(c2, c)
    ids = chat_presence.working_member_ids()
    assert ids == {a, b, c}


def test_working_member_ids_same_member_multiple_convs_once():
    c1, c2 = str(uuid.uuid4()), str(uuid.uuid4())
    a = str(uuid.uuid4())
    chat_presence.set_working(c1, a)
    chat_presence.set_working(c2, a)  # 같은 멤버 두 conversation에서 working
    assert chat_presence.working_member_ids() == {a}


def test_working_member_ids_excludes_expired():
    c1 = str(uuid.uuid4())
    a = str(uuid.uuid4())
    chat_presence.set_working(c1, a)
    chat_presence._working_store[c1][a].updated_at = time.time() - chat_presence._TTL_SEC - 1
    assert chat_presence.working_member_ids() == set()


def test_working_member_ids_empty():
    assert chat_presence.working_member_ids() == set()


# ── d5de8e08: working longevity — TTL 상향 + disconnect 안전망 clear_member ──────

def test_ttl_bumped_for_long_replies():
    """긴 in-product 응답(>45s)이 턴 도중 떨어지지 않도록 TTL 상향(>=120s)."""
    assert chat_presence._TTL_SEC >= 120


def test_clear_member_removes_across_all_conversations():
    c1, c2, c3 = (str(uuid.uuid4()) for _ in range(3))
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    chat_presence.set_working(c1, a)
    chat_presence.set_working(c2, a)
    chat_presence.set_working(c2, b)   # 다른 멤버 — 보존돼야
    chat_presence.set_working(c3, a)
    chat_presence.clear_member(a)
    assert chat_presence.working_member_ids() == {b}      # a 전부 제거, b 유지
    c2_ids = {e["member_id"] for e in chat_presence.list_working(c2)}
    assert c2_ids == {b}                                  # c2 의 b 는 보존
    assert c1 not in chat_presence._working_store          # 빈 conversation 정리
    assert c3 not in chat_presence._working_store


def test_clear_member_missing_is_noop():
    chat_presence.clear_member(str(uuid.uuid4()))  # 예외 없어야 함
