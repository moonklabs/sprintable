"""story #3026(실사고, PO 확定 2026-08-24) — events.py 라이브 루프의 pre-yield dedup을
`Event.status`(DB, org 전체 공유) 조회에서 연결-로컬 `_sent_event_ids` 집합(+순수함수
`_should_skip_live_event`)으로 교체한 처방 검증. 실사고 근거: 968fe78d 게이트 해소 이벤트가
동일 member(sellerking)의 두 연결(페이지 탭+독립 프로브) 중 어느 쪽에도 안 뜨고 +59초 지연
뒤에야 감(delivered_at 편차 +0.1s~+103s — "안 옴"이 아니라 "어느 연결이 이기느냐"의 복권).

가드레일(PO)에 따라 두 불변식을 짝으로 고정한다. 실 SSE 스트림 종단간(TestClient 두 연결
동시)은 이 샌드박스에서 anyio/TestClient 하네스 자체가 불안정(30초+ hang, 이 세션의 다른
정상 동작 테스트(test_eventbus_s2.py)와 동일 패턴으로도 재현) — 그 축은 PO 가드레일③이
이미 카디르 다중연결 라이브 QA로 배정해 뒀으므로 여기선 로직을 순수함수+직접 구조 조작으로
격리해 결정적으로 고정한다:

① `_should_skip_live_event`(추출한 순수함수) 자체의 진위표 — 연결-로컬 집합 의미론.
② `_push_to_agent`의 fan-out이 **같은 member_id의 여러 큐 전부**에 도달하는지(다른
   member끼리의 격리를 검증하는 기존 test_agent_isolation_multiple_connections의 반대
   축 — "같은 member, 다른 연결"은 그 테스트가 안 다룸)."""
from __future__ import annotations

import asyncio
import uuid

import pytest

from app.routers.events import _agent_connections, _push_to_agent, _should_skip_live_event


@pytest.fixture
def anyio_backend():
    return "asyncio"


class TestShouldSkipLiveEvent:
    """① 순수함수 진위표 — generate()가 매 연결마다 새로 만드는 로컬 집합을 그대로 흉내."""

    def test_eid_none_never_skips(self):
        assert _should_skip_live_event(None, {"a", "b"}) is False

    def test_eid_not_in_local_set_does_not_skip(self):
        """이 연결이 아직 안 보낸 id — 다른 연결이 몇 번을 먼저 보냈어도(집합에 안 들어있는
        한) 이 연결은 여전히 내보내야 한다. #3026 핵심 — 예전 DB-status 체크였다면 다른
        연결이 먼저 delivered로 찍은 순간 이 자리가 True(skip)가 됐을 상황."""
        assert _should_skip_live_event("evt-1", set()) is False
        assert _should_skip_live_event("evt-1", {"evt-2", "evt-3"}) is False

    def test_eid_in_local_set_skips(self):
        """이 연결이 이미 보낸 id(백필 또는 이전 라이브) — 같은 연결 내 중복만 막는다."""
        assert _should_skip_live_event("evt-1", {"evt-1"}) is True

    def test_empty_string_eid_never_skips(self):
        """falsy eid(빈 문자열)는 B계열(event_id 없는 transient push) 취급과 동형 — 애초에
        이 게이트를 안 탄다(빈 문자열도 falsy라 `bool(eid)`에서 걸러짐)."""
        assert _should_skip_live_event("", {""}) is False


@pytest.mark.anyio
async def test_push_to_agent_fans_out_to_all_queues_of_same_member():
    """② 같은 member_id의 서로 다른 연결(탭 2개 시뮬레이션) — `_push_to_agent`가 그 member의
    **모든** 큐에 도달시킨다(연결이 몇 개든). #3026 실사고 재현 시나리오(페이지 탭+프로브
    둘 다 같은 member)의 push 단계 — 이 단계는 원래도 정상이었음을 재확認(회귀가드), 실제
    결함은 yield 단계(위 순수함수 테스트가 그 축을 고정)였다는 진단을 구조로도 뒷받침."""
    member_id = str(uuid.uuid4())
    queue_1: asyncio.Queue = asyncio.Queue(maxsize=10)
    queue_2: asyncio.Queue = asyncio.Queue(maxsize=10)
    queue_3: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[member_id] = {queue_1, queue_2, queue_3}

    try:
        eid = str(uuid.uuid4())
        payload = {"event_type": "conversation.gate_resolved", "event_id": eid, "gate_id": "g-1", "status": "approved"}
        pushed = _push_to_agent(member_id, payload)

        assert pushed is True
        for q in (queue_1, queue_2, queue_3):
            received = q.get_nowait()
            assert received["event_id"] == eid
            assert q.empty()
    finally:
        _agent_connections.pop(member_id, None)


@pytest.mark.anyio
async def test_push_to_agent_survives_one_dead_queue_among_many():
    """부수 회귀가드 — 동시 연결 중 하나가 꽉 차 있어도(QueueFull) 나머지 연결은 정상 수신.

    ⚠️story #2530(2026-08-24) 정정 — 이 테스트는 원래 QueueFull 시 그 큐(연결)가
    `_agent_connections`에서 **제거**되는 걸 기대했다. #2530 그라운딩에서 그 discard
    자체가 "연결은 살아 보이는데 신호만 영구히 죽는" 실사고 후보로 밝혀져, 처방을
    "가장 오래된 항목을 버리고 자리를 만들어 연결은 유지"로 바꿨다(agent_gateway.py
    wake_agent과 동일 원칙 — 상세: test_2530_agent_wake_queue_overflow_keeps_connection.py).
    이 테스트는 이제 그 새 계약(연결 유지+ring-buffer)을 고정한다."""
    member_id = str(uuid.uuid4())
    full_queue: asyncio.Queue = asyncio.Queue(maxsize=1)
    full_queue.put_nowait({"event_type": "filler"})  # 꽉 채워 QueueFull 유도.
    alive_queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[member_id] = {full_queue, alive_queue}

    try:
        eid = str(uuid.uuid4())
        pushed = _push_to_agent(member_id, {"event_type": "conversation.gate_resolved", "event_id": eid})

        assert pushed is True  # 둘 다 성공(가득 찼던 쪽도 드롭+재시도로 성공).
        assert alive_queue.get_nowait()["event_id"] == eid
        # full_queue는 제거되지 않고 남아있어야 함(#2530) — 오래된 "filler"는 버려지고
        # 이번 이벤트가 대신 들어가 있다.
        assert full_queue in _agent_connections[member_id]
        assert full_queue.get_nowait()["event_id"] == eid
    finally:
        _agent_connections.pop(member_id, None)
