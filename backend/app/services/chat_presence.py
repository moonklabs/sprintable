"""1aeecdde P2: 채팅 working/typing 인디케이터 — 답장 생성구간 ephemeral 신호.

memo `presence.py`(viewing/typing) 동형 — in-memory·TTL 기반 ephemeral 저장소. presence P1
(online/offline = 연결 축)과 **별도 축**(working = 작업 축). 같은 dot에 합치지 말 것(AC2):
- online: SSE 연결 여부(team_members.presence_status·DB 도출)
- working: 지금 답장을 생성 중인지(이 모듈·in-memory ephemeral)

emit 훅(BE) — 생성 종료 신호는 **3중**(d5de8e08 longevity):
- set_working: 메시지가 agent participant 에게 dispatch 될 때(=이벤트 수신점). 답장 생성 시작.
- clear_working: 그 agent 가 conversation 에 메시지를 보낼 때(=reply POST). 생성 종료 — 즉시 clear.
- clear_member: 그 agent 의 SSE 연결이 끊길 때(disconnect/크래시→offline·agent_gateway). 안전망.
- 위 셋 다 안 와도 _TTL_SEC 후 자동 소멸 — backstop(답장 안 하기로 한 connected 에이전트 leak bound).

d5de8e08: 초기 45s TTL 은 >45s 긴 in-product 응답이 턴 도중 떨어지는 문제(선생님 "thinking 중인데
online")가 있어 ~180s 로 상향(env `CHAT_WORKING_TTL_SEC`). reply→즉시 clear / disconnect→clear 가
정상 종료 경로이고 TTL 은 비정상(답 안 함·크래시) leak 의 backstop 역할로 후퇴. self-report 없음
(연결·reply 등 product-observable 신호만 — 선생님 명시 MCP 경량화).

⚠️ 멀티인스턴스 한계: presence.py 와 동일하게 인스턴스-로컬 in-memory. 같은 인스턴스가 emit·GET
을 처리해야 보인다. 크로스-인스턴스 실시간(Cloud Run 다인스턴스)은 pubsub/SSE 브로드캐스트가
필요하며 FE 전송 설계와 함께 후속(P3)으로 다룬다.
"""
from __future__ import annotations

import os
import time
from dataclasses import asdict, dataclass, field

# 답장 생성 구간 working TTL(초). d5de8e08: 45→180 상향 — 긴 in-product 응답(>45s)이 턴 도중
# online 으로 떨어지지 않게. 정상 종료는 reply(clear_working)·disconnect(clear_member)가 담당하고,
# TTL 은 답 안 하는 connected 에이전트·하드크래시(finally 미실행) leak 의 backstop. env 로 라이브 튜닝.
_TTL_SEC = int(os.getenv("CHAT_WORKING_TTL_SEC", "180"))

VALID_STATES = ("working", "typing")


@dataclass
class WorkingEntry:
    member_id: str
    state: str  # "working" | "typing"
    updated_at: float = field(default_factory=time.time)


# conversation_id(str) → {member_id(str): WorkingEntry}
_working_store: dict[str, dict[str, WorkingEntry]] = {}


def _evict_expired(conversation_id: str) -> None:
    now = time.time()
    store = _working_store.get(conversation_id, {})
    expired = [mid for mid, e in store.items() if now - e.updated_at > _TTL_SEC]
    for mid in expired:
        store.pop(mid, None)
    if not store:
        _working_store.pop(conversation_id, None)


def set_working(conversation_id: str, member_id: str, state: str = "working") -> None:
    """답장 생성 시작 — member 를 conversation 의 working 집합에 등록(TTL 갱신)."""
    if state not in VALID_STATES:
        state = "working"
    _working_store.setdefault(conversation_id, {})[member_id] = WorkingEntry(
        member_id=member_id, state=state
    )


def clear_working(conversation_id: str, member_id: str) -> None:
    """답장 생성 종료(reply POST) — member 의 working 신호 제거. 없으면 무해(no-op)."""
    store = _working_store.get(conversation_id)
    if store is None:
        return
    store.pop(member_id, None)
    if not store:
        _working_store.pop(conversation_id, None)


def clear_member(member_id: str) -> list[str]:
    """d5de8e08 안전망: member 의 **전 conversation** working 신호 제거.

    SSE 연결이 끊길 때(disconnect/크래시→offline·agent_gateway) 호출 — 연결이 사라지면 그 에이전트는
    더 이상 생성 중일 수 없으므로 즉시 정리(TTL backstop 기다리지 않음). 없으면 무해(no-op).

    R2: working 이 실제로 제거된 conversation_id 목록을 반환 — 호출부(agent_gateway)가 각 conversation 에
    conversation.working SSE 를 발행해 "...typing" 잔존을 막는다(기존 caller 는 반환 무시·무영향).
    """
    affected = []
    empty_convs = []
    for conv, store in _working_store.items():
        if store.pop(member_id, None) is not None:
            affected.append(conv)
            if not store:
                empty_convs.append(conv)
    for conv in empty_convs:
        _working_store.pop(conv, None)
    return affected


def list_working(conversation_id: str) -> list[dict]:
    """conversation 에서 현재 working/typing 중인 member 목록(만료분 제외)."""
    _evict_expired(conversation_id)
    return [
        {**asdict(e)}
        for e in _working_store.get(conversation_id, {}).values()
    ]


def working_member_ids() -> set[str]:
    """eb1a8f95: 전 conversation 횡단 — 현재 working 중인 member_id 집합(만료 제외).

    팀 presence 집계용. 어느 conversation 이든 working 이면 포함(B 결정="여부만"·for-whom 미포함).
    read-only(만료분은 결과에서 제외만, store 변형 없음). 멀티인스턴스 per-instance best-effort
    (이 인스턴스가 emit 받은 working 만 — list_working 과 동일 한계).
    """
    now = time.time()
    out: set[str] = set()
    for store in list(_working_store.values()):
        for mid, e in store.items():
            if now - e.updated_at <= _TTL_SEC:
                out.add(mid)
    return out
