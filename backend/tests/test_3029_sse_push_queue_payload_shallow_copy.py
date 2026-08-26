"""story #3029(카디르+codex 발견, #3447 QA 중, 2026-08-25) — 3026(A계열 fan-out fix)과
같은 "다중 연결" 문제군의 B계열 발현. `_push_to_agent`가 같은 member의 모든 큐에 **같은
dict 객체**를 복사 없이 넣었다 — generate() 라이브 루프가 그 객체에서 `_sse_transient_id`를
pop()할 때(#2158) 공유 객체라 먼저 처리되는 연결이 pop하면 다른 연결 큐에 든 "같은" 항목
에서도 키가 사라져, 두 번째 연결은 원본 id 대신 즉석 uuid4를 새로 발급한다(재연결 후 Redis
replay가 원본 id로 주는 것과 안 맞아 클라 dedup 무력화).

처방: 큐 적재 시 `dict(payload)` 얕은 복사 — 연결마다 독립 객체."""
from __future__ import annotations

import asyncio
import uuid

import pytest

from app.routers.events import _agent_connections, _push_to_agent


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_multiple_queues_receive_independent_objects_not_shared_reference():
    """다중 큐 same-object 재현의 반대 축 — 복사 後엔 같은 객체가 아니어야 한다(identity)."""
    member_id = str(uuid.uuid4())
    queue_a: asyncio.Queue = asyncio.Queue(maxsize=10)
    queue_b: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[member_id] = {queue_a, queue_b}

    try:
        _push_to_agent(member_id, {"event_type": "conversation.working"})  # B계열(event_id 없음).

        item_a = queue_a.get_nowait()
        item_b = queue_b.get_nowait()

        assert item_a is not item_b, "두 큐가 같은 dict 객체를 공유함 — 얕은 복사가 안 됨"
        # 값 자체는 동일해야(같은 논리적 이벤트, _sse_transient_id 포함 전부 동일).
        assert item_a == item_b
        assert item_a["_sse_transient_id"] == item_b["_sse_transient_id"]
    finally:
        _agent_connections.pop(member_id, None)


@pytest.mark.anyio
async def test_pop_on_one_connection_does_not_contaminate_the_other():
    """핵심 회귀가드 — 한 연결이 자기 사본에서 `_sse_transient_id`를 pop해도(generate()
    라이브 루프가 실제로 하는 것) 다른 연결의 사본은 그대로 남아 원본 id를 잃지 않는다.
    수정 前엔 이 assert가 실패했다(카디르 재현: same_object=True·2번째 pop=None)."""
    member_id = str(uuid.uuid4())
    queue_a: asyncio.Queue = asyncio.Queue(maxsize=10)
    queue_b: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[member_id] = {queue_a, queue_b}

    try:
        _push_to_agent(member_id, {"event_type": "presence"})

        item_a = queue_a.get_nowait()
        item_b = queue_b.get_nowait()
        original_id = item_a["_sse_transient_id"]
        assert item_b["_sse_transient_id"] == original_id  # 복사 前 값은 동일해야.

        # 연결 A가 먼저 처리(generate() 라이브 루프의 실제 동작: pop으로 소비).
        popped = item_a.pop("_sse_transient_id", None)
        assert popped == original_id

        # 연결 B의 사본은 A의 pop과 무관 — 여전히 원본 id를 갖고 있어야 한다.
        assert item_b.get("_sse_transient_id") == original_id, (
            "연결 A의 pop이 연결 B의 사본을 오염시킴(공유 객체 회귀) — "
            "재연결 replay가 원본 id로 주는 값과 라이브 발급 id가 어긋나 클라 dedup 무력화"
        )
    finally:
        _agent_connections.pop(member_id, None)


@pytest.mark.anyio
async def test_a_class_event_with_explicit_event_id_also_gets_independent_copies():
    """A계열(event_id 有)도 동일 보호를 받는지 — B계열 전용 결함이 아니라 이 함수의
    일반 계약(모든 push가 큐마다 독립 사본)임을 확認."""
    member_id = str(uuid.uuid4())
    queue_a: asyncio.Queue = asyncio.Queue(maxsize=10)
    queue_b: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[member_id] = {queue_a, queue_b}

    try:
        eid = str(uuid.uuid4())
        _push_to_agent(member_id, {"event_type": "conversation.gate_resolved", "event_id": eid})

        item_a = queue_a.get_nowait()
        item_b = queue_b.get_nowait()
        assert item_a is not item_b
        item_a["mutated"] = True
        assert "mutated" not in item_b
    finally:
        _agent_connections.pop(member_id, None)
