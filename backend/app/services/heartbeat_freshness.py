"""story #2602(both-fix, PO 승인 2026-08-13) — SSE 루프의 `is_disconnected()` 의존을
독립 liveness 축(MCP heartbeat, `PATCH /team_members/{id}/heartbeat`)으로 보강한다.

prod 관측(08-13 18:37, 페드루 gcloud 실측): ①/agent/stream 429 재시도 폭풍 ②「Truncated
response」연속(SSE 비정상 사망을 서버가 못 앎) ③**429가 나는 동안 heartbeat는 200 흐름**
(슬롯 판정과 heartbeat 판정이 서로 다른 진실을 봄 — 이 모듈이 메꾸는 그 간극) ④offline
오노출(wipe-race 정황).

⛔**"신선함"이 아니라 "전진"을 본다**: SSE 연결 자체가 connect 시점에 이미 `last_seen_at`을
한 번 쓴다(agent_gateway.py 세션 등록 블록, AC2 플래그 무관) — 그래서 connect 직후 첫
tick(~30s 후)엔 그 최초 write가 아직 "신선"해 보인다. dial-out 에이전트(Hermes 등, MCP
heartbeat 미호출·agent_gateway.py 43-44행 주석 참조)는 그 최초 write 뒤로 last_seen_at이
**영영 안 바뀐다** — 단순 "신선한가"만 보면 dial-out 연결도 첫 tick엔 "신선"으로 오판해
무장(arm)되고, 몇 tick 뒤 그 최초 write가 자연히 낡으면 "무장된 채 stale"로 오판해 정상
연결의 lease refresh를 부당하게 skip한다(고치려는 사고와 반대 방향의 신규 회귀). 그래서
무장 조건은 "값이 이전 관측보다 **전진**했는가"다 — heartbeat가 실제로 반복 호출되는
연결만 전진이 관측되고, dial-out은 최초 write 이후 영원히 같은 값이라 전진이 단 한 번도
없다. **무장은 연결(커넥션) 단위**다 — agent 전역 과거 이력으로 무장하면 타입 전환·장기
유휴에서 오판 여지가 생긴다(페드루 판정 2026-08-13).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.member import AgentProjectProfile
from app.services import redis_shared

_DOMAIN = "heartbeat_freshness"


async def get_agent_last_heartbeat(db: AsyncSession, agent_id: uuid.UUID) -> datetime | None:
    """이 agent의 agent_project_profiles.last_seen_at 최댓값(멀티프로젝트 agent는 profile
    행이 여럿이나 sync_agent_profile_presence가 전부 동일값으로 UPDATE하므로 MAX로 충분).
    행이 없으면 None(신규/미온보딩 — arm 대상 아님, 호출부가 "전진 없음"과 동일하게 처리)."""
    return (await db.execute(
        select(func.max(AgentProjectProfile.last_seen_at)).where(
            AgentProjectProfile.member_id == agent_id
        )
    )).scalar_one_or_none()


class HeartbeatGateResult:
    """evaluate_advance()의 순수 판정 결과 — 부수효과(카운터 증가) 없이 다음 상태만."""

    __slots__ = ("armed", "should_skip_refresh", "last_observed", "newly_armed")

    def __init__(
        self, *, armed: bool, should_skip_refresh: bool,
        last_observed: datetime | None, newly_armed: bool,
    ) -> None:
        self.armed = armed
        self.should_skip_refresh = should_skip_refresh
        self.last_observed = last_observed
        self.newly_armed = newly_armed


def evaluate_advance(
    *, current: datetime | None, last_observed: datetime | None, armed: bool,
) -> HeartbeatGateResult:
    """agent_gateway.py의 presence tick이 매번 호출하는 순수 상태전이 — Redis/DB I/O가
    전혀 없어 이 파일 상단 docstring의 "전진 vs 신선함" 규칙을 부수효과 없이 직접 단위
    테스트한다(agent_gateway.py의 SSE 제너레이터 내부는 직접 호출 불가라 여기로 추출).

    ⚠️(페드루 리뷰 지적, 2026-08-13 — #3028 head 497eafbd7 시점) **첫 관측은 무장으로
    치지 않는다.** connect-time write(agent_gateway.py 세션 등록 블록)가 AC2 무관 보편적
    이라 — dial-out 연결도 last_seen_at이 「있다」(connect 시점 1회). last_observed=None을
    "전진"으로 취급하면 dial-out의 그 최초 값이 첫 tick에 무장을 트리거하고, 둘째 tick부터
    (다시는 안 바뀌므로) 곧장 skip 판정으로 떨어져 정상 dial-out 연결의 lease가 회수되는
    바로 그 역회귀가 재현된다. 그래서 last_observed가 **None이 아닐 때만** 전진을 인정한다
    — 첫 tick은 기록만 하고 무장 판단을 유보(비용: 무장까지 1 tick 지연, 안전측).

    - `last_observed is not None`이고 `current > last_observed`(진짜 전진) → 무장·refresh
      진행·last_observed 갱신.
    - 전진이 없고(current가 last_observed 이하, None, 또는 last_observed 자체가 아직
      None=첫 관측) 이미 armed → refresh skip(좀비 시그니처 — 전진하다 멈춘 경우만 해당,
      첫 관측은 위에서 armed=False로 시작하니 여기 안 옴).
    - 전진이 없고 아직 armed 아님(dial-out류·첫 heartbeat 전) → 현행대로 refresh 진행,
      무장하지 않음(회귀 없음) — last_observed는 기록해 다음 tick 비교 기준으로 삼는다."""
    if current is not None and last_observed is not None and current > last_observed:
        return HeartbeatGateResult(
            armed=True, should_skip_refresh=False,
            last_observed=current, newly_armed=not armed,
        )
    if armed:
        return HeartbeatGateResult(
            armed=True, should_skip_refresh=True, last_observed=last_observed, newly_armed=False,
        )
    return HeartbeatGateResult(
        armed=False, should_skip_refresh=False,
        last_observed=current if current is not None else last_observed, newly_armed=False,
    )


async def incr_armed_counter() -> None:
    """이 커넥션이 최초로 무장된 순간(전진 최초 관측) 1회 — prod에서 heartbeat-사용 fleet
    비중을 관측(dial-out 제외가 실제로 걸리는지 확認, PO 조건). off/Redis 다운 → no-op."""
    async def _op(client) -> None:
        await client.incr(redis_shared.key(_DOMAIN, "armed_total"))
    await redis_shared.with_fallback(_op, lambda: None)


async def incr_refresh_skip_counter() -> None:
    """무장된 연결이 stale(전진 정지)로 전환돼 lease refresh를 skip한 순간마다 1회 — Fix①."""
    async def _op(client) -> None:
        await client.incr(redis_shared.key(_DOMAIN, "refresh_skip_total"))
    await redis_shared.with_fallback(_op, lambda: None)


async def incr_wipe_suppressed_counter() -> None:
    """`_mark_agent_disconnected`가 내 baseline보다 새 신호(heartbeat 또는 새 연결의 connect
    write)를 보고 오프라인 강등을 skip한 순간마다 1회 — Fix②. prod에서 이 카운터가 실제로
    오르는지가 ④(wipe-race 정황)의 원인이 ⓐ(이 클래스)인지 아니면 다른 ⓑ인지를 가른다."""
    async def _op(client) -> None:
        await client.incr(redis_shared.key(_DOMAIN, "wipe_suppressed_total"))
    await redis_shared.with_fallback(_op, lambda: None)


async def get_counters() -> dict[str, int | None]:
    """관측용 — QA/운영 조회. 값이 None인 항목은 Redis 불가(집계 무의미, 별도 처리 불필요
    — 카운터 자체가 fail-open no-op이라 상승이 없을 뿐 오차가 안 남)."""
    client = redis_shared.get_client()
    if client is None:
        return {"armed_total": None, "refresh_skip_total": None, "wipe_suppressed_total": None}

    async def _op(c) -> dict[str, int | None]:
        keys = ["armed_total", "refresh_skip_total", "wipe_suppressed_total"]
        vals = await c.mget([redis_shared.key(_DOMAIN, k) for k in keys])
        return {k: (int(v) if v is not None else 0) for k, v in zip(keys, vals)}

    return await redis_shared.with_fallback(
        _op, lambda: {"armed_total": None, "refresh_skip_total": None, "wipe_suppressed_total": None},
    )
