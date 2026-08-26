"""story #2530(2026-08-24, PO 판정) — 「선생님→에이전트 미도달」읽기방향 그라운딩에서 발견:
`wake_agent()`(agent_gateway.py)와 형제 함수 `_push_to_agent()`(events.py) 둘 다, 대상 큐가
가득 차면(QueueFull) 그 큐(=그 연결)를 `_agent_connections`에서 **통째로 제거**했다.

스트림 자체는 안 끊긴 채("연결은 살아 보이는" 상태) 그 agent_id/member_id로 오는 모든 이후
wake/push 호출이 이 연결을 dict에서 영원히 못 찾아 조용히 no-op — "연결은 살았는데 신호만
죽는" 반쪽 상태가 코드로 가능했다(버스트성 대량 이벤트 직후 「왕왕」 미도달 패턴과 정합하는
실 후보).

처방: 큐를 ring-buffer로 다뤄 가장 오래된 항목을 버리고 자리를 만든다 — 연결을 절대 dict에서
지우지 않는다. 이 파일은 순수 in-memory 로직(`_agent_connections`/`asyncio.Queue`)만 다뤄
DB·HTTP 없이 검증한다(#3026/#3029와 동일 방법론 — 이 클래스 버그는 실 DB가 필요 없다)."""
from __future__ import annotations

import asyncio

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _clean_agent_connections():
    """`_agent_connections`는 두 모듈이 공유하는 프로세스 전역 defaultdict — 테스트 간
    오염을 막기 위해 이 테스트가 건드리는 키만 매번 정리한다."""
    from app.routers.events import _agent_connections

    yield
    _agent_connections.pop("test-agent-2530", None)


@pytest.mark.anyio
async def test_wake_agent_keeps_connection_registered_on_queue_overflow():
    """⭐핵심 — 큐가 가득 차도 연결이 `_agent_connections`에서 사라지면 안 된다."""
    from app.routers.agent_gateway import wake_agent
    from app.routers.events import _agent_connections

    agent_id = "test-agent-2530"
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    _agent_connections[agent_id].add(q)

    # 큐를 가득 채운다(maxsize=2).
    q.put_nowait({"__wake__": True, "seq": 1})
    q.put_nowait({"__wake__": True, "seq": 2})
    assert q.full()

    # 오버플로를 유발하는 3번째 wake — 예전엔 이 호출이 연결을 dict에서 지웠다.
    wake_agent(agent_id, seq=3, _from_listener=True)  # _from_listener=True: pg_notify 재발행 skip.

    assert agent_id in _agent_connections, "큐 오버플로 후에도 연결이 dict에 남아있어야 함"
    assert q in _agent_connections[agent_id], "이 큐 자체가 여전히 등록돼 있어야 함"


@pytest.mark.anyio
async def test_wake_agent_drops_oldest_and_admits_newest_on_overflow():
    """오래된 신호는 버려지고 새 신호가 대신 자리를 잡는다(ring-buffer)."""
    from app.routers.agent_gateway import wake_agent
    from app.routers.events import _agent_connections

    agent_id = "test-agent-2530"
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    _agent_connections[agent_id].add(q)

    q.put_nowait({"__wake__": True, "seq": 1})
    q.put_nowait({"__wake__": True, "seq": 2})

    wake_agent(agent_id, seq=3, _from_listener=True)

    drained = [q.get_nowait() for _ in range(q.qsize())]
    seqs = [item["seq"] for item in drained]
    assert 1 not in seqs, "가장 오래된 신호(seq=1)는 버려져야 함"
    assert 3 in seqs, "이번 신호(seq=3)는 자리를 만들어 들어가야 함"


@pytest.mark.anyio
async def test_wake_agent_subsequent_call_still_reaches_connection_after_overflow():
    """⭐AC 판별자 — 오버플로 이후에도 «다음» wake_agent() 호출이 이 연결에 정상 도달해야
    한다(연결이 dict에서 사라졌다면 이 두 번째 호출도 조용히 no-op됐을 것)."""
    from app.routers.agent_gateway import wake_agent
    from app.routers.events import _agent_connections

    agent_id = "test-agent-2530"
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    _agent_connections[agent_id].add(q)

    q.put_nowait({"__wake__": True, "seq": 1})
    q.put_nowait({"__wake__": True, "seq": 2})
    wake_agent(agent_id, seq=3, _from_listener=True)  # 오버플로 유발.

    # 큐를 완전히 비운 뒤(컨슈머가 따라잡은 상황을 재현) 새 wake를 보낸다.
    while not q.empty():
        q.get_nowait()
    wake_agent(agent_id, seq=4, _from_listener=True)

    assert q.qsize() == 1
    assert q.get_nowait()["seq"] == 4, "오버플로 이후에도 다음 wake가 이 연결에 정상 도달해야 함"


@pytest.mark.anyio
async def test_push_to_agent_keeps_connection_registered_on_queue_overflow():
    """`_push_to_agent`(events.py, 브라우저 SSE) — wake_agent과 동일 형제 결함·동일 처방."""
    from app.routers.events import _agent_connections, _push_to_agent

    member_id = "test-agent-2530"
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    _agent_connections[member_id].add(q)

    q.put_nowait({"event_type": "conversation.message_created", "data": {"n": 1}})
    q.put_nowait({"event_type": "conversation.message_created", "data": {"n": 2}})
    assert q.full()

    pushed = _push_to_agent(
        member_id, {"event_type": "conversation.message_created", "data": {"n": 3}},
        _from_listener=True,
    )

    assert pushed is True, "오버플로 처리(드롭+재시도) 後 이번 push는 성공해야 함"
    assert member_id in _agent_connections, "큐 오버플로 후에도 연결이 dict에 남아있어야 함"
    assert q in _agent_connections[member_id]


@pytest.mark.anyio
async def test_push_to_agent_subsequent_call_still_reaches_connection_after_overflow():
    """⭐AC 판별자(events.py 쪽) — 오버플로 이후에도 다음 push가 이 연결에 정상 도달해야 함."""
    from app.routers.events import _agent_connections, _push_to_agent

    member_id = "test-agent-2530"
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    _agent_connections[member_id].add(q)

    q.put_nowait({"event_type": "x", "data": {"n": 1}})
    q.put_nowait({"event_type": "x", "data": {"n": 2}})
    _push_to_agent(member_id, {"event_type": "x", "data": {"n": 3}}, _from_listener=True)

    while not q.empty():
        q.get_nowait()
    pushed = _push_to_agent(member_id, {"event_type": "x", "data": {"n": 4}}, _from_listener=True)

    assert pushed is True
    assert q.qsize() == 1
    assert q.get_nowait()["data"]["n"] == 4
