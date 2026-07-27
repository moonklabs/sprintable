"""1aeecdde P2: 채팅 working/typing 인디케이터 — 답장 생성구간 ephemeral 신호.

online/offline(연결 축·team_members.presence_status·DB 도출)과 **별도 축**(working = 작업 축·이 모듈).

emit 훅(BE) — 생성 종료 신호는 **3중**(d5de8e08 longevity):
- set_working: 메시지가 agent participant 에게 dispatch 될 때(=답장 생성 시작).
- clear_working: 그 agent 가 reply POST 할 때(=생성 종료·즉시 clear).
- clear_member: SSE 연결 끊길 때(disconnect·agent_gateway·안전망).
- 위 셋 다 안 와도 _TTL_SEC 후 자동 소멸(backstop).

⭐ #2120(E-ARCH 근본, 2026-07-22): 기존 instance-local in-memory 저장을 **Redis 공유**로 전환.
멀티인스턴스(GCE 3노드·Cloud Run 스케일)서 inst-A working 이 inst-B GET 에 안 보이던 파편화를
근본 해소한다(E-GCE-RT S7 실측: GCE 3-고정노드로 오히려 악화됐던 그 결함).
- 저장: per-conv ZSET(member=member_id, score=만료ts) + companion HASH(state) + 전역 ZSET(횡단 집계)
  + member_convs SET(clear_member O(1)용). 만료는 네이티브 score-eviction(_evict 불요).
- 폴백: `PRESENCE_REDIS_ENABLED` off 또는 Redis 다운 → 아래 in-memory 저장(현 동작·fail-open).
  presence 는 non-critical UI 라 fail-open(끊지 않고 per-inst 파편화 감수)이 맞다.
- ⚠️함수가 sync→async 전환됨(aioredis) — 호출부(conversations·agent_gateway·team_presence·
  presence_events)가 await 하도록 함께 수정.
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import asdict, dataclass, field

from app.core.config import settings
from app.services import redis_shared

logger = logging.getLogger(__name__)

# 답장 생성 구간 working TTL(초). d5de8e08: 45→180. env 로 라이브 튜닝.
_TTL_SEC = int(os.getenv("CHAT_WORKING_TTL_SEC", "180"))
# leak backstop: Redis 키 자체 만료(score-eviction 을 못 탄 잔여 방지). TTL 의 넉넉한 배수.
_KEY_TTL_SEC = _TTL_SEC * 4

VALID_STATES = ("working", "typing")

_DOMAIN = "presence"


def _redis_enabled() -> bool:
    return bool(getattr(settings, "presence_redis_enabled", False)) and bool(settings.redis_url)


# ── Redis 키 ──────────────────────────────────────────────────────────────────
def _conv_key(conversation_id: str) -> str:  # ZSET member=member_id score=expiry
    return redis_shared.key(_DOMAIN, "working", conversation_id)


def _state_key(conversation_id: str) -> str:  # HASH member_id→state
    return redis_shared.key(_DOMAIN, "working_state", conversation_id)


def _all_key() -> str:  # 전역 ZSET member=member_id score=expiry(횡단 집계)
    return redis_shared.key(_DOMAIN, "working_all")


def _member_convs_key(member_id: str) -> str:  # SET member 가 working 인 conv 목록
    return redis_shared.key(_DOMAIN, "member_convs", member_id)


# ── in-memory 폴백 저장(현 동작·Redis off/다운 시) ─────────────────────────────
@dataclass
class WorkingEntry:
    member_id: str
    state: str
    updated_at: float = field(default_factory=time.time)


# conversation_id → {member_id: WorkingEntry}
_working_store: dict[str, dict[str, WorkingEntry]] = {}


def _mem_evict_expired(conversation_id: str) -> None:
    now = time.time()
    store = _working_store.get(conversation_id, {})
    for mid in [m for m, e in store.items() if now - e.updated_at > _TTL_SEC]:
        store.pop(mid, None)
    if not store:
        _working_store.pop(conversation_id, None)


# ── 공개 API(async) ───────────────────────────────────────────────────────────
async def set_working(conversation_id: str, member_id: str, state: str = "working") -> None:
    """답장 생성 시작 — member 를 conversation 의 working 집합에 등록(TTL 갱신·Redis 공유)."""
    if state not in VALID_STATES:
        state = "working"

    def _mem() -> None:
        _working_store.setdefault(conversation_id, {})[member_id] = WorkingEntry(
            member_id=member_id, state=state
        )

    if not _redis_enabled():
        return _mem()

    async def _op(client) -> None:
        expiry = time.time() + _TTL_SEC
        pipe = client.pipeline()
        pipe.zadd(_conv_key(conversation_id), {member_id: expiry})
        pipe.hset(_state_key(conversation_id), member_id, state)
        pipe.zadd(_all_key(), {member_id: expiry})
        pipe.sadd(_member_convs_key(member_id), conversation_id)
        pipe.expire(_conv_key(conversation_id), _KEY_TTL_SEC)
        pipe.expire(_state_key(conversation_id), _KEY_TTL_SEC)
        pipe.expire(_all_key(), _KEY_TTL_SEC)
        pipe.expire(_member_convs_key(member_id), _KEY_TTL_SEC)
        await pipe.execute()

    await redis_shared.with_fallback(_op, _mem)


async def clear_working(conversation_id: str, member_id: str) -> None:
    """답장 생성 종료(reply POST) — member 의 working 신호 제거. 없으면 무해(no-op)."""

    def _mem() -> None:
        store = _working_store.get(conversation_id)
        if store is None:
            return
        store.pop(member_id, None)
        if not store:
            _working_store.pop(conversation_id, None)

    if not _redis_enabled():
        return _mem()

    async def _op(client) -> None:
        pipe = client.pipeline()
        pipe.zrem(_conv_key(conversation_id), member_id)
        pipe.hdel(_state_key(conversation_id), member_id)
        pipe.srem(_member_convs_key(member_id), conversation_id)
        await pipe.execute()
        # member 가 다른 conv 에도 없으면 전역 집계서도 제거(leak 0)
        if not await client.scard(_member_convs_key(member_id)):
            await client.zrem(_all_key(), member_id)

    await redis_shared.with_fallback(_op, _mem)


async def clear_member(member_id: str) -> list[str]:
    """안전망: member 의 **전 conversation** working 제거(disconnect 시). 제거된 conv 목록 반환."""

    def _mem() -> list[str]:
        affected, empty = [], []
        for conv, store in _working_store.items():
            if store.pop(member_id, None) is not None:
                affected.append(conv)
                if not store:
                    empty.append(conv)
        for conv in empty:
            _working_store.pop(conv, None)
        return affected

    if not _redis_enabled():
        return _mem()

    async def _op(client) -> list[str]:
        convs = list(await client.smembers(_member_convs_key(member_id)))
        if convs:
            pipe = client.pipeline()
            for conv in convs:
                pipe.zrem(_conv_key(conv), member_id)
                pipe.hdel(_state_key(conv), member_id)
            await pipe.execute()
        await client.zrem(_all_key(), member_id)
        await client.delete(_member_convs_key(member_id))
        return convs

    return await redis_shared.with_fallback(_op, _mem)


async def list_working(conversation_id: str) -> list[dict]:
    """conversation 에서 현재 working/typing 중인 member 목록(만료분 제외·Redis 공유)."""

    def _mem() -> list[dict]:
        _mem_evict_expired(conversation_id)
        return [{**asdict(e)} for e in _working_store.get(conversation_id, {}).values()]

    if not _redis_enabled():
        return _mem()

    async def _op(client) -> list[dict]:
        now = time.time()
        ck = _conv_key(conversation_id)
        await client.zremrangebyscore(ck, "-inf", now)  # 만료 evict
        members = await client.zrange(ck, 0, -1, withscores=True)
        if not members:
            return []
        ids = [m for m, _ in members]
        states = await client.hmget(_state_key(conversation_id), ids)
        out = []
        for (mid, score), st in zip(members, states):
            out.append(
                {"member_id": mid, "state": st or "working", "updated_at": score - _TTL_SEC}
            )
        return out

    return await redis_shared.with_fallback(_op, _mem)


async def working_member_ids() -> set[str]:
    """전 conversation 횡단 — 현재 working 중인 member_id 집합(만료 제외·Redis 공유). 팀 presence 집계용."""

    def _mem() -> set[str]:
        now = time.time()
        out: set[str] = set()
        for store in list(_working_store.values()):
            for mid, e in store.items():
                if now - e.updated_at <= _TTL_SEC:
                    out.add(mid)
        return out

    if not _redis_enabled():
        return _mem()

    async def _op(client) -> set[str]:
        now = time.time()
        await client.zremrangebyscore(_all_key(), "-inf", now)
        return set(await client.zrange(_all_key(), 0, -1))

    return await redis_shared.with_fallback(_op, _mem)
