"""story #3173(결제②-B) — AU(automation_units) 계측 기록 + ASGI 미들웨어.

doc `pricing-policy-proposal-v1` §4.5: AU는 **MCP/API(에이전트) 트래픽만** 잰다 — 사람이
웹 UI에서 수행한 작업은 0(좌석이 이미 받음). 판별자는
`app.dependencies.auth.is_au_billable_agent()`(SSOT) — 이 모듈은 그 판별 결과
(`request.state.au_actor`/`au_org_id`, auth dependency가 심음)를 읽기만 한다.

⛔한도 «집행»(차단/경고)은 이 스토리 범위 밖 — 여기는 usage_meters에 값을 쌓는 계측
축만 담당한다(story #d43ea270 선례: 한도값은 어드민 가변 데이터, 이 모듈은 손 안 댐).

story #3176 선행조건 ①+②(설계 doc `au-metering-phase2-prereq-3176`, 페드루 PO 승인
2026-08-28)로 아래 두 축소를 보완했다:
  - 쓰기: `payload-배치`(요청 바디가 `items: list[...]`를 명시 — `PATCH /goals/bulk`·
    `PATCH /stories/bulk` 2곳뿐, doc §1)가 `X-Affected-Entities: N`을 실제로 보낸다(N=
    서버가 실처리한 대상 수). `효과-배치`(단일 WHERE절 `.update()`로 N행에 부수효과 —
    `mark_all_read`류)는 헤더를 **의도적으로** 안 보낸다 — flat 5AU 유지가 판정(과금
    취지: "읽음 전체 표시"는 단일 논리 행동이라 5×N을 물리면 사용자 의도와 어긋난다).
  - 읽기: `X-Result-Count: N` 옵트인 헤더(doc §2, 4개 엔드포인트 배선 — `GET /docs`·
    `GET /stories`·`GET /conversations/{id}/messages`·`GET /events/pending`)를 읽어
    `1 + floor(max(0, N-100)/100)` AU로 계상. 헤더 없는 엔드포인트는 여전히 flat 1AU
    (옵트인 미배선=과소계상 방향, 틀린 방향 아님).

⚠️Phase 1에서 남은 알려진 축소(§4.5 원문과의 편차, doc §3에서 재평가 완료 — 지금 안
짓는 게 맞다는 판정):
  - 성공 응답이 클라이언트에 못 닿고(네트워크 유실) 재시도되는 경우 멱등키 부재로 진짜
    이중계상 가능(Toss `orderId`류 대응물 없음) — v2.1 §11.1 "자동 초과 청구 없음"이
    블라스트 반경을 이미 막아줘 Phase 2로 유지(재오픈 신호: 운영 로그에 동일 org·동일
    weight가 단시간 내 중복 기록되는 패턴이 관측되면 그때).
"""
from __future__ import annotations

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
from app.services.pg_pubsub import fire_and_forget

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


def _result_count(response: Response) -> int | None:
    """§4.5 읽기 100개 초과 옵트인 — 배선된 엔드포인트가 `X-Result-Count` 응답 헤더로 명시한
    실제 반환 건수. 헤더 없거나 파싱 불가면 None(호출부가 flat 1AU로 폴백 — 과소계상 방향)."""
    raw = response.headers.get("X-Result-Count")
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        return None
    return n if n >= 0 else None


def _au_weight_for(method: str, response: Response) -> int:
    if method in _WRITE_METHODS:
        return AU_WEIGHTS["write"] * _affected_entities(response)
    if method in _READ_METHODS:
        n = _result_count(response)
        if n is None:
            return AU_WEIGHTS["read"]
        # §4.5 "100개마다 +1" — floor((N-100)/100), ceiling 아님. 밴드(test_3176_au_weight_
        # read_formula.py 뮤테이션 검증 완료): N∈[0,199]→1AU(기본, 100 넘겨도 199까지는 «완전한
        # 추가 100블록»이 아직 안 채워짐) · N∈[200,299]→2AU(+1) · N∈[300,399]→3AU(+2, 여기서부터
        # +2 — 251이 아니라 300). ⚠️페드루 PO 정정(2026-08-28, PR#3584 리뷰): 이전 주석이
        # "N=101~200→+1(2AU)"·"251개째부터 +2"로 잘못 적혀 있었다 — 결제 경로 주석이라 밴드
        # 오독이 후속 집행(#3176 본체) 구현자의 과금 경계 오류로 이어질 수 있어 정정.
        return AU_WEIGHTS["read"] + max(0, (n - 100) // 100)
    return 0


async def _record_au_usage_safe(org_id: uuid.UUID, delta: int) -> None:
    """`pg_pubsub.fire_and_forget()`로 던져지는 실제 DB 왕복 — 이 코루틴 자신이 예외를
    전부 삼켜야 한다(안 그러면 "Task exception was never retrieved" — 아무도 안 기다리는
    태스크의 예외는 로그 없이 사라지거나 인터프리터 경고로만 남는다)."""
    try:
        await record_au_usage(org_id, delta)
    except Exception:
        logger.error("AU metering failed org_id=%s delta=%s", org_id, delta, exc_info=True)


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
    쓰는 것」(`_record_au_usage_safe`, DB 왕복)을 분리해, 후자만 응답 반환 밖으로 던진다.

    ⛔재구현 정정(페드루 PO 자인, 2026-08-28, 카디르 QA 적발) — 위 분리 자체는 맞았으나
    최초 델타가 `asyncio.create_task` + 모듈 로컬 `set`을 직접 새로 짰다(리뷰 지시가 grep
    없이 "3줄" 처방을 준 것이 원인). 이 레포엔 이미 정확히 이 문제(fire-and-forget 태스크
    GC 조기수거)를 잡은 canonical 헬퍼 `pg_pubsub.fire_and_forget()`이 있고, 그 모듈의
    `drain_background_tasks()`가 main.py lifespan shutdown에 이미 배선돼 있다 — 로컬
    set을 따로 만들면 그 drain 대상에서 빠져 graceful shutdown 시 이미 닫힌 커넥션
    풀을 참조하는 위험을 새로 만든다(test_no_unreferenced_fire_and_forget.py가 적발).
    지금은 `fire_and_forget()`을 그대로 재사용 — 새 세트·새 drain 로직 0."""

    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        try:
            org_id, weight = self._plan_metering(request, response)
            if org_id is not None and weight > 0:
                fire_and_forget(_record_au_usage_safe(org_id, weight))
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
