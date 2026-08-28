"""story #3173(결제②-B) — AU(automation_units) 계측 기록 + ASGI 미들웨어.

doc `pricing-policy-proposal-v1` §4.5: AU는 **MCP/API(에이전트) 트래픽만** 잰다 — 사람이
웹 UI에서 수행한 작업은 0(좌석이 이미 받음). 판별자는
`app.dependencies.auth.is_au_billable_agent()`(SSOT) — 이 모듈은 그 판별 결과
(`request.state.au_actor`/`au_org_id`, auth dependency가 심음)를 읽기만 한다.

⛔한도 «집행»(차단/경고)은 이 스토리 범위 밖 — 여기는 usage_meters에 값을 쌓는 계측
축만 담당한다(story #d43ea270 선례: 한도값은 어드민 가변 데이터, 이 모듈은 손 안 댐).

⚠️Phase 1 알려진 축소(스펙 §4.5 원문과의 편차 — **한도 집행을 켜기 前 반드시 보완**,
story #3173 본문 "필수 보완" 조건 참고):
  - 쓰기는 항상 엔티티 1개(5 AU)로 계상한다. 진짜 배치 엔드포인트(다건 동시 변경)가
    응답 헤더 `X-Affected-Entities: N`을 명시하면 그 값을 쓴다 — 헤더 없으면 1(과소계상
    방향, 자동 초과 청구 없음 철학과 정합·과금 안전측). 지금 어떤 엔드포인트도 이
    헤더를 안 보낸다 — 배치 엔드포인트 전수 조사·헤더 배선은 후속.
  - 읽기의 "100개 초과 반환 시 100개마다 +1" 규칙은 Phase 1 미구현(항상 1 AU) — 같은
    이유(84개 라우터 파일이 응답 봉투가 제각각이라 범용 파싱 불가, 그라운딩 doc
    `au-metering-grounding-3173` §4 참고).
  - 성공 응답이 클라이언트에 못 닿고(네트워크 유실) 재시도되는 경우 멱등키 부재로 진짜
    이중계상 가능(Toss `orderId`류 대응물 없음) — Phase 2 idempotency-key 후속 필요.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import text
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from app.core.database import async_session_factory
from app.models.usage_meter import AU_WEIGHTS

logger = logging.getLogger(__name__)

# 스트리밍 응답(SSE) 정확 경로 — 코드베이스 전수 확認(2026-08-28, grep 0건 외 이 2곳뿐):
# GET /api/v2/events/stream(events.py)·GET /api/v2/agent/stream(agent_gateway.py). 각
# 라우터 파일의 다른 엔드포인트(POST /events 등)는 정상 AU 계측 대상이라 라우터 prefix
# 전체가 아니라 이 두 정확 경로만 denylist한다.
_STREAMING_PATHS = frozenset({"/api/v2/events/stream", "/api/v2/agent/stream"})

_READ_METHODS = frozenset({"GET", "HEAD"})
_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _current_month_period(now: datetime) -> tuple[datetime, datetime]:
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if start.month == 12:
        end = start.replace(year=start.year + 1, month=1)
    else:
        end = start.replace(month=start.month + 1)
    return start, end


async def record_au_usage(org_id: uuid.UUID, delta: int) -> None:
    """usage_meters(meter_type='automation_units')를 이번 달 기준 원자적으로 증분한다.

    행이 없으면 새로 만든다. 동시 요청이 같은 org의 같은 달 행을 놓고 경합할 수 있어
    (unique 제약이 usage_meters에 없음 — 신설은 이 스토리 범위 밖, 기존 컬럼만 씀)
    `pg_advisory_xact_lock`으로 org 단위 직렬화한다(check-then-insert TOCTOU를 SELECT
    FOR UPDATE로는 못 막는 클래스 — feedback_check_then_insert_toctou와 동형 처방).

    ⛔fire-and-forget 호출부(미들웨어)가 이 함수를 try/except로 감싸므로, 여기서 올라간
    예외는 절대 응답을 막지 않는다 — 대신 로그로 반드시 남긴다(호출부 책임 분리:
    이 함수는 실패 시 그냥 raise, 삼키지 않는다)."""
    if delta <= 0:
        return
    now = datetime.now(timezone.utc)
    period_start, period_end = _current_month_period(now)

    async with async_session_factory() as session:
        async with session.begin():
            await session.execute(
                text("SELECT pg_advisory_xact_lock(hashtext('au_metering:' || :org_id))"),
                {"org_id": str(org_id)},
            )
            updated = await session.execute(
                text(
                    "UPDATE usage_meters SET current_value = current_value + :delta, "
                    "updated_at = now() "
                    "WHERE org_id = :org_id AND meter_type = 'automation_units' "
                    "AND period_start = :period_start"
                ),
                {"org_id": org_id, "delta": delta, "period_start": period_start},
            )
            if updated.rowcount == 0:
                await session.execute(
                    text(
                        "INSERT INTO usage_meters "
                        "(id, org_id, meter_type, current_value, period_start, period_end) "
                        "VALUES (:id, :org_id, 'automation_units', :delta, :period_start, :period_end)"
                    ),
                    {
                        "id": uuid.uuid4(),
                        "org_id": org_id,
                        "delta": delta,
                        "period_start": period_start,
                        "period_end": period_end,
                    },
                )


def _affected_entities(response: Response) -> int:
    """§4.5 배치 옵트인 — 진짜 배치 엔드포인트가 `X-Affected-Entities` 응답 헤더로 명시한
    변경 엔티티 수. 헤더 없거나 파싱 불가면 안전측 기본값 1(과소계상 방향)."""
    raw = response.headers.get("X-Affected-Entities")
    if not raw:
        return 1
    try:
        n = int(raw)
    except ValueError:
        return 1
    return n if n > 0 else 1


def _au_weight_for(method: str, response: Response) -> int:
    if method in _WRITE_METHODS:
        return AU_WEIGHTS["write"] * _affected_entities(response)
    if method in _READ_METHODS:
        return AU_WEIGHTS["read"]
    return 0


async def _record_au_usage_safe(org_id: uuid.UUID, delta: int) -> None:
    """`asyncio.create_task`로 던져지는 실제 DB 왕복 — 이 코루틴 자신이 예외를 전부
    삼켜야 한다(안 그러면 "Task exception was never retrieved" — 아무도 안 기다리는
    태스크의 예외는 로그 없이 사라지거나 인터프리터 경고로만 남는다)."""
    try:
        await record_au_usage(org_id, delta)
    except Exception:
        logger.error("AU metering failed org_id=%s delta=%s", org_id, delta, exc_info=True)


# 페드루 PO 리뷰(PR#3579, 2026-08-28) — `asyncio.create_task()`의 반환값을 아무 데도 안
# 잡아두면 이벤트루프가 그 태스크를 약참조로만 들고 있어, 완료 前에 GC될 수 있다(파이썬
# 공식 문서 명시 경고 — ruff RUF006이 잡는 클래스). 이 경로에서 그게 터지면 로그 한 줄
# 없는 무흔적 유실이라 "조용한 실패 금지" 원칙에 정면으로 걸린다 — 표준 처방(강한 참조
# set + 완료 시 자기 자신을 discard)으로 막는다.
_background_tasks: set[asyncio.Task] = set()


def _spawn_background(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


class AUMeteringMiddleware(BaseHTTPMiddleware):
    """story #3173 — 응답 완료 후 에이전트 트래픽만 골라 AU를 usage_meters에 쌓는다.

    ⛔조건ⓐ(페드루 PO, 2026-08-28) — 계측 경로 전체가 fail-open이어야 한다: 이 미들웨어의
    어떤 예외도 원 요청/응답에 영향을 주면 안 된다. `call_next()` 자체의 예외는 그대로
    전파하되(그건 이 미들웨어의 책임이 아님), 계측 로직은 통째로 try/except로 감싸 로그만
    남기고 삼킨다.

    ⛔지연 편차 정정(페드루 PO, 2026-08-28, PR#3579 리뷰) — 최초 구현이 `_meter`(DB 왕복+
    advisory lock 포함)를 `dispatch()` 안에서 inline `await`해, 설계(§6 "fire-and-forget")와
    어긋나게 **모든 에이전트 요청**에 계측 DB 왕복을 응답 임계경로에 직렬로 얹고 있었다 —
    평시엔 무해하지만 같은 org 동시 버스트 시 advisory lock 직렬화가 꼬리 지연을 문다. 지금은
    「무엇을 셀지」(동기·순수 판단, `_plan_metering`/`_au_weight_for` — I/O 없음)와 「실제로
    쓰는 것」(`_record_au_usage_safe`, DB 왕복)을 분리해, 후자만 `_spawn_background()`
    (강한 참조 유지 — 아래 참고)로 응답 반환 밖으로 던진다 — 클라이언트는 계측을
    기다리지 않는다."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        try:
            org_id, weight = self._plan_metering(request, response)
            if org_id is not None and weight > 0:
                _spawn_background(_record_au_usage_safe(org_id, weight))
        except Exception:
            logger.error(
                "AU metering planning failed path=%s method=%s", request.url.path, request.method,
                exc_info=True,
            )
        return response

    def _plan_metering(self, request: Request, response: Response) -> tuple[uuid.UUID | None, int]:
        """순수 판단(I/O 없음) — 이 요청이 계측 대상인지·몇 AU인지만 정한다. 실제 쓰기는
        호출부가 별도 태스크로 던진다(위 클래스 docstring 참고)."""
        if request.url.path in _STREAMING_PATHS:
            return None, 0
        if response.status_code >= 400:
            return None, 0
        au_actor = getattr(request.state, "au_actor", None)
        if au_actor != "agent":
            return None, 0
        org_id_raw = getattr(request.state, "au_org_id", None)
        if not org_id_raw:
            return None, 0
        weight = _au_weight_for(request.method, response)
        if weight <= 0:
            return None, 0
        return uuid.UUID(str(org_id_raw)), weight
