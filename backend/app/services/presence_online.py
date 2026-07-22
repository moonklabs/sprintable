"""#2120 AC2: online liveness를 Redis 키로 — 30s SSE-틱 hot-path DB write 제거.

per-member online 키(값=마지막 틱 ISO ts·EX 90s). 세 소비자:
- 라우터(team_members/team_presence): effective_last_seen 주입(Redis ts ?? DB last_seen_at) — computed_field 무변경.
- reachability(agent_verify._has_fresh_session): 도달성 판정(키 존재)·Redis 불가 시 세션-row 존재로 폴백(fail-open).
- 좀비 GC: Redis 부재 기반으로 게이트(live long-connection row 오삭제 방지).

flag `presence_online_redis_enabled`(§2 presence_redis_enabled 와 **독립** kill switch — AC2 롤백이 검증완료
§2 를 끄지 않게). off = 현 DB-틱 경로 그대로(무회귀). on 이라도 connect/disconnect DB write 는 유지(내구+폴백).
"""
from __future__ import annotations

import datetime
import logging
import os

from app.core.config import settings
from app.services import redis_shared

logger = logging.getLogger(__name__)

_DOMAIN = "presence"
# SSE 30s 틱 × 3 = 90s(2회 누락 허용·기존 _SESSION_FRESH_TTL 과 동일 근거).
_TTL_SEC = int(os.getenv("SSE_HEARTBEAT_TIMEOUT", "30")) * 3


def _enabled() -> bool:
    return bool(getattr(settings, "presence_online_redis_enabled", False)) and bool(settings.redis_url)


def _key(member_id: str) -> str:
    return redis_shared.key(_DOMAIN, "online", str(member_id))


async def mark_online(member_id: str) -> None:
    """연결 라이브니스 갱신 — online 키 SET(now ISO, EX 90). off/Redis 다운 → no-op(연결/해제 DB가 폴백)."""
    if not _enabled():
        return
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()

    async def _op(client) -> None:
        await client.set(_key(member_id), ts, ex=_TTL_SEC)

    await redis_shared.with_fallback(_op, lambda: None)


async def clear_online(member_id: str) -> None:
    """마지막 disconnect — online 키 DEL(즉시 offline·90s 잔존 방지). off/다운 → no-op."""
    if not _enabled():
        return

    async def _op(client) -> None:
        await client.delete(_key(member_id))

    await redis_shared.with_fallback(_op, lambda: None)


async def get_online_map(member_ids) -> dict[str, str]:
    """member_ids 중 online 키가 살아있는 것 → {member_id: ts}. 라우터 last_seen_at 주입용.

    off/Redis 다운/키 부재 → 해당 member 미포함(라우터가 DB last_seen_at 로 폴백). 배치 MGET(1 라운드트립).
    """
    ids = [str(m) for m in member_ids]
    if not _enabled() or not ids:
        return {}

    async def _op(client) -> dict[str, str]:
        vals = await client.mget([_key(m) for m in ids])
        return {m: v for m, v in zip(ids, vals) if v}

    return await redis_shared.with_fallback(_op, lambda: {})


async def is_online(member_id: str) -> "bool | None":
    """reachability 판정 — online 키 존재 여부. True/False = Redis 판정.

    **None = Redis 불가(off/다운/에러)** → 호출부가 세션-row **존재 여부**(freshness 아님)로 폴백해야 함
    (fail-open: 도달성=메시지 배달 경로라 Redis 다운서도 연결중이면 배달 유지).
    """
    if not _enabled():
        return None
    client = redis_shared.get_client()
    if client is None:
        return None
    try:
        return bool(await client.exists(_key(member_id)))
    except Exception:
        logger.warning("presence_online.is_online failed → caller session-row fallback", exc_info=True)
        return None
