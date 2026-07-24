"""#2158: DB row 없는 transient SSE push(B계열)의 재연결 갭 재생 버퍼.

배경(까심 2026-07-24 라이브 판정, 2회 독립 재현): 프론트 Cloud Run timeout=60이 만드는
정기 재연결 공백(실측 359~427ms)에 발행된 이벤트 중 — Event DB row가 있는 A계열(예:
conversation.message_created)은 재연결 시 backfill(events.py `generate()`의 pending/
recently-delivered 조회)로 살아난다. 그런데 conversation.read·presence·
conversation.working 등 `_push_to_agent()`를 **DB row 없이** 직접 호출하는 B계열은
`_agent_connections[member_id]`에 큐가 없는 순간(=재연결 공백) `pushed=False`로 조용히
버려진다 — 재시도도 DB 잔존도 없어 영구 유실이었다.

PO 확定 처방(2026-07-24): DB row를 새로 만들지 않는다(#2123으로 방금 비운 hot-path에 부하
재적재 + #2157 팬아웃 배수와 곱해짐) — 이미 백플레인으로 서 있는 Redis 위에 **짧은 TTL** 재생
버퍼를 둔다.

설계:
- 키 = 멤버별(ZSET, `sse_replay:{member_id}`) — push 전달 단위가 항상 member_id라 org별
  집계는 불필요한 간접일 뿐(체감 재생 대상은 항상 "그 멤버가 놓친 것").
- score = 발행 시각(epoch seconds, `time.time()`) — A계열이 이미 쓰는 `last_event_id→ref_ts`
  커서(#2143)와 같은 시간축을 공유해, 재연결 시 events.py가 계산한 `ref_ts`를 그대로
  cutoff로 재사용한다(신규 클라 계약 불필요 — 기존 Last-Event-ID/since_timestamp 그대로).
- TTL = 재연결 공백 실측(359~427ms)에 여유를 두되, #2408이 정한 재연결 backoff 상한
  20s(+jitter ±20%⇒최대 24s)를 한 사이클 넘게 커버해야 "재시도 한 번" 규모의 순단도 살아
  남는다 — SSE_TRANSIENT_REPLAY_TTL_SECONDS 기본 30(임의 아님, 위 상한+여유). 영속화가
  아니라 "재연결 갭 메우기"가 목적이라 그 이상 늘리지 않는다(길게 두면 사실상 2번째
  이벤트 로그가 되어 #2158이 피하려던 DB-row화와 같은 함정에 다른 저장소로 빠진다).
- MAXLEN 캡(기본 50, `_agent_connections` 큐 maxsize=200보다 훨씬 작게 — 이 버퍼는 "짧은
  갭"용이지 오프라인 큐가 아니다)으로 메모리 무한증가 방지. ⚠️presence처럼 org 멤버 수만큼
  개별화되는 이벤트(N=18, #2157)는 재연결이 몰리는 순간 이 cap을 채울 수 있다 — `record()`가
  실제 trim 발생 시 로그를 남긴다(오르테가군 PR 전 리뷰 ②: "버리는지 몰라선 안 된다" — 라이브
  실증에서 이 로그로 실측치를 남길 것).
- 이중배달 방지(구조로, 클라 dedup 비의존): DB event_id가 있는 A계열은 이 버퍼에 아예
  기록하지 않는다(`_push_to_agent`가 `payload.get("event_id")` 유무로 분기) — A/B가
  저장소 자체로 분리돼 있어 겹칠 수가 없다. B계열은 `_push_to_agent`가 발행 시점에 부여하는
  `_sse_transient_id`를 라이브 배달·재생 배달이 공유해(id: 필드로 노출) 클라 SeenIdsCache
  dedup이 실제로 작동할 수 있는 형태로 나간다(오르테가군 PR 전 리뷰 ① — "dedup을 쓰지
  말라"가 아니라 "dedup이 작동할 수 있게 내보내라").

⚠️**이 버퍼가 메우지 못하는 것(명시 — #2142에서 이런 각주 부재가 "유실 0"으로 잘못 승계된
전례가 있어 여기 못박는다)**: TTL_SECONDS(기본 30초)보다 오래 끊겨 있던 클라이언트(노트북
절전·백그라운드 탭 장시간 방치 등)의 B계열 이벤트는 복구되지 않는다 — 이 모듈은 "재연결
공백(수백 ms~수십 초)을 메우는" 용도지 오프라인 큐가 아니다. "재생 버퍼가 있으니 B계열
유실이 0"이라고 넘겨받지 말 것 — 경계는 TTL_SECONDS다.

fail-open(presence/lease와 동형 철학): flag off 또는 redis_url 미설정/다운 → record는
no-op, replay는 빈 리스트 — 기존 동작(유실)과 동일할 뿐 새 장애를 만들지 않는다.
"""
from __future__ import annotations

import json
import logging
import os
import time

from app.core.config import settings
from app.services import redis_shared

logger = logging.getLogger(__name__)

_DOMAIN = "sse_replay"

# 근거는 모듈 docstring 참조 — #2408 재연결 backoff 상한(20s)+jitter(±20%⇒최대 24s)를
# 한 사이클 여유 있게 넘기는 값. 실측 갭(359~427ms)보다 훨씬 크지만, "가끔 20초짜리 재시도가
# 한 번 껴도 살아남는다"까지가 목표(그 이상은 별도 영속화 문제 — 스코프 아님).
TTL_SECONDS: int = int(os.getenv("SSE_TRANSIENT_REPLAY_TTL_SECONDS", "30"))
_MAX_ENTRIES: int = int(os.getenv("SSE_TRANSIENT_REPLAY_MAX_ENTRIES", "50"))


def _enabled() -> bool:
    return bool(getattr(settings, "sse_transient_replay_enabled", False)) and bool(settings.redis_url)


def _key(member_id: str) -> str:
    return redis_shared.key(_DOMAIN, member_id)


async def record(member_id: str, payload: dict) -> None:
    """B계열 push 1건을 짧은 TTL ZSET에 기록 — 재연결 시 재생용.

    호출측(`_push_to_agent`) 계약: DB event_id가 있는 A계열은 애초에 호출하지 않는다
    (이 함수 자체는 그 구분을 모른다 — 단일 책임: "받은 걸 기록"만).
    ZSET member는 이 JSON 문자열 자체라 payload가 우연히 완전동일한 별개 이벤트(예: 동일
    unread_count의 연속 conversation.read)가 같은 member로 합쳐져(score만 갱신) 한 건으로
    사라질 수 있다 — `_n`(uuid4 hex) nonce를 얹어 문자열을 항상 유일하게 만든다(재생 시 제거).
    off/Redis 다운 → no-op(기존 동작과 동일, 새 실패 모드 0).
    """
    if not _enabled():
        return

    async def _op(client) -> None:
        import uuid as _uuid

        key = _key(member_id)
        now = time.time()
        member = json.dumps({"_n": _uuid.uuid4().hex, **payload}, default=str)
        pipe = client.pipeline()
        pipe.zadd(key, {member: now})
        # 최신 _MAX_ENTRIES건만 유지(랭크 0..-(_MAX_ENTRIES+1) 미만 구간 제거).
        pipe.zremrangebyrank(key, 0, -(_MAX_ENTRIES + 1))
        pipe.expire(key, TTL_SECONDS)
        results = await pipe.execute()
        # 오르테가군 PR 전 리뷰 ②: cap이 실제로 뭔가를 버리는지 "모르는 채로" 두지 않는다 —
        # zremrangebyrank 반환값(제거 건수) > 0이면 관측 가능하게 로그(라이브 실증에서 이
        # 로그 유무/빈도로 "안 넘친다"/"넘친다" 둘 다 근거를 남길 수 있게).
        trimmed = results[1] if len(results) > 1 else 0
        if trimmed:
            logger.info(
                "sse_transient_replay: cap 초과로 %d건 trim member_id=%s (MAX_ENTRIES=%d)",
                trimmed, member_id, _MAX_ENTRIES,
            )

    await redis_shared.with_fallback(_op, lambda: None)


async def replay(member_id: str, since: float | None) -> list[dict]:
    """`since`(epoch seconds, 배타적 하한) 이후 기록된 B계열 payload를 시간순으로 반환.

    `since=None`(커서 미해소 — 예: last_event_id가 이 버퍼 대상이라 DB에 없어 ref_ts를 못
    구한 초기/엣지 케이스)이면 TTL 윈도우 전체(now - TTL_SECONDS)로 하한을 잡는다 — 버퍼가
    짧아(기본 30s) 과다 재생 위험이 없다.
    off/Redis 다운 → 빈 리스트(기존 동작=유실과 동일, 재연결 자체를 막지 않는다).
    """
    if not _enabled():
        return []

    floor = since if since is not None else (time.time() - TTL_SECONDS)
    # ZRANGEBYSCORE의 하한을 배타적으로("(") — since 자체에 기록된 이벤트(이미 그 시점까지
    # 받은 것으로 간주되는 커서)를 다시 재생해 중복시키지 않는다.
    exclusive_floor = f"({floor}"

    async def _op(client) -> list[dict]:
        raw = await client.zrangebyscore(_key(member_id), exclusive_floor, "+inf")
        out: list[dict] = []
        for item in raw:
            try:
                parsed = json.loads(item)
            except (TypeError, ValueError):
                continue
            parsed.pop("_n", None)
            out.append(parsed)
        return out

    return await redis_shared.with_fallback(_op, lambda: [])
