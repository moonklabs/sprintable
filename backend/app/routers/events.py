"""이벤트 시스템 라우터.

C-S6: SSE 스트림 (메모 변경 이벤트 실시간 푸시)
E-EVENTBUS S1: events 테이블 CRUD (이벤트버스 기반)
E-EVENTBUS S2: MCP Streamable HTTP SSE 푸시 (에이전트 전용 — 단, `resolve_member_identity`가
grant-only human(OrgMember)도 해소하므로 이 스트림 자체는 human도 실제로 붙을 수 있다. #2380)
E-EVENTBUS S3: 이벤트 큐 + 오프라인 재전달 (at-least-once + 배치 + expired)

story #2380: `Event.status`와 `Event.read_at`은 별개 축이다 — `status`는 "배달됐는가"(pending
→delivered/expired), `read_at`은 "사람이 열람했는가"(event_notifications.py가 관리, status와
무관하게 갱신). 두 값을 섞어 읽지 않는다 — status=delivered·read_at=NULL은 정상(배달됐지만
아직 안 읽음)이지 결함이 아니다.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import (
    AuthContext,
    get_current_user,
    get_current_user_streaming,
    get_verified_org_id,
    get_verified_org_id_streaming,
)
from app.core import shutdown as _shutdown_module
from app.dependencies.database import get_db
from app.dependencies.ownership import _is_org_admin
from app.models.event import Event
from app.services.member_resolver import assert_caller_is_member, resolve_member_identity

router = APIRouter(prefix="/api/v2/events", tags=["events", "Organization"])
logger = logging.getLogger(__name__)

# ─── Agent connection registry (S2/S3: 에이전트별 SSE) ───────────────────────
# member_id (str) → set[Queue] — 다중 연결 지원, 해제 시 해당 queue만 제거
_agent_connections: dict[str, set[asyncio.Queue[dict]]] = defaultdict(set)

_SSE_BATCH_SIZE = 10  # 배치 전달 청크 크기

# ─── S20: SSE 연결 수 전역 제한 ───────────────────────────────────────────────
import os as _os
_MAX_SSE_CONNECTIONS: int = int(_os.getenv("MAX_SSE_CONNECTIONS", "100"))
_sse_connection_count: int = 0
_SSE_HEARTBEAT_TIMEOUT: float = float(_os.getenv("SSE_HEARTBEAT_TIMEOUT", "30"))

# story #2128(2026-07-24, critical) — wall-clock 수명 상한(v2 설계 ①본체). realtime-dev가
# 이 병으로 죽어 있었다: GCLB 뒤에서 클라 disconnect가 백엔드로 전파 안 되고(코드는 정상 —
# request.is_disconnected() 체크·finally discard 둘 다 있음), 연결이 Cloud Run 타임아웃
# (3600s)까지 자연 종료 없이 슬롯을 점유해 640슬롯(concurrency 80×maxInstances 8)이
# 누적 고갈됐다(관측: 200 SSE 슬롯 점유 중앙값 3601초). 처방 제1원리(오르테가군 판정) —
# 생명 판정 신호는 "판정 대상이 스스로 갱신할 수 없는 것"이어야 한다: heartbeat/ACK
# staleness는 신호가 없는 정상 idle 연결(브라우저 EventSource는 out-of-band 신호 자체가
# 0)을 오살하므로 "가속"으로만 쓰고, wall-clock 상한을 유일한 본체로 둔다. 좀비는 이 축을
# 스스로 늘릴 수 없다 — 정상 연결도 이 상한에 걸려 재연결되지만 #2101 backfill+Last-Event-ID
# 재개로 데이터 손실 0.
#
# N=90s 근거(2026-07-25 정정 — 최초 판단 600s의 전제가 라이브 관측으로 무너짐):
# · 최초(600s) 근거는 "#2183 고쳐지면 프론트 60s 컷이 먼저 걸려 600s는 거의 발동 안 하는
#   백스톱"이었다. 그런데 #2183(+후속 #2488 wall-clock 캡)이 착지한 後 실측(2026-07-25):
#   upstream 점유시간이 617~659초로 나왔다 — 이게 바로 **이 600s+jitter 캡이 지금 상시
#   발동 중**이라는 증거다. #2488 자체는 40%만 걸린다(미르코 관측: 같은 탭에서 58.5s/
#   63.4s 두 무리가 섞여 나옴 — 요청 단위로 새는 경로가 남아있다는 뜻). 즉 "healthy는
#   거의 안 걸린다"는 전제가 거짓이었고, 실제로는 "프론트 자신의 수명보다 조금 큰 값"
#   이어야 맞는 자리였다.
# · 프론트 Cloud Run timeoutSeconds=60은 dev·prod 공통(cloudbuild.yaml `_FRONTEND_TIMEOUT`
#   단일값·분기별 override 없음 — 2026-07-22 라이브 실측이 코드에 durable화돼 있고, 오르테가군이
#   2026-07-25 gcloud로 재확認: sprintable-frontend-dev/prod 둘 다 60). 이 컨테이너를 거치는
#   요청은 healthy든 아니든 60s를 못 넘긴다 — 90s(60s+30s 여유)를 넘겨 사는 upstream은
#   정의상 "프론트 요청은 죽었는데 upstream만 산" 상태, 즉 이 스토리가 자르려는 그 좀비다.
# · 재연결 부하 증가 0 — 브라우저는 이미 60s마다 자연 재연결하므로, 90s 캡은 "프론트가
#   이미 버린 연결"에만 걸린다. healthy 연결의 재연결 주기는 안 바뀐다.
# · 까심군 AC6 측정(2026-07-25): 클라를 명시적으로 kill한 뒤 36초(3s×12회) 폴링해도
#   `request.is_disconnected()`가 미검출(전부 online) — heartbeat 30s 경계를 넘겨도 감지가
#   안 된다는 뜻이라, presence 수렴이 이 캡값 하나에 통째로 묶여 있다(감지가 안 되니
#   스트림은 캡까지 안 죽고, presence는 스트림이 죽어야 내려간다). 캡을 내리면 그 수렴
#   상한도 동일하게 내려가 사용자 체감이 실제로 달라진다 — "안 새게 막았다"를 넘어
#   "새는 동안의 피해가 줄었다"는 근거가 이번엔 붙는다.
# · 에이전트 경로(1800s)는 안 건드린다 — 프론트를 안 거치므로 이 전제 자체가 무관하다.
#
# 무너지는 조건(pinning 테스트 — tests/test_2128_sse_lifespan_cap.py 참조): "healthy 브라우저
# upstream이 90s를 넘겨야 하는 정당한 경로가 실제로 관측되면"(예: 프론트 timeoutSeconds가
# 60이 아닌 환경이 생기면, 또는 프론트를 거치지 않는 새 브라우저 연결 경로가 생기면) 이
# 값을 재검토해야 한다 — 지금은 그런 경로 없음(프론트 경유가 유일한 브라우저 진입점).
#
# 배포 env가 아니라 코드 상수 — #2161 AGENT_RUN_TIMEOUT_HOURS와 동형(값이 두 곳에 살면
# 오늘 하루 종일 데인 그 모양이 된다는 오르테가군 지적).
_SSE_LIFESPAN_SEC: float = 90.0
_SSE_LIFESPAN_JITTER_SEC: float = 15.0  # herd 방지(#2095 지터와 동일 목적) — base가 600→90로
# 줄어든 만큼 비례 축소(기존 60s 지터를 그대로 두면 90s 기준 최대 +67% 변동이라 과도).

# ─── S6-1: Backfill 볼륨 제어 ─────────────────────────────────────────────────
_BACKFILL_THRESHOLD_SECONDS: int = int(_os.getenv("BACKFILL_THRESHOLD_SECONDS", "300"))
_BACKFILL_MAX_EVENTS: int = int(_os.getenv("BACKFILL_MAX_EVENTS", "50"))
# S0-1: 초기 연결(last_event_id=None) 시 backfill 상한 — 재연결과 구분하여 중복 방지
_BACKFILL_INITIAL_EVENTS: int = int(_os.getenv("BACKFILL_INITIAL_EVENTS", "5"))

# story #2101(2026-07-22, 까심군 raw curl 재현 확認): 같은 member의 동시 연결(다중 탭)이
# 있으면 delivered가 Event 행 하나에 전역 플래그라 — 탭A가 먼저 받아 delivered로 마킹하면
# 탭B가 재연결 시 status=="pending"만 보는 백필에서 그 이벤트가 영구 제외된다(탭B 자신은
# 못 받았는데도). `/pending`(get_pending_events, include_recent_delivered_minutes)이 이미
# 같은 문제를 "최근 delivered도 포함"으로 풀어놨는데 SSE 스트림 자체의 백필엔 그 처리가
# 없었다 — 동형으로 맞춘다("최소 한 번 배달 + 수신측 dedup"이 분산시스템 표준, "정확히
# 한 번"을 위한 connection/session 단위 추적은 스키마 변경급이라 이번 스코프 아님).
# 값 근거(임의 아님): `apps/web/src/hooks/use-chat-sse.ts`의 RECONNECT_DELAYS_MS =
# [5,30,60,300]초가 4번째 실패부터 300초에서 plateau(더 안 늘어남, 무한 재시도) — 즉
# 클라가 아무리 여러 번 실패해도 "다음 재시도까지의 간격"은 300초를 절대 안 넘는다.
# N을 이보다 작게 잡으면 백오프가 plateau에 도달한 뒤 다시 갭이 재발하는 구조적 하한이라,
# 300초는 절충이 아니라 이 재연결 루프가 보장하는 정확한 경계값이다.
_BACKFILL_RECENT_DELIVERED_SECONDS: int = int(
    _os.getenv("BACKFILL_RECENT_DELIVERED_SECONDS", "300")
)


def _pending_or_recently_delivered_filter(now: "datetime"):
    """story #2101 — 백필 status 필터: pending 전량 + 최근 N초 이내 delivered.

    `/pending`(get_pending_events)의 include_recent_delivered_minutes와 동형 —
    같은 member의 다른 연결이 먼저 받아 delivered로 마킹한 이벤트도 재연결한 이
    연결이 다시 받게 한다(영구 유실 방지, 중복은 클라 dedup이 처리)."""
    cutoff = now - timedelta(seconds=_BACKFILL_RECENT_DELIVERED_SECONDS)
    return or_(
        Event.status == "pending",
        and_(Event.status == "delivered", Event.delivered_at >= cutoff),
    )


def _compute_backfill_mode(
    ref_ts: "datetime | None",
    now: "datetime",
    initial: bool = False,
) -> tuple[bool, int]:
    """(exceed_threshold, limit) — threshold 초과 여부와 사용할 LIMIT 반환.

    exceed_threshold=True  → DESC 최신 N건 조회
    exceed_threshold=False → ASC 전량 조회 (max 100)
    initial=True: last_event_id=None 초기 연결 — BACKFILL_INITIAL_EVENTS 상한 적용
    """
    if ref_ts is None:
        limit = _BACKFILL_INITIAL_EVENTS if initial else _BACKFILL_MAX_EVENTS
        return True, limit
    _ref = ref_ts if ref_ts.tzinfo else ref_ts.replace(tzinfo=timezone.utc)
    exceed = (now - _ref) > timedelta(seconds=_BACKFILL_THRESHOLD_SECONDS)
    return exceed, (_BACKFILL_MAX_EVENTS if exceed else 100)


def _push_to_agent(member_id: str, payload: dict, _from_listener: bool = False) -> bool:
    """연결 중인 에이전트 모든 큐에 SSE 페이로드 전송. True=1개 이상 전달, False=미연결.

    _from_listener=True: LISTEN 수신기에서 호출 시 pg_notify 재발행 금지 (무한 루프 차단).
    """
    is_db_backed = bool(payload.get("event_id"))
    # #2158 리뷰 반영(오르테가군 ①, 2026-07-24 — PR 전 지적): DB event_id가 없는 B계열은
    # 발행 시점에 안정적 id를 **한 번만** 부여한다. 이전엔 generate()의 라이브 루프가 yield
    # 시점마다 `uuid.uuid4()`를 새로 만들었는데(eid=None이라), 같은 논리적 이벤트가 배달
    # 경로(라이브 vs 재생, 또는 다중 탭)마다 다른 id를 얻어 클라 SeenIdsCache dedup이
    # 구조적으로 무력했다 — "같은 걸 다시 받아도 다른 id라 못 잡는" 상태. 여기서 한 번
    # 정해두면 라이브 전달·Redis 재생 버퍼·다중 탭이 전부 같은 id를 쓴다.
    # 필드명이 `event_id`가 아니라 `_sse_transient_id`인 이유: 이 값이 `event_id`였다면
    # 아래 generate() 라이브 루프의 "eid 있으면 DB Event.status 조회" 분기가 이 가짜
    # id로도 매 배달마다 DB를 때려(존재하지 않는 id라 매번 miss) AC3(hot-path DB 0)를
    # 스스로 깬다 — A/B 판별 신호(`event_id`)와 상관관계 신호(id: 필드)를 분리한다.
    # `_from_listener=True`(크로스인스턴스 리스너 콜백) 경로는 원발행 인스턴스가 이미 실어
    # 보낸 값을 그대로 쓴다(`"_sse_transient_id" not in payload`) — 재할당하면 인스턴스마다
    # 다른 id가 생겨 위 목적이 무효화된다.
    if not is_db_backed and "_sse_transient_id" not in payload:
        payload = {**payload, "_sse_transient_id": str(uuid.uuid4())}
    queues = _agent_connections.get(member_id)
    pushed = False
    if queues:
        dead: list[asyncio.Queue] = []
        for q in list(queues):
            try:
                q.put_nowait(payload)
                pushed = True
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            queues.discard(q)
    if not _from_listener:
        # prod 커넥션 누수 근본fix(2026-07-08) — 참조 미보관 create_task는 GC가 pg_notify()의
        # async with async_session_factory() 도중 태스크를 조기수거할 수 있다(공식 문서 경고) —
        # fire_and_forget이 강한 참조를 보관해 이를 막는다.
        # E-ARCH S2(story #2078): pg_notify() 직접 호출 → event_broker.publish()로 — PG NOTIFY는
        # 그대로(내부에서 동일 호출) + event_broker_redis_dual_publish_enabled 시 Redis shadow
        # 추가 발행(기본 off, 무회귀).
        from app.services.event_broker import event_broker
        from app.services.pg_pubsub import fire_and_forget
        fire_and_forget(event_broker.publish("agent", member_id, payload.get("event_type", ""), payload))
        # #2158: DB event_id가 없는 B계열(transient push — conversation.read·presence·
        # conversation.working 등)만 재생 버퍼에 기록한다. A계열(event_id 有)은 DB backfill이
        # 이미 커버하므로 여기서도 기록하면 재연결 시 이중배달(구조적으로 막아야 하는 것,
        # AC2). `not _from_listener` 가드와 같은 자리에 둔 이유: 멀티인스턴스에서 원발행
        # 인스턴스 1곳에서만 1회 기록해야(리스너 콜백마다 기록하면 인스턴스 수만큼 중복
        # 기록) — event_broker.publish 호출과 동일하게 "원발행 1회"에만 태운다.
        if not is_db_backed:
            from app.services import sse_transient_replay
            fire_and_forget(sse_transient_replay.record(member_id, payload))
    return pushed


async def push_to_org_members(
    org_id: str, event_type: str, data: dict, *, member_ids: set[str] | None = None,
) -> None:
    """story #2139/#2132 근본수정 — 예전 `publish_event()`의 org-level fanout은 아무도
    구독하지 않는 영구 죽은 레지스트리였다(_subscribers.add() 호출처 저장소 전체 0곳,
    story #2059/#2067/#2132 실측). 실제 브라우저/에이전트 배달 경로는 `_push_to_agent()`
    (`_agent_connections[member_id]`)뿐이라, org 단위 발행도 결국 이 경로로 개별 push해야
    실제로 도달한다.

    `member_ids` 미지정(None) 시 org 전체 활성 멤버(human+agent 전부)에게 보낸다 — presence
    전용(#2139 §3, 오르테가 확定: project로 좁히지 않는다. 호출부 4곳이 애초에 project_id를 안
    들고 있고, 에이전트는 multi-project·DM은 project 자체가 없어 데이터가 org 단위다).
    `member_ids` 지정 시 그 집합에게만 — conversation.working 전용(참가자만, org 전체 아님 —
    payload가 conversation 단위라 org로 보내면 새는 것).

    ⚠️story #2139(2026-07-23) 정정(오르테가 검수 재지적) — 이전엔 `org_members`만 SELECT했다.
    그 테이블은 `user_id NOT NULL`(휴먼 전용 — 에이전트는 애초에 행이 없다) → presence가
    에이전트에게 전혀 도달하지 않는 채로 "org 전체"라 주장하던 선언-실제 불일치였다(라이브
    실측: 자기 자신의 agent stream에 presence 0건 도착으로 확認). `members` 테이블(org_id·
    type·is_active·deleted_at 보유, human+agent 단일 신원)로 바꾸되 `org_members`와 UNION —
    `project_members_sync_gap`(org-create/invite-accept가 `org_members`만 INSERT하고
    `members` 앵커 행을 동반 생성 안 하는 알려진 갭)으로 `members`에 아직 없는 신규/미백필
    휴먼 org_member가 존재할 수 있어, `members`만으로 바꾸면 그 스트래글러가 새로 빠진다
    (project_accessible_member_ids가 `team_members UNION org_members`로 같은 갭을 방어하는
    것과 동형 패턴). 휴먼은 `members.id == org_members.id`(E-MEMBER-SSOT 앵커)라 UNION해도
    중복 id 하나로 합쳐질 뿐 이중 push 없음.

    best-effort — caller가 감싼 try/except 전제(presence_events.py 관례)로 자체 예외 전파.
    자기 세션을 열고 닫아(member_ids=None일 때만) caller의 세션 상태와 무관하게 동작."""
    ids = member_ids
    if ids is None:
        from sqlalchemy import text as _text

        from app.core.database import async_session_factory
        async with async_session_factory() as session:
            rows = await session.execute(
                _text(
                    """
                    SELECT id FROM members
                    WHERE org_id = :org_id AND is_active = true AND deleted_at IS NULL
                    UNION
                    SELECT id FROM org_members
                    WHERE org_id = :org_id AND deleted_at IS NULL
                    """
                ),
                {"org_id": org_id},
            )
            ids = {str(r[0]) for r in rows.all()}
    for mid in ids:
        _push_to_agent(mid, {"event_type": event_type, **data})


def _event_to_payload(event: "Event") -> dict:
    return {
        "event_id": str(event.id),
        "event_type": event.event_type,
        "source": {"type": event.source_entity_type, "id": str(event.source_entity_id) if event.source_entity_id else None},
        "sender_id": str(event.sender_id) if event.sender_id else None,
        "payload": event.payload,
        # E-EVENT-INJECT S1: content를 SSE top-level로 노출(conversation.message_created 미러).
        # connector가 top-level content를 읽어 드롭 안 걸리게.
        "content": (event.payload or {}).get("content"),
        "created_at": event.created_at.isoformat(),
    }


# ─── SSE endpoint ─────────────────────────────────────────────────────────────



# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class CreateEventRequest(BaseModel):
    project_id: uuid.UUID
    event_type: str
    source_entity_type: str | None = None
    source_entity_id: uuid.UUID | None = None
    sender_id: uuid.UUID | None = None
    recipient_id: uuid.UUID
    recipient_type: str
    payload: dict = {}


class EventResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    org_id: uuid.UUID
    event_type: str
    source_entity_type: str | None
    source_entity_id: uuid.UUID | None
    sender_id: uuid.UUID | None
    recipient_id: uuid.UUID
    recipient_type: str
    payload: dict
    status: str
    created_at: datetime
    delivered_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


# ─── Agent SSE stream (S2) ────────────────────────────────────────────────────

@router.get("/stream")
async def agent_event_stream(
    request: Request,
    member_id: uuid.UUID | None = Query(default=None),  # AC2: API key 시 자동 추출, JWT 시 필수
    auth: AuthContext = Depends(get_current_user_streaming),  # AC1: Bearer {API_KEY} 또는 JWT — 없으면 401 (AC3). P0(#abaf6279): SSE 커넥션 비점유 변형
    org_id: uuid.UUID = Depends(get_verified_org_id_streaming),
    since_timestamp: datetime | None = Query(default=None),
    last_event_id: uuid.UUID | None = Query(default=None),
):
    """GET /api/v2/events/stream — SSE 스트림.

    story #2391(2026-08-01) — "에이전트 전용"은 사실이 아니었다. 아래 `resolve_member_identity`
    호출이 TeamMember(에이전트+레거시 휴먼) 다음으로 OrgMember(grant-only 휴먼)도 해소하므로,
    이 스트림은 설계상 human도 실제로 붙는다(E-MEMBER-SSOT Phase 0 — team_member 강요를
    의도적으로 없앤 것이지 사고가 아니다, `resolve_member_identity` 자신의 docstring 참조).
    모듈 최상단 docstring(#2380)은 이미 이 사실을 적어 뒀었는데 이 함수 자신의 docstring만
    안 따라왔었다.

    인증: Authorization: Bearer {API_KEY} 또는 JWT.
    API Key 사용 시 member_id 자동 추출 — 쿼리 파라미터 불필요.
    JWT 사용 시 member_id 쿼리 파라미터 필수.

    이벤트:
    - heartbeat: 30초마다 연결 유지
    - <event_type>: 이벤트버스 이벤트 실시간 수신
    """
    from app.core.database import async_session_factory

    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))

    # AC2: API key → member_id 자동 추출 (auth.user_id = team_member.id)
    if is_api_key:
        resolved_member_id = uuid.UUID(auth.user_id)
        # query param이 명시된 경우 일치 여부 검증 — AC4
        if member_id is not None and member_id != resolved_member_id:
            raise HTTPException(status_code=403, detail="API key can only subscribe to its own stream")
    else:
        if member_id is None:
            raise HTTPException(status_code=400, detail="member_id query parameter required")
        resolved_member_id = member_id

    # member_id가 org 소속인지 검증 + AC4: JWT 경로에서 타인 stream 접근 차단
    # E-MEMBER-SSOT Phase 0: team_member 강요 제거 — grant-only 휴먼(org_member)도 구독 허용
    async with async_session_factory() as db:
        member_row = await resolve_member_identity(resolved_member_id, org_id, db)
        if member_row is None:
            raise HTTPException(status_code=404, detail="Member not found")

        # AC4: JWT 사용자는 자신의 신원(user_id 일치)에만 구독 허용
        if not is_api_key:
            if member_row.user_id is None or str(member_row.user_id) != auth.user_id:
                raise HTTPException(status_code=403, detail="Cannot subscribe to another member's stream")

    # AC1(S-COMM-05): Last-Event-ID 헤더 우선, 쿼리 파라미터 fallback (RFC 8895)
    _header_last_id = request.headers.get("Last-Event-ID") or request.headers.get("last-event-id")
    if _header_last_id and last_event_id is None:
        try:
            last_event_id = uuid.UUID(_header_last_id)
        except (ValueError, AttributeError):
            pass

    # S20/#2121: 전역 연결 수 제한 — 503. Redis lease(공유·TTL 자가회수)가 주경로·Redis 불가 시 in-process 폴백.
    global _sse_connection_count
    _lease_conn_id = str(uuid.uuid4())
    from app.services import sse_lease
    _lease = await sse_lease.acquire("events_global", _MAX_SSE_CONNECTIONS, _lease_conn_id)
    if _lease is False:  # Redis lease: 전역 한계 초과
        raise HTTPException(status_code=503, detail="SSE connection limit reached")
    if _lease is None and _sse_connection_count >= _MAX_SSE_CONNECTIONS:  # Redis 불가 → in-process 폴백
        raise HTTPException(status_code=503, detail="SSE connection limit reached")
    _sse_connection_count += 1  # in-process shadow(Redis 다운 시 폴백용 유지)

    member_id_str = str(resolved_member_id)
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)
    _agent_connections[member_id_str].add(queue)

    # story #2128: 연결 시작 시점에 이미 종료 예정 시각을 갖고 태어난다(#2161과 동일 원리 —
    # "시작할 때 이미 끝날 시각을 갖고 태어나게"). monotonic — 벽시계 조정에 영향 안 받음.
    _lifespan_deadline = time.monotonic() + _SSE_LIFESPAN_SEC + random.uniform(0, _SSE_LIFESPAN_JITTER_SEC)

    async def generate():
        try:
            # 즉시 heartbeat → HTTP 응답 헤더 즉시 반환 (대량 백필 전 hang 방지)
            yield "event: heartbeat\ndata: {}\n\n"

            # S6-1: pending 이벤트 백필 — threshold 기반 볼륨 제어
            async with async_session_factory() as db:
                now = datetime.now(timezone.utc)

                # 기준 시각 결정: last_event_id > since_timestamp > None 우선순위
                ref_ts: datetime | None = since_timestamp
                if last_event_id is not None:
                    ts_row = await db.execute(
                        select(Event.created_at).where(Event.id == last_event_id)
                    )
                    ts = ts_row.scalar_one_or_none()
                    if ts is not None:
                        ref_ts = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)

                _ref = ref_ts if ref_ts is None or ref_ts.tzinfo else ref_ts.replace(tzinfo=timezone.utc)
                # S0-1: 초기 연결(last_event_id=None, since_timestamp=None)은 INITIAL 상한 적용
                is_initial = last_event_id is None and since_timestamp is None
                exceed, limit = _compute_backfill_mode(_ref, now, initial=is_initial)
                # story #2201: 강등 «사실»만이 아니라 «이유»를 클라이언트에 싣는다 — 지금까지는
                # 캡에 걸려 과거를 못 채워도(exceed=True) 아무 신호 없이 정상 응답처럼 돌아갔다.
                # ⛔_compute_backfill_mode의 시그니처·반환값(exceed, limit)은 손대지 않는다(동작
                # 불변 — 50/100/5 캡은 그대로) · reason만 호출부에서 옆에 붙인다(이 세 값 각각을
                # 판별할 정보는 이미 위에서 계산돼 있다: is_initial · _ref(None이면 커서를
                # 보냈어도 못 찾은 것 · since_timestamp 폴백도 없었던 것) · exceed).
                if is_initial:
                    _backfill_reason: str | None = "no_cursor"
                elif _ref is None:
                    _backfill_reason = "cursor_not_found"
                elif exceed:
                    _backfill_reason = "cursor_stale"
                else:
                    _backfill_reason = None
                # done-gate(story #2201): "코드 넣었다"로 안 닫는다 — 이 로그가 gcloud logging
                # read로 실제로 잡히는 것까지 확認해야 완료다. no_cursor(진짜 최초접속)는 정상
                # 트래픽이라 제외 — 재연결인데 못 따라잡은 두 경우(cursor_not_found·cursor_stale)
                # 만 센다(강등 «빈도»가 이 신호의 목적이지 최초접속 빈도가 아니다).
                if _backfill_reason in ("cursor_not_found", "cursor_stale"):
                    import logging
                    logging.getLogger(__name__).info(
                        "sse.backfill_degraded reason=%s org_id=%s member_id=%s",
                        _backfill_reason, org_id, resolved_member_id,
                    )
                # story #2101: pending뿐 아니라 최근 delivered도 포함 — 동일 member의
                # 다른 연결(탭)이 먼저 받아 delivered로 마킹한 이벤트를, 재연결한 이 연결도
                # 다시 받게 한다(중복은 클라 dedup이 처리, 영구 유실 0이 목표).
                _status_filter = _pending_or_recently_delivered_filter(now)
                if exceed:
                    # threshold 초과: _ref 이후 최근 N건만 (최신순 → 역순 전달로 시간 순서 보존)
                    exceed_clauses: list[Any] = [
                        Event.org_id == org_id,
                        Event.recipient_id == resolved_member_id,
                        _status_filter,
                    ]
                    if _ref is not None:
                        if last_event_id is not None:
                            exceed_clauses.append(
                                or_(
                                    Event.created_at > _ref,
                                    and_(Event.created_at == _ref, Event.id > last_event_id),
                                )
                            )
                        else:
                            exceed_clauses.append(Event.created_at > _ref)
                    result = await db.execute(
                        select(Event)
                        .where(*exceed_clauses)
                        .order_by(Event.created_at.desc())
                        .limit(limit)
                    )
                    pending_events = list(reversed(result.scalars().all()))
                else:
                    # threshold 이내: ref_ts 이후 전량 (최대 100건)
                    where_clauses: list[Any] = [
                        Event.org_id == org_id,
                        Event.recipient_id == resolved_member_id,
                        _status_filter,
                    ]
                    if _ref is not None:
                        if last_event_id is not None:
                            # 복합 커서: 동일 타임스탬프 이벤트 누락 방지
                            where_clauses.append(
                                or_(
                                    Event.created_at > _ref,
                                    and_(Event.created_at == _ref, Event.id > last_event_id),
                                )
                            )
                        else:
                            where_clauses.append(Event.created_at > _ref)
                    result = await db.execute(
                        select(Event)
                        .where(*where_clauses)
                        .order_by(Event.created_at.asc())
                        .limit(100)
                    )
                    pending_events = result.scalars().all()

                # story #2201: heartbeat 다음, backfill 이벤트 스트리밍 시작 前에 전용 이벤트
                # 타입으로 보낸다 — 응답 헤더/heartbeat 메타에는 못 싣는다(heartbeat은 위에서
                # 이 판정 前에 이미 나가 헤더를 flush했다, hang 방지 설계라 이 스토리에서 손대지
                # 않는다). 미등록 named event는 이 정확히 같은 엔드포인트에서 heartbeat이 매일
                # 무해함을 실증 중이라 계약 안전은 이미 확認됨(FE·MCP 브리지 둘 다 조용히 무시).
                yield (
                    "event: sync_status\n"
                    f"data: {json.dumps({'complete': _backfill_reason is None, 'reason': _backfill_reason, 'returned': len(pending_events)})}\n\n"
                )

                for i in range(0, len(pending_events), _SSE_BATCH_SIZE):
                    batch = pending_events[i : i + _SSE_BATCH_SIZE]
                    batch_data = [_event_to_payload(evt) for evt in batch]
                    # 1c22da3e fix: yield 먼저 → 성공 후 delivered 마킹.
                    # 선마킹 시 yield(클라 disconnect 등) 실패하면 이벤트가 delivered로
                    # 남아 영구 누락. 후마킹 + 클라 seen_ids dedup 으로 손실 0(재전송 허용).
                    for data, evt in zip(batch_data, batch):
                        yield f"event: {evt.event_type}\nid: {evt.id}\ndata: {json.dumps({**data, 'is_backfill': True})}\n\n"
                    for evt in batch:
                        evt.status = "delivered"
                        evt.delivered_at = now
                    await db.commit()

            # #2158: B계열(DB event_id 없는 transient push) 재연결 갭 재생. 위 A계열 DB
            # backfill과 같은 커서(`_ref`)를 재사용 — last_event_id가 A계열 Event를 가리키면
            # 그 created_at, since_timestamp만 있으면 그 값, 둘 다 없으면(초기 연결 또는
            # last_event_id가 B계열 id라 DB에 없어 못 구한 경우) replay()가 자체 TTL
            # 윈도우로 하한을 잡는다(무한 재생 방지). A/B가 저장소로 분리돼 있어(Event 테이블
            # vs Redis ZSET) 이 replay가 위 backfill과 겹쳐 중복 배달할 일은 구조적으로 없다.
            from app.services import sse_transient_replay
            _replay_cutoff = _ref.timestamp() if _ref is not None else None
            for _r_payload in await sse_transient_replay.replay(member_id_str, since=_replay_cutoff):
                _r_event_type = _r_payload.get("event_type", "message")
                # #2158 리뷰 반영(오르테가군 ①): 원 push가 부여한 id를 그대로 재사용 —
                # 여기서 새 uuid4를 만들면 이미 라이브로 받은 탭(또는 다른 재연결)이 받은
                # id와 달라져 클라 SeenIdsCache dedup이 같은 이벤트를 다른 걸로 오판한다.
                _r_id = _r_payload.pop("_sse_transient_id", None) or str(uuid.uuid4())
                yield (
                    f"event: {_r_event_type}\nid: {_r_id}\n"
                    f"data: {json.dumps({**_r_payload, 'event_id': _r_id, 'is_backfill': True})}\n\n"
                )

            # 신규 이벤트 리슨 — 대기 구간에서 커넥션 미점유, 이벤트마다 개별 세션
            # story c4c72eb1(E-ARCH GCE 이전) PR-A: 전역 shutdown_event를 queue.get()과 경합
            # 시켜(asyncio.wait FIRST_COMPLETED) 셧다운 신호에 하트비트 주기(최대 30초)를
            # 기다리지 않고 즉시 반응한다 — 강제 CancelledError 대신 정상 return으로 스트림을
            # 깔끔히 끝내 EventSource가 즉시 재연결하도록 유도(GCLB 드레이닝과 결합 시 자동으로
            # 건강한 인스턴스로 이동). shutdown 대기 태스크는 연결 생애주기 동안 단 1개만
            # 생성한다(루프마다 재생성하면 테스트 타이밍이 흔들려 test_s20 케이스가 불안정해짐 —
            # 뮤테이션 셀프체크로 확認됨, 매 iteration 재생성 버전은 실패).
            shutdown_wait_task = asyncio.create_task(_shutdown_module.shutdown_event.wait())
            try:
                while not await request.is_disconnected():
                    # story #2128 ①본체: 좀비가 스스로 늘릴 수 없는 유일한 축 — disconnect
                    # 감지 여부와 완전히 무관하게 발동(그게 이 방어선의 존재 이유). "완료로
                    # 위장" 안 함 — 아래에서 특별취급 없이 기존 finally: 하나로 그대로 흘러간다
                    # (정상종료·이상종료·수명초과 전부 같은 정리 경로, #2161 CAS 원칙의 적용).
                    if time.monotonic() >= _lifespan_deadline:
                        yield "event: lifespan_reconnect\ndata: {}\n\n"
                        return
                    get_task = asyncio.create_task(queue.get())
                    try:
                        done, _pending = await asyncio.wait(
                            {get_task, shutdown_wait_task},
                            timeout=_SSE_HEARTBEAT_TIMEOUT,
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        if shutdown_wait_task in done:
                            get_task.cancel()
                            yield "event: shutdown_reconnect\ndata: {}\n\n"
                            return
                        if get_task not in done:
                            # 타임아웃 — 기존 heartbeat 분기
                            get_task.cancel()
                            # #2121: 연결 살아있음 → lease score 재갱신(TTL 만료 방지). off/다운 no-op.
                            await sse_lease.refresh("events_global", _lease_conn_id)
                            yield "event: heartbeat\ndata: {}\n\n"
                            if await request.is_disconnected():
                                break
                            continue
                        event_data = get_task.result()
                        event_type = event_data.get("event_type", "message")
                        # 1c22da3e fix: yield 전엔 pending 여부만 확인(skip 판정, 마킹 X),
                        # delivered 마킹은 yield 성공 후로 미룬다 → yield 실패 시 영구 누락 방지.
                        eid = event_data.get("event_id")
                        if eid:
                            try:
                                async with async_session_factory() as db:
                                    r = await db.execute(
                                        select(Event.status).where(
                                            Event.id == uuid.UUID(eid),
                                            Event.org_id == org_id,
                                        )
                                    )
                                    _status = r.scalar_one_or_none()
                                    if _status is not None and _status != "pending":
                                        # 이미 백필/타 연결에서 delivered → 중복 skip
                                        continue
                            except Exception:
                                pass
                        # event_id 없는 경로(chats direct push 등)도 id: 보장 — 재연결 추적 약화 방지
                        # is_backfill: False 명시 + event_id 동기화 — SeenIdsCache dedup 및 relay 필터 정합성
                        # #2158: B계열은 `_push_to_agent`가 발행 시점에 부여한 `_sse_transient_id`를
                        # 우선 사용(eid가 없을 때) — 여기서 매번 새 uuid4를 만들면 같은 논리적
                        # 이벤트가 라이브 배달마다·재생 버퍼 배달과 서로 다른 id를 얻어 클라
                        # dedup이 무력화된다(오르테가군 PR 전 리뷰 ①). 내부 필드는 event_id로
                        # 대체돼 나가므로 원본 dict에서 제거(클라에 내부 키 노출 방지).
                        _transient_id = event_data.pop("_sse_transient_id", None)
                        _live_id = eid or _transient_id or str(uuid.uuid4())
                        _sse_data = json.dumps({**event_data, 'event_id': _live_id, 'is_backfill': False})
                        # S-COMM-12: canonical 이벤트 시 legacy alias도 병행 yield (HTTP SSE 하위호환)
                        if event_type == "conversation.message_created":
                            yield f"event: conversation:message\nid: {_live_id}\ndata: {_sse_data}\n\n"
                        yield f"event: {event_type}\nid: {_live_id}\ndata: {_sse_data}\n\n"
                        # yield 성공 후 delivered 마킹 (1c22da3e: 손실 방지, dup은 클라 dedup)
                        if eid:
                            try:
                                async with async_session_factory() as db:
                                    await db.execute(
                                        update(Event)
                                        .where(Event.id == uuid.UUID(eid), Event.status == "pending")
                                        .values(status="delivered", delivered_at=datetime.now(timezone.utc))
                                    )
                                    await db.commit()
                            except Exception:
                                pass
                    finally:
                        if not get_task.done():
                            get_task.cancel()
            finally:
                if not shutdown_wait_task.done():
                    shutdown_wait_task.cancel()
        except (asyncio.CancelledError, GeneratorExit):
            pass
        finally:
            global _sse_connection_count
            _sse_connection_count -= 1
            # #2121: lease 명시 해제(최적화만·TTL 이 주 회수 경로). off/다운 no-op.
            await sse_lease.release("events_global", _lease_conn_id)
            _agent_connections[member_id_str].discard(queue)
            if not _agent_connections[member_id_str]:
                _agent_connections.pop(member_id_str, None)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ─── CRUD endpoints ───────────────────────────────────────────────────────────

@router.post("", response_model=EventResponse, status_code=201)
async def create_event(
    body: CreateEventRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> EventResponse:
    """POST /api/v2/events — 이벤트 생성 (내부용).

    recipient가 SSE 연결 중이면 즉시 전달 + status=delivered.
    미연결이면 status=pending 유지.
    Channel Router(S-A6)로 preference 기반 채널 결정 후 전달.

    S19(SHOULD, PO 포함 승인): sender_id가 검증 없이 body에서 그대로 신뢰돼 caller가 임의
    sender로 이벤트를 위조(임퍼스네이션)할 수 있었다. sender_id가 명시되면 caller 본인과
    일치해야만 허용(시스템 이벤트의 sender_id=None 케이스는 그대로 무변경).

    S19(발견·회귀수정): axis-safe 비교(assert_caller_is_member) 사용 — resolve_member()/.id
    직접비교는 휴먼 JWT caller에서 축이 어긋나 본인 sender_id 지정도 403날 수 있었다.
    """
    if body.sender_id is not None:
        await assert_caller_is_member(
            body.sender_id, auth, db, org_id, detail="sender_id must match the caller's own identity",
        )

    # recipient가 동일 org 소속인지 + type 확정
    # E-MEMBER-SSOT Phase 0: grant-only 휴먼(org_member)도 수신자로 허용
    recipient = await resolve_member_identity(body.recipient_id, org_id, db)
    if recipient is None:
        raise HTTPException(status_code=404, detail="Recipient not found")
    member_type = recipient.type

    event = Event(
        project_id=body.project_id,
        org_id=org_id,
        event_type=body.event_type,
        source_entity_type=body.source_entity_type,
        source_entity_id=body.source_entity_id,
        sender_id=body.sender_id,
        recipient_id=body.recipient_id,
        recipient_type=member_type,
        payload=body.payload,
        status="pending",
    )
    db.add(event)
    await db.flush()  # event.id 확보
    # L1 BE-3: 같은 tx에서 활동 수렴(best-effort·SAVEPOINT) → event와 단일 commit(다른 fan-out
    # 사이트와 일관·commit 1회 유지). 추출 실패해도 SAVEPOINT만 롤백, delivery는 정상 commit.
    from app.services.activity_stream import extract_activities_best_effort
    await extract_activities_best_effort(db, [event.id])
    await db.commit()
    await db.refresh(event)

    # S-A6: Channel Router 기반 dispatch (preference → sse/discord/etc.)
    from app.services.dispatch_router import route_dispatch_event as _route_dispatch
    background_tasks.add_task(_route_dispatch_bg, event.id)

    return EventResponse.model_validate(event)


async def _route_dispatch_bg(event_id: uuid.UUID) -> None:
    """BackgroundTask wrapper — 별도 DB 세션에서 dispatch routing."""
    from app.core.database import async_session_factory
    from app.services.dispatch_router import route_dispatch_event

    async with async_session_factory() as db:
        try:
            await route_dispatch_event(event_id, db)
        except Exception:
            import logging
            logging.getLogger(__name__).exception(
                "dispatch routing failed event_id=%s", event_id
            )


# story #2428 PR⑤ QA(카디르, 2026-08-17): limit 상수를 라우터 함수 밖으로 빼 테스트가 실제로
# 「cap 걸림 + has_more」 경계를 작은 값으로 주입해 검증할 수 있게 한다(1000건 넘게 실제로
# 시딩하지 않고도) — PO 처방 ⓒ.
_PENDING_EVENTS_DEFAULT_LIMIT = 1000


@router.get("/pending", response_model=list[EventResponse])
async def get_pending_events(
    recipient_id: uuid.UUID = Query(...),
    event_type: str | None = Query(default=None),
    include_recent_delivered_minutes: int = Query(default=30, le=120),
    limit: int | None = Query(default=None, ge=1, le=2000),
    cursor: str | None = Query(default=None, description="Cursor: ISO 8601 created_at, fetch after this time(오래된순 정렬 forward-cursor)"),
    response: Response = None,  # type: ignore[assignment]
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[EventResponse]:
    """GET /api/v2/events/pending — 수신자별 pending + 최근 N분 delivered 이벤트 목록.

    include_recent_delivered_minutes: SSE로 delivered 마킹된 이벤트도 최근 N분 이내라면 반환.
    → SSE 전달과 poll_events 폴링 간 충돌(갭 2) 해소.

    산티아고 SME 최종 MUST(S19): recipient_id 쿼리로 타 member 이벤트(payload/sender/source)를
    auth·recipient 검증 없이 읽을 수 있었다 — mark_delivered(write)는 recipient==caller로
    닫혔는데 같은 recipient 축의 이 read fallback이 열려있었다. 동일 패턴(순수 self, admin
    대리열람 흐름 없음)으로 닫는다.

    story #2428 ⓐ: `.limit()`이 아예 없어 pending 무한 누적 위험(만료/reaper는 status=
    delivered에만 있고 pending 자체는 cap이 없음 — 페드루/디디 그라운딩 2026-08-17). goals.py
    규약 그대로(필터 適用 後·limit 適用 前 COUNT에 cursor 포함) limit/cursor/X-Total-Count
    추가. 정렬이 오래된순(asc)이라 cursor는 forward(`created_at > cursor`, artifact_comments와
    동형). ⚠️MCP 계층엔 mark_delivered를 부르는 도구가 없어(poll_events는 순수 read) 이
    엔드포인트는 «읽으면 준다」가 아니라 「pending으로 남는다」— cursor 없이 다시 부르면 같은
    상위 N건이 그대로 다시 온다(browse형과 다른 이 도구 특유의 함정, poll_events MCP 도구
    안내 문구에서 명시).

    ⚠️의도적 행동 변경(카디르 QA 2026-08-17, PO 처방): `limit` 미지정 시 이전엔 진짜 무제한
    이었으나 지금은 `_PENDING_EVENTS_DEFAULT_LIMIT`(1000)으로 잘린다 — 이건 «무회귀»가
    아니라 이 스토리(#2428) 본체가 명시적으로 요구하는 처방 그 자체다("조용히 자르는 기본값만
    넣으면... #2412의 병을 그대로 재현" — AC2/AC3). 무제한을 그대로 두는 게 아니라 **잘렸으면
    호출자가 알 수 있게**(`X-Total-Count`가 진짜 남은 건수, `total > len(items)`면 has_more)
    하는 것이 처방이었다. 계약: **limit 미지정 = 기본 1000 cap + X-Total-Count/has_more로
    잘림 신호**(이전 「무제한」 계약은 폐기 — 이 엔드포인트의 유일한 소비자인 MCP `poll_events`
    가 has_more를 이미 소비하므로 이 변경으로 조용히 깨지는 소비자 없음, 전수 grep 확認).
    """
    await assert_caller_is_member(
        recipient_id, auth, db, org_id, detail="Cannot read another member's events",
    )
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=include_recent_delivered_minutes)
    status_filter = or_(
        Event.status == "pending",
        and_(Event.status == "delivered", Event.delivered_at >= cutoff),
    )
    conds = [
        Event.org_id == org_id,
        Event.recipient_id == recipient_id,
        status_filter,
    ]
    if event_type:
        conds.append(Event.event_type == event_type)

    cursor_dt: datetime | None = None
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
        except (ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=400, detail="invalid cursor: expected ISO 8601 datetime"
            ) from exc
        conds.append(Event.created_at > cursor_dt)

    count_result = await db.execute(select(func.count()).select_from(Event).where(*conds))
    total = int(count_result.scalar_one() or 0)

    q = (
        select(Event).where(*conds).order_by(Event.created_at.asc())
        .limit(limit if limit is not None else _PENDING_EVENTS_DEFAULT_LIMIT)
    )
    result = await db.execute(q)
    events = result.scalars().all()

    if response is not None:
        response.headers["X-Total-Count"] = str(total)
        if events:
            response.headers["X-Next-Cursor"] = events[-1].created_at.isoformat()
    return [EventResponse.model_validate(e) for e in events]


@router.patch("/{event_id}/delivered", response_model=EventResponse)
async def mark_delivered(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> EventResponse:
    """PATCH /api/v2/events/{id}/delivered — 전달 완료 마킹.

    S19(#7 MUST): org-scope만 있고 recipient 확인이 없어 누구나 타 member의 이벤트를
    delivered로 마킹(알림 은폐)할 수 있었다. caller==recipient 강제(axis-safe).

    S19(발견·회귀수정): resolve_member()/.id 직접비교는 휴먼 JWT caller의 axis가 어긋나 본인
    이벤트도 403날 수 있었다 — assert_caller_is_member로 교체.
    """
    result = await db.execute(
        select(Event).where(Event.id == event_id, Event.org_id == org_id)
    )
    event = result.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")

    await assert_caller_is_member(
        event.recipient_id, auth, db, org_id, detail="Not the recipient of this event",
    )

    event.status = "delivered"
    event.delivered_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(event)
    return EventResponse.model_validate(event)


# ─── S3: 큐 관리 (expired + cleanup) ─────────────────────────────────────────

_EXPIRE_DAYS = 30  # pending → expired 후 이 기간 보관 (AC3: 최소 1일 이상)
_CLEANUP_DAYS = 7   # delivered 이벤트 삭제 주기 (AC3: 최소 1일 이상)
_EVENT_RETENTION_MIN_HOURS = 24  # S-COMM-05 AC3: 최소 보관 시간 (문서화 목적)
assert _EXPIRE_DAYS * 24 >= _EVENT_RETENTION_MIN_HOURS, "Event retention must be >= 24h"
assert _CLEANUP_DAYS * 24 >= _EVENT_RETENTION_MIN_HOURS, "Event cleanup must be >= 24h"


async def expire_stale_events_core(
    db: AsyncSession, org_id: uuid.UUID | None
) -> dict:
    """30일 초과 pending → expired, 7일 초과 delivered 삭제.

    ``org_id`` 가 주어지면 그 org 로 스코프(엔드포인트 경로), ``None`` 이면 전 org 일괄
    회수(cron 경로). E-EVENT-1CONFIG: ACK retire 가 delivered 로 마킹한 agent SSE 이벤트를
    이 cleanup 이 회수한다 — 둘이 짝이라 cron 미연결 시 retire 해도 영영 안 지워진다.
    """
    now = datetime.now(timezone.utc)
    cutoff_expire = now - timedelta(days=_EXPIRE_DAYS)
    cutoff_cleanup = now - timedelta(days=_CLEANUP_DAYS)

    expire_where = [Event.status == "pending", Event.created_at < cutoff_expire]
    cleanup_where = [Event.status == "delivered", Event.delivered_at < cutoff_cleanup]
    if org_id is not None:
        expire_where.append(Event.org_id == org_id)
        cleanup_where.append(Event.org_id == org_id)

    expired = await db.execute(update(Event).where(*expire_where).values(status="expired"))
    cleaned = await db.execute(delete(Event).where(*cleanup_where))

    await db.commit()
    return {"expired": expired.rowcount, "cleaned": cleaned.rowcount}


@router.post("/expire-stale", status_code=200)
async def expire_stale_events(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """POST /api/v2/events/expire-stale — 30일 초과 pending → expired, 7일 초과 delivered 삭제.

    S19(SHOULD, PO 포함 승인): per-resource ownership 문제가 아니라 privilege 게이트 자체가
    없어 org 내 임의 멤버가 org 전체 이벤트 만료/삭제를 강제할 수 있었다. org-admin 전용으로 닫는다.
    """
    if not await _is_org_admin(db, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")
    return await expire_stale_events_core(db, org_id)


# ─────────────────────────────────────────────────────────────────────────────
# story #2633(이벤트 레지스트리 P1a) — POST /publish. doc event-registry-core-p1-plan §2-2.
#
# ⛔AC2(신규 전달 계통 금지, story #2620 재발 방지): route_message()/DeliveryDecision은
# ConversationMessage가 이미 존재해야만 진입 가능한 구조라(하위 진입점 없음, 그라운딩 확認)
# "발행"은 실제로 conversation에 메시지를 쓰는 것과 같다 — dispatch_notification()(#2630에서
# 쓴 그것)은 별개 시스템(notification_settings·webhook_targeting 소비)이라 여기 쓰면 AC2
# 미충족+3계통 재발. 그래서 이 엔드포인트는 자체 배달 로직을 만들지 않고 **`send_message()`를
# 그대로 호출**한다 — mention/webhook parity·circuit breaker(#2630)·chain-depth(#2608) 전부
# 공짜로 상속(중복 구현 0).
# ─────────────────────────────────────────────────────────────────────────────

class EventPublishRequest(BaseModel):
    definition_key: str
    payload: dict
    # 정의의 routing.broadcast가 선언한 대상 외에 발행 시점에 추가로 공람시킬 대상(옵션 — P1
    # 플랜 §2-2 "추가 전파 대상"). org 소속만 허용(cross-org 필터, send_message와 동형).
    extra_broadcast_member_ids: list[uuid.UUID] = []


async def _resolve_event_project_id(
    db: AsyncSession, *, org_id: uuid.UUID, payload: dict,
) -> uuid.UUID | None:
    """이벤트가 속할 project_id — work_item_type/id가 있으면 그 작업의 project(gate_service.
    resolve_work_item_project_id 재사용, 신규 쿼리 만들지 않음), goal_id만 있으면(preset.
    goal.measured) Goal.project_id 직접. 둘 다 없으면 None(호출부가 400으로 거부)."""
    from app.services.event_routing_resolver import _parse_uuid

    if payload.get("work_item_type") and payload.get("work_item_id"):
        from app.services.gate_service import resolve_work_item_project_id

        return await resolve_work_item_project_id(
            db, org_id, payload["work_item_type"],
            _parse_uuid(payload["work_item_id"], field_name="work_item_id"),
        )
    if payload.get("goal_id"):
        from app.models.pm import Goal

        goal_id = _parse_uuid(payload["goal_id"], field_name="goal_id")
        return (await db.execute(
            select(Goal.project_id).where(Goal.id == goal_id, Goal.org_id == org_id)
        )).scalar_one_or_none()
    return None


async def _get_or_create_event_conversation(
    db: AsyncSession, *, org_id: uuid.UUID, project_id: uuid.UUID,
    participant_ids: set[uuid.UUID], created_by: uuid.UUID,
) -> "Conversation":
    """참가자 집합이 **정확히** 일치하는 기존 대화를 재사용, 없으면 생성 — approval_delivery.
    _get_or_create_approval_dm(2인 전용)을 N인으로 일반화(같은 원리: 표식이 아니라 실물
    참가자 집합이 정본, story #2628 교훈). 2인이면 dm, 3인 이상이면 group(1인 — escalation/
    broadcast 둘 다 빈 집합으로 해석된 경우 — 도 group으로 허용: 이해관계자가 없어도 이벤트
    자체는 감사 기록으로 durable해야 한다, P1 플랜 §1.5 goal-loop 입력 취지)."""
    from app.models.conversation import Conversation, ConversationParticipant
    from sqlalchemy import func as _func

    n = len(participant_ids)
    matched = (
        select(ConversationParticipant.conversation_id)
        .where(ConversationParticipant.member_id.in_(participant_ids))
        .group_by(ConversationParticipant.conversation_id)
        .having(_func.count(ConversationParticipant.member_id.distinct()) == n)
    ).scalar_subquery()
    exact = (
        select(ConversationParticipant.conversation_id)
        .where(ConversationParticipant.conversation_id.in_(matched))
        .group_by(ConversationParticipant.conversation_id)
        .having(_func.count() == n)
    ).scalar_subquery()
    existing = (await db.execute(
        select(Conversation)
        .where(Conversation.org_id == org_id, Conversation.id.in_(exact))
        .order_by(Conversation.updated_at.desc())
        .limit(1)
    )).scalars().first()
    if existing is not None:
        return existing

    from app.routers.conversations import _create_conversation_record

    return await _create_conversation_record(
        db, org_id=org_id, project_id=project_id, member_ids=participant_ids,
        conv_type="dm" if n == 2 else "group", title=None, created_by=created_by,
    )


def _render_event_message_content(definition_key: str, payload: dict) -> str:
    """P2(story #2637)의 block_template 렌더러가 상륙하기 전 제네릭 폴백 — model.py docstring의
    "템플릿 없으면 제네릭 카드"와 동형 원칙을 메시지 본문 레벨에서 지금 구현. 필드 순서는
    payload dict 삽입 순서(파이썬 3.7+ 보장) 그대로 — 임의 정렬로 무의미하게 흔들지 않는다."""
    lines = [f"[이벤트] {definition_key}"]
    lines += [f"- {k}: {v}" for k, v in payload.items()]
    return "\n".join(lines)


@router.post("/publish", status_code=201)
async def publish_registry_event(
    body: EventPublishRequest,
    background_tasks: BackgroundTasks,
    request: Request,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """POST /api/v2/events/publish — story #2633 AC1~AC3.

    ⚠️`publish_event`(이름 겹침 아님)가 아니라 `publish_registry_event`인 이유: 이 모듈에
    한때 `publish_event()`라는 완전히 다른 개념(SSE org-level fanout, 실 구독자 0으로
    영구 죽은 경로)이 있었고 #2139/#2132가 그걸 삭제하며 부활 감지 회귀가드(test_2139_2132_
    push_to_org_members.py::test_publish_event_and_subscribers_no_longer_exist)를 남겼다
    (push_to_org_members() 위 docstring 참조). 이 함수는 그것과 무관한 새 개념(이벤트
    레지스트리 발행 API)이라 이름을 아예 다르게 갈라 그 가드를 건드리지 않는다 — 같은
    이름을 다른 뜻으로 되쓰면 그 가드가 "부활"로 오판하는 게 아니라(가드는 hasattr만 보므로
    실제로 트립됐다), 미래 독자가 두 개념을 착각할 여지도 같이 없앤다.

    실 로직은 `_publish_registry_event_core`(story #2791 P0 추출) — 서버 자동발행
    (`publish_preset_event`)도 HTTP 요청 컨텍스트 없이 같은 core를 호출해 단일 파이프
    원칙(#2633 AC2)을 유지한다. 이 엔드포인트는 auth 의존성 해석만 하고 넘긴다."""
    return await _publish_registry_event_core(
        db, org_id, auth, body.definition_key, body.payload, background_tasks,
        request=request, extra_broadcast_member_ids=body.extra_broadcast_member_ids,
    )


async def _publish_registry_event_core(
    db: AsyncSession,
    org_id: uuid.UUID,
    auth: AuthContext,
    definition_key: str,
    payload: dict,
    background_tasks: BackgroundTasks,
    *,
    request: Request | None = None,
    extra_broadcast_member_ids: "list[uuid.UUID] | None" = None,
) -> dict:
    """`publish_registry_event`(HTTP)·`publish_preset_event`(서버 자동발행, story #2791 P0)의
    공유 core — definition_key+payload를 검증하고 routing(상신선·전파선)을 실 member_id로
    풀어 기존 단일 판정 파이프(route_message/DeliveryDecision, AC2)로 전달한다. HTTP 전용
    폴백(`request`가 있을 때만 쓰는 `resolve_required_project_id`)만 옵션 처리 — 자동발행
    호출부는 항상 payload에 work_item/goal 참조를 실어 이 폴백에 안 걸린다."""
    from app.services.member_resolver import resolve_member

    sender = await resolve_member(auth, org_id, db)

    from app.models.event_definition import EventDefinition

    definition = (await db.execute(
        select(EventDefinition)
        .where(
            EventDefinition.key == definition_key,
            EventDefinition.enabled.is_(True),
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        )
        # org 커스텀이 있으면 프리셋보다 우선(같은 key 오버라이드 시나리오 대비 — 지금은
        # #2632에 프리셋뿐이라 실질 영향 없음, #2636 커스텀 등록 대비 명시).
        .order_by(EventDefinition.org_id.is_(None))
        .limit(1)
    )).scalars().first()
    if definition is None:
        raise HTTPException(
            status_code=404, detail=f"event definition not found or disabled: {definition_key!r}",
        )

    # story #2637 §범위3(미르코 발견 후속, 2026-08-14): action_auth 실 집행 — 정의에 걸려
    # 있으면 발행 시점에 검사한다. 이전엔 block_template.actions[].auth가 등록 시점 구조
    # 검증만 받고 발행 시점엔 아무도 안 봐서 "FE만 버튼을 숨기고 서버는 거부 안 함"이었다
    # (#2091 클래스 — 금지 AC는 서버가 거부해야 성립). 이 엔드포인트가 버튼/REST/MCP 전부의
    # 유일한 발행 경로(#2633 AC2 단일 파이프)라 여기 한 곳만 지키면 경로 무관하게 막힌다.
    if definition.action_auth:
        if definition.action_auth.get("human_only") and sender.type == "agent":
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "action_auth_denied",
                    "message": f"이 이벤트({definition.key})는 human 발행자만 허용합니다.",
                },
            )
        allowed_roles = definition.action_auth.get("role")
        if allowed_roles and sender.role not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "action_auth_denied",
                    "message": f"이 이벤트({definition.key})는 {allowed_roles} role만 허용합니다.",
                },
            )

    from app.services.event_definition_registry import InvalidEventPayloadError, validate_event_payload

    try:
        validate_event_payload(definition.payload_schema, payload)
    except InvalidEventPayloadError as e:
        # story #2634 후속(#2633 정합): api_client.py의 _extract_error_message가 인식하는
        # {"detail":{"code","message"}} shape으로 맞춘다 — 신규 파싱 분기를 MCP 쪽에 안 만들고
        # 기존 추출 경로를 그대로 타게 하는 것(원칙). errors 배열은 기계가 읽을 상세라 message로
        # 뭉개지 않고 그대로 유지(extractor는 code/message 밖의 여분 키를 무해하게 무시한다).
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_payload", "message": str(e), "errors": e.errors},
        ) from e

    from app.services.event_routing_resolver import (
        InvalidWorkItemReferenceError,
        MissingRoutingPayloadFieldError,
        UnknownRoutingMemberError,
        resolve_routing_leg,
    )

    try:
        escalation_ids = await resolve_routing_leg(
            definition.routing["escalation"], payload=payload, org_id=org_id, db=db,
        )
        broadcast_ids = await resolve_routing_leg(
            definition.routing["broadcast"], payload=payload, org_id=org_id, db=db,
        )
    except (MissingRoutingPayloadFieldError, InvalidWorkItemReferenceError, UnknownRoutingMemberError) as e:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_payload", "message": str(e), "errors": [str(e)]},
        ) from e

    if extra_broadcast_member_ids:
        # story #2693(AC2): payload_field routing과 동일 검증 — 예전엔 filter_org_member_ids로
        # 비회원 id를 조용히 걸러내고(silent drop) 발행을 그대로 진행했다. AC1의 원자성
        # 요구(비회원이면 conv/msg 어느 것도 만들지 않는다)와 일관되게, 여기도 걸러내는 대신
        # 하나라도 비회원이면 명시 거부한다(조용한 유실 금지 — MissingRoutingPayloadFieldError와
        # 동일 철학).
        from app.services.member_resolver import filter_org_member_ids

        requested_extra = set(extra_broadcast_member_ids)
        valid_extra = await filter_org_member_ids(requested_extra, org_id, db)
        unknown_extra = requested_extra - valid_extra
        if unknown_extra:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "invalid_payload",
                    "message": f"extra_broadcast_member_ids에 이 org의 실존 회원이 아닌 id가 있습니다: "
                               f"{sorted(str(i) for i in unknown_extra)}",
                    "errors": [str(i) for i in unknown_extra],
                },
            )
        broadcast_ids |= valid_extra

    try:
        project_id = await _resolve_event_project_id(db, org_id=org_id, payload=payload)
    except InvalidWorkItemReferenceError as e:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_payload", "message": str(e), "errors": [str(e)]},
        ) from e
    if project_id is None:
        # story #2674 — «참조 필드 자체가 없음»과 «참조는 있는데 못 풂(dangling)»은 다른
        # 사건이다. 정의기(#2670)가 만드는 임의 payload 커스텀 이벤트(신호형·측정형류)는
        # 전자(work_item/goal 키가 애초에 없음) — 이땐 호출 컨텍스트(X-Project-Id 헤더/API키
        # 앵커/멤버 기본 프로젝트)로 폴백한다. 후자(goal_id는 줬는데 그 goal이 존재하지 않는
        # 등)는 사용자가 뭔가를 참조하려다 실패한 것이라 컨텍스트로 조용히 다른 프로젝트를
        # 골라주면 더 헷갈린다 — 그대로 명시 거부(test_publish_unresolvable_project_400의
        # 기존 계약, AC2 무회귀).
        attempted_reference = bool(
            (payload.get("work_item_type") and payload.get("work_item_id"))
            or payload.get("goal_id")
        )
        if attempted_reference:
            raise HTTPException(
                status_code=400,
                detail="payload에서 project를 해소할 수 없습니다(work_item_type+work_item_id 또는 goal_id 필요).",
            )

        # resolve_required_project_id(app/dependencies/project_scope.py)는 MCP api_client.py의
        # require_project_id()와 동일 계약인 기존 SSOT 폴백 사슬이라 새로 발명하지 않는다.
        # 라우팅 의미론(escalation/broadcast 해소)은 이 프로젝트 폴백과 무관 — payload_field/
        # server_derived 어느 쪽도 project_id를 참조하지 않는다(model.py docstring 참조).
        from app.dependencies.project_scope import resolve_required_project_id

        try:
            project_id = await resolve_required_project_id(db, request, auth, org_id)
        except HTTPException:
            # 컨텍스트도 없으면(예: 멀티프로젝트 키인데 헤더도 기본 프로젝트도 없음) 현행
            # 문구 그대로 거부한다 — 음성대조(AC): 참조도 컨텍스트도 없으면 여전히 명시 거부.
            raise HTTPException(
                status_code=400,
                detail="payload에서 project를 해소할 수 없습니다(work_item_type+work_item_id 또는 goal_id 필요).",
            ) from None

    participant_ids = {sender.id} | escalation_ids | broadcast_ids
    conv = await _get_or_create_event_conversation(
        db, org_id=org_id, project_id=project_id,
        participant_ids=participant_ids, created_by=sender.id,
    )

    from app.routers.conversations import SendMessageRequest, send_message

    # story #2637 AC 0-a: event_context → msg_metadata['event'](additive) — FE가 이 메시지를
    # "이벤트 발행분"으로 인지하고 event_key로 event_definitions를 조회해 block_template
    # 렌더러를 태울 근거. 렌더러 자체는 #2637 FE 레인(이 커밋은 스키마 배선만).
    send_body = SendMessageRequest(
        content=_render_event_message_content(definition.key, payload),
        mentioned_ids=list(escalation_ids),
        event_context={"event_key": definition.key, "payload": payload},
    )
    msg_response = await send_message(
        conv.id, send_body, background_tasks, db=db, auth=auth, org_id=org_id,
    )

    # story #2636(P1b) 갭 1호 처방 — 전환 실측(가동 1시간, 페드루군)에서 실제로 걸린
    # 정황: work_item이 보드에 미배정이면 work_item_stakeholders 해석이 빈 집합이라 발행은
    # 201로 "성공"하는데 escalation·broadcast 둘 다 아무도 못 받는다 — 응답만 보면 정상
    # 발행처럼 보여 조용한 무도달이 된다. 여기서 명시 경고 필드를 싣는다(MCP 쪽은
    # sprintable_publish_event가 이 필드를 사람 문장으로 강조 — tools/events.py).
    zero_reach = not escalation_ids and not broadcast_ids
    result = {
        "conversation_id": str(conv.id),
        "message_id": msg_response["data"]["id"],
        "escalation_member_ids": [str(i) for i in escalation_ids],
        "broadcast_member_ids": [str(i) for i in broadcast_ids],
        "zero_reach_warning": zero_reach,
    }
    if zero_reach:
        result["warning"] = (
            "발행은 성공했으나 escalation·broadcast 대상이 모두 0명입니다 — "
            "work_item이 미배정이거나 routing이 아무도 가리키지 않습니다."
        )
    return result


async def _get_or_create_system_publisher(db: AsyncSession, org_id: uuid.UUID) -> "Member":
    """story #2791(P0) — 서버 도메인 전이 자동발행 전용 시스템 발신자. org당 정확히 1행
    (0258 부분 유니크 인덱스로 DB 레벨 동시성 가드), get-or-create 멱등.

    ⚠️`team_members`가 아니라 **`members`**(anchor 테이블)에 직접 쓴다 — `team_members`는
    0088+에서 `members`/`project_access`/`agent_project_profiles` 위 3-way UNION ALL VIEW로
    전환됐다(초판 실수 CI가 실측으로 잡아냄, 0258 참조). `send_message`의 sender 해석
    (conversations.py::`_resolve_member`, api_key 분기)은 `team_members` 뷰를 `TeamMember.id
    == auth.user_id`로 SELECT하므로, 이 member가 뷰에 최소 1행 투영되려면 `project_access`
    grant가 최소 1건 있어야 한다(뷰의 3번째 UNION 브랜치 — profile 없는 agent-grant-only).

    소유·수명: 이 org가 존재하는 한 영구 — 별도 TTL·수동 정리 없음(자동발행 자체가 이 org
    수명과 결합돼 있어 "고아 리소스" 클래스가 아니다).

    project_access의 `project_id`는 org 내 아무 project 하나에 anchor해도 무방(2026-08-19
    실측, story #2791 PR 참조) — sender 해석 자체는 project 무관, 그 project를 특정
    대화방에 결부시키는 것도 아니다(발행 대상 conversation의 project_id는 매 호출마다
    `_resolve_event_project_id`가 payload의 work_item/goal에서 별도로 뽑는다).

    `type='agent'`로 만들어 기존 서킷브레이커(agent 발신자 전용, story #2630)가 자동발행
    폭주(전이 루프)도 그대로 방어하게 한다 — 의도적으로 끄지 않는다(P0 가드②). 마커는
    `members.runtime_type`(9종 enum이지만 `get_runtime_capability`가 미등록 문자열을
    UNSUPPORTED_CAPABILITY로 안전 처리 — app/services/agent_runtime.py 확인) 재사용 —
    `team_members` 뷰가 이 컬럼을 그대로 투영해 `send_message()` 등 뷰 기반 호출부가 값을
    직접 읽을 수 있다(초판은 `handle`을 썼으나 뷰가 그 컬럼을 투영 안 해 재QA 중 정정,
    0258 참조). 이 마커가 실제로 쓰이는 자리 — `send_message()`가 발신자 `runtime_type`이
    이 값이면 presence/working 방출을 스킵한다(아래 가드③ 참조: system 발신자는 애초에
    "지금 활동 중"이라는 presence 개념이 성립하지 않는 존재라 org 전체에 그 신호를 쏘는
    것 자체가 의미론적으로 틀렸다는 판단, 페드루 2026-08-19).
    이름 "시스템 발행"은 채팅 카드의 sender 표시가 사람 눈에 시스템 발행임을 신규 FE 없이
    이름만으로 읽히게 하기 위함(P0 가드④) — 팀멤버 목록·리더보드·워크포스 표면에는 이 이름
    그대로의 agent 1명으로 노출된다(관측 기록, P0 스코프 밖 — 페드루 2026-08-19 확認).
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.member import Member
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    existing = (await db.execute(
        select(Member).where(
            Member.org_id == org_id, Member.runtime_type == "system-publisher", Member.type == "agent",
        ).limit(1)
    )).scalars().first()
    if existing is not None:
        return existing

    anchor_project_id = (await db.execute(
        select(Project.id)
        .where(Project.org_id == org_id, Project.deleted_at.is_(None))
        .order_by(Project.created_at.asc())
        .limit(1)
    )).scalar_one_or_none()
    if anchor_project_id is None:
        raise ValueError(f"org {org_id}에 anchor할 project가 없음 — 시스템 발신자 프로비저닝 불가")

    ins = pg_insert(Member).values(
        id=uuid.uuid4(), org_id=org_id, type="agent", name="시스템 발행",
        runtime_type="system-publisher", is_active=True,
    ).on_conflict_do_nothing(
        index_elements=["org_id"],
        index_where=(and_(Member.runtime_type == "system-publisher", Member.type == "agent")),
    ).returning(Member.id)
    member_id = (await db.execute(ins)).scalar_one_or_none()
    if member_id is None:
        # 동시요청 레이스로 다른 트랜잭션이 먼저 생성 — 재조회(asset_registry.py와 동일 TOCTOU 대응).
        return (await db.execute(
            select(Member).where(
                Member.org_id == org_id, Member.runtime_type == "system-publisher", Member.type == "agent",
            )
        )).scalars().one()

    # team_members 뷰(3번째 UNION 브랜치)에 투영되려면 project_access grant가 최소 1건 필요.
    # 별도 on_conflict 불요 — 위 members insert가 org당 1행을 이미 원자적으로 게이팅해서,
    # 이 라인엔 그 레이스를 이긴 트랜잭션 단 하나만 도달한다(재조회 분기는 여기 안 옴).
    db.add(ProjectAccess(
        id=uuid.uuid4(), project_id=anchor_project_id, org_member_id=None,
        member_id=member_id, permission="granted", role="member",
    ))
    await db.flush()
    return (await db.execute(select(Member).where(Member.id == member_id))).scalars().one()


async def publish_preset_event(
    db: AsyncSession,
    org_id: uuid.UUID,
    definition_key: str,
    payload: dict,
) -> dict | None:
    """story #2791(P0, event-workflow-unification-design-2790) — 서버 도메인 전이 지점
    (상태변경·배정·게이트판정·목표측정)에서 호출하는 자동발행 진입점. HTTP 요청 컨텍스트
    없이(4개 호출부 전부 `BackgroundTasks` 미보유 — 시그니처 확장 대신 이 함수가 자체
    `BackgroundTasks()`를 만들어 `_publish_registry_event_core` 완료 직후 즉시 실행한다,
    HTTP 응답 이후로 미룰 대상이 없으므로 안전) `_publish_registry_event_core`를 그대로
    호출해 #2633 AC2 단일 발행 파이프 원칙을 지킨다 — 신규 발행 갈래를 만들지 않는다.

    **구계통(story_status_events.py 등 SSE·웹훅·알림)과의 관계는 병행이다, 대체가 아니다**
    — 이 함수는 기존 5-effect 옆에 프리셋 발행을 하나 더 추가할 뿐, 기존 effect를 하나도
    안 건드린다(이중발송처럼 보이지만 서로 다른 채널: 구계통=SSE/webhook/notification,
    신계통=이벤트 레지스트리 발행 대화 메시지 — 수신자가 같아도 매체가 다르다).

    ⚠️호출자 계약(story_status_events.py::emit_story_status_changed와 동형) — 이 함수는
    예외를 삼키지 않는다. best-effort 격리(실패가 도메인 전이 자체를 깨면 안 됨)는
    **호출자**가 개별 try/except로 감싸는 몫이다 — 이 함수 안에서 조용히 삼키면 실패
    자체를 관측할 수 없다(기존 5-effect와 동일 조직 원칙).

    반환값 `None` = definition이 비활성/미등록이라 정상 no-op(아직 이 org가 프리셋을 안
    켰거나 #2636 커스텀 오버라이드로 비활성화한 경우 — 발행 실패가 아니다). zero-reach는
    HTTP 응답 필드 대신 서버 로그(`logger.warning`)로 남긴다 — 이 호출엔 응답을 읽는 사람이
    없어(핵심 제약②, 침묵 실패 금지) 응답 필드에만 실으면 완전히 유실된다.
    """
    from app.models.event_definition import EventDefinition

    definition = (await db.execute(
        select(EventDefinition)
        .where(
            EventDefinition.key == definition_key,
            EventDefinition.enabled.is_(True),
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        )
        .limit(1)
    )).scalars().first()
    if definition is None:
        return None

    system_member = await _get_or_create_system_publisher(db, org_id)
    auth = AuthContext(
        user_id=str(system_member.id), email=None,
        claims={"app_metadata": {"api_key_id": "system-publisher"}}, org_id=str(org_id),
    )
    background_tasks = BackgroundTasks()
    result = await _publish_registry_event_core(
        db, org_id, auth, definition_key, payload, background_tasks,
    )
    await background_tasks()
    if result.get("zero_reach_warning"):
        logger.warning(
            "preset event zero_reach — 도달 0명(org=%s definition=%s payload_keys=%s)",
            org_id, definition_key, sorted(payload.keys()),
        )
    return result


class EventDefinitionResponse(BaseModel):
    # story #2663 — id가 없어 GET 목록에서 얻은 정의를 PATCH(uuid 필수)로 못 이어갔다(org
    # admin도 DB를 직접 파야 하는 갭이었다 — 2026-08-15 P2 어휘 집행 중 실측). 값은
    # EventDefinitionDetailResponse/_event_definition_detail과 동일하게 str(uuid).
    id: str
    key: str
    org_id: str | None
    # story #2792(2790 P1) — name/description 신설(PO 확定 2026-08-19 ①). key는 여전히
    # 기계용 식별자, name이 사람용 표시(드롭다운 등) — role_templates류 i18n 오버레이는
    # 여기 없음(신규 서브시스템 얹지 않는다, 이번 스코프 밖).
    name: str
    description: str | None
    payload_schema: dict
    routing: dict
    block_template: dict | None
    # 사이클형 정의의 stage별 role/action 카탈로그 메타 — {slug: {role, action}}. 신호형/
    # 측정형 정의는 빈 dict.
    stage_metadata: dict
    enabled: bool
    version: int


@router.get("/definitions", response_model=list[EventDefinitionResponse])
async def list_event_definitions(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[EventDefinitionResponse]:
    """GET /api/v2/events/definitions — story #2634: 발행 가능한 이벤트 정의 카탈로그 조회.

    가시성 규칙은 publish_registry_event의 정의 조회 WHERE절과 동일(SSOT 재사용) —
    플랫폼 프리셋(org_id NULL) ∪ 이 org 커스텀(org_id=자기 자신). enabled=false인 정의도
    감추지 않고 그대로 노출한다(publish 시 그 상태로 거부될 것을 호출자가 미리 알 수 있게 —
    조용히 숨기면 "왜 안 보이지"가 "왜 발행이 막히지"로 한 겹 더 미뤄질 뿐이다).
    """
    from app.models.event_definition import EventDefinition

    rows = (await db.execute(
        select(EventDefinition)
        .where(or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)))
        .order_by(EventDefinition.key)
    )).scalars().all()
    return [
        EventDefinitionResponse(
            id=str(r.id), key=r.key, org_id=str(r.org_id) if r.org_id else None,
            name=r.name, description=r.description,
            payload_schema=r.payload_schema, routing=r.routing,
            block_template=r.block_template, stage_metadata=r.stage_metadata,
            enabled=r.enabled, version=r.version,
        )
        for r in rows
    ]


# ─────────────────────────────────────────────────────────────────────────────
# story #2793(2790 P2) — get_workflow_guide respec: "정본 패키지" 온보딩 가이드.
# 판별 기준(카드 서두, 선생님 온보딩 철학 verbatim) = 최저 지능 에이전트로 실측 — 설명은
# 짧고 명령형·한 번에 한 행동·다음 행동은 항상 서버가 알려준다. 이 엔드포인트가 그
# "서버가 알려주는 다음 행동"의 유일한 소스가 된다(recipes[0] 임의 선택 완전 제거).
# ─────────────────────────────────────────────────────────────────────────────

# 짧고 명령형 — 온보딩 철학 자체를 한 단락으로. 새 규칙을 발명하지 않는다(카드 서두 원문
# 요지의 재진술 — "설명 짧게·한 번에 한 행동·다음 행동은 서버가 알려줌"을 그대로 문장화).
_ONBOARDING_PHILOSOPHY = (
    "아래는 이 조직에서 발행 가능한 이벤트 전부입니다. 사이클형 이벤트는 각 단계마다 "
    "누가(역할) 무엇을(행동) 해야 하는지 그대로 적혀 있습니다 — 외우지 말고 그때그때 이 "
    "표를 다시 확인하세요. 한 번에 한 단계만 진행하세요. 무엇을 할지 모르겠으면 지어내지 "
    "말고 이 표에서 찾으세요."
)


def _classify_event_kind(payload_schema: dict) -> str:
    """페드루 확定 3서식 어휘(human-event-definer-design-v1) 재사용 — 새 분류 발명 안 함."""
    props = (payload_schema or {}).get("properties") or {}
    if isinstance((props.get("stage") or {}).get("enum"), list):
        return "cycle"
    if "metric_value" in props:
        return "measurement"
    return "signal"


def _render_onboarding_guide(rows: list["EventDefinition"]) -> str:
    """enabled 정의만으로 마크다운 가이드 조립 — disabled를 넣으면 "발행 가능"이라는
    잘못된 다음-행동 지시가 된다(list_event_definitions의 admin 감사 목적과 다른 축이라
    disabled 포함 여부도 다르다, 의도적 비대칭)."""
    lines = [_ONBOARDING_PHILOSOPHY, ""]
    for r in rows:
        if not r.enabled:
            continue
        lines.append(f"## {r.name} (`{r.key}`)")
        if r.description:
            lines.append(r.description)
        kind = _classify_event_kind(r.payload_schema)
        if kind == "cycle" and r.stage_metadata:
            lines.append("")
            lines.append("이 이벤트는 다음 상황에서 발행하세요:")
            stage_order = ((r.payload_schema.get("properties") or {}).get("stage") or {}).get("enum") or []
            for slug in stage_order:
                meta = r.stage_metadata.get(slug)
                if not meta:
                    continue
                lines.append(f"- 단계 `{slug}`: **{meta.get('role', '')}** 담당 — {meta.get('action', '')}")
        else:
            required = (r.payload_schema or {}).get("required") or []
            if required:
                lines.append("")
                lines.append(f"발행 시 필수 항목: {', '.join(f'`{f}`' for f in required)}")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


class OnboardingGuideResponse(BaseModel):
    philosophy: str
    guide: str
    event_count: int


@router.get("/onboarding-guide", response_model=OnboardingGuideResponse)
async def get_onboarding_guide(
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> OnboardingGuideResponse:
    """GET /api/v2/events/onboarding-guide — story #2793(2790 P2): MCP `get_workflow_guide`
    가 부르는 단일 소스. `recipes[0]` 임의 선택(구 workflow-recipes 결함ⓐ)을 대체 —
    이 엔드포인트엔 "0번째"라는 개념 자체가 없다(전체 카탈로그를 한 번에 반환).

    가시성은 `list_event_definitions`와 동일 SSOT(org 프리셋 ∪ 이 org 커스텀)지만 그와
    달리 **enabled=false는 가이드에서 제외**한다 — 저건 admin 감사용(뭐가 꺼져 있는지도
    보여야 함), 이건 "지금 뭘 할 수 있는지"를 알려주는 운영 가이드라 꺼진 이벤트를
    보여주면 존재하지 않는 다음-행동을 지시하게 된다.

    `stage_metadata`(story #2792 P1)가 "기대 행동"의 실 데이터 소스 — 더 이상 DB
    `workflow_templates.steps[].action` 공란(구 결함ⓑ)에 기대지 않는다.
    """
    from app.models.event_definition import EventDefinition

    rows = (await db.execute(
        select(EventDefinition)
        .where(or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)))
        .order_by(EventDefinition.key)
    )).scalars().all()

    enabled_rows = [r for r in rows if r.enabled]
    return OnboardingGuideResponse(
        philosophy=_ONBOARDING_PHILOSOPHY,
        guide=_render_onboarding_guide(rows),
        event_count=len(enabled_rows),
    )


# ─────────────────────────────────────────────────────────────────────────────
# story #2636(P1b) — org 커스텀 이벤트 등록 API. doc event-registry-p1b-custom-registration-
# detail. #2632가 확定해 둔 게이트 3종(validate_event_definition_key·validate_event_routing
# (allow_server_derived=False)·validate_event_payload_schema_shape)을 그대로 소비한다 — 새
# 검증 로직을 여기서 만들지 않는다(그 세 함수가 이미 실 계약이자 실 테스트 대상).
# ─────────────────────────────────────────────────────────────────────────────

class CreateEventDefinitionRequest(BaseModel):
    key: str
    # story #2792(2790 P1, PO 확定 2026-08-19 ①) — 사람용 표시 이름(드롭다운 등). key는
    # 기계용 식별자로 그대로 둔다. 기본값 ""은 DB server_default와 동일 안전망 컨벤션(#2636
    # 기존 호출부가 name 없이도 여전히 동작 — 신규 필드가 기존 계약을 안 깬다).
    name: str = ""
    description: str | None = None
    payload_schema: dict
    routing: dict
    # story #2637 §범위1/5: optional — 없으면 렌더러가 현행 제네릭 폴백을 쓴다(비회귀).
    block_template: dict | None = None
    # story #2637 §범위3(미르코 발견 후속, 2026-08-14): 정의 레벨 발행 인가 — 있으면
    # publish_registry_event가 발행 시점에 실제로 집행한다(human_only·role). 경로 무관
    # (버튼/REST/MCP 전부 이 단일 엔드포인트를 탄다 — #2633 AC2 단일 파이프 덕에 별도
    # 집행 지점이 필요 없다).
    action_auth: dict | None = None
    # story #2792(2790 P1) — 사이클형 정의의 stage별 role/action 카탈로그 메타. 키는
    # payload_schema.properties.stage.enum의 부분집합이어야 한다(validate_stage_metadata,
    # 가드①) — 비어 있으면(신호형/측정형) 검증 스킵.
    stage_metadata: dict = {}


class UpdateEventDefinitionRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    payload_schema: dict | None = None
    routing: dict | None = None
    enabled: bool | None = None
    block_template: dict | None = None
    action_auth: dict | None = None
    stage_metadata: dict | None = None


class EventDefinitionDetailResponse(BaseModel):
    id: str
    key: str
    org_id: str | None
    name: str
    description: str | None
    payload_schema: dict
    routing: dict
    block_template: dict | None
    action_auth: dict | None
    stage_metadata: dict
    enabled: bool
    version: int
    created_by: str | None


def _event_definition_detail(d: "EventDefinition") -> EventDefinitionDetailResponse:
    return EventDefinitionDetailResponse(
        id=str(d.id), key=d.key, org_id=str(d.org_id) if d.org_id else None,
        name=d.name, description=d.description,
        payload_schema=d.payload_schema, routing=d.routing,
        block_template=d.block_template, action_auth=d.action_auth,
        stage_metadata=d.stage_metadata,
        enabled=d.enabled, version=d.version,
        created_by=str(d.created_by) if d.created_by else None,
    )


async def _get_org_slug(db: AsyncSession, org_id: uuid.UUID) -> str:
    from app.models.organization import Organization

    slug = (await db.execute(
        select(Organization.slug).where(Organization.id == org_id)
    )).scalar_one_or_none()
    if slug is None:
        raise HTTPException(status_code=404, detail="organization not found")
    return slug


@router.post("/definitions", status_code=201, response_model=EventDefinitionDetailResponse)
async def create_event_definition(
    body: CreateEventDefinitionRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> EventDefinitionDetailResponse:
    """POST /api/v2/events/definitions — story #2636 AC1(스키마 gate)·AC2(escalation-none).

    org admin/owner 전용(_is_org_admin, story #2391 S19와 동형 privilege 게이트). key
    네임스페이스(org.{자기 slug}.*)·payload_schema shape(additionalProperties:false 필수)·
    routing(server_derived 금지, target=none만 예외)을 #2632/#2636이 확定한 게이트 3종으로
    검증 — 이 함수는 그 세 함수를 호출만 하고 새 규칙을 만들지 않는다.
    """
    from app.models.event_definition import EventDefinition
    from app.services.event_definition_registry import (
        InvalidActionAuthError,
        InvalidBlockTemplateError,
        InvalidEventDefinitionKeyError,
        InvalidEventRoutingError,
        InvalidPayloadSchemaError,
        InvalidStageMetadataError,
        validate_action_auth,
        validate_block_template,
        validate_event_definition_key,
        validate_event_payload_schema_shape,
        validate_event_routing,
        validate_stage_metadata,
    )
    from app.services.member_resolver import resolve_member

    if not await _is_org_admin(db, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")

    org_slug = await _get_org_slug(db, org_id)
    try:
        validate_event_definition_key(body.key, org_id=org_id, org_slug=org_slug)
        validate_event_payload_schema_shape(body.payload_schema)
        validate_event_routing(body.routing, allow_server_derived=False)
        if body.block_template is not None:
            validate_block_template(body.block_template)
        if body.action_auth is not None:
            validate_action_auth(body.action_auth)
        validate_stage_metadata(body.payload_schema, body.stage_metadata)
    except (
        InvalidEventDefinitionKeyError, InvalidPayloadSchemaError,
        InvalidEventRoutingError, InvalidBlockTemplateError, InvalidActionAuthError,
        InvalidStageMetadataError,
    ) as e:
        raise HTTPException(
            status_code=400, detail={"code": "invalid_definition", "message": str(e)},
        ) from e

    existing = (await db.execute(
        select(EventDefinition.id).where(
            EventDefinition.org_id == org_id, EventDefinition.key == body.key,
        )
    )).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail={"code": "definition_key_conflict", "message": f"key {body.key!r} already registered"},
        )

    sender = await resolve_member(auth, org_id, db)
    definition = EventDefinition(
        id=uuid.uuid4(), key=body.key, org_id=org_id,
        name=body.name, description=body.description,
        payload_schema=body.payload_schema, routing=body.routing,
        block_template=body.block_template, action_auth=body.action_auth,
        stage_metadata=body.stage_metadata,
        created_by=sender.id,
    )
    db.add(definition)
    await db.commit()
    await db.refresh(definition)
    return _event_definition_detail(definition)


@router.patch("/definitions/{definition_id}", response_model=EventDefinitionDetailResponse)
async def update_event_definition(
    definition_id: uuid.UUID,
    body: UpdateEventDefinitionRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> EventDefinitionDetailResponse:
    """PATCH /api/v2/events/definitions/{id} — story #2636: 수정(payload_schema/routing 변경
    시 version 범프) + 삭제(enabled=false, soft — 발행 이력이 정의를 참조하므로 hard delete
    금지). 플랫폼 프리셋(org_id IS NULL)은 이 org-scoped 경로로 절대 patch 불가 — org_id 일치
    행만 대상(WHERE에 명시, 존재해도 org_id 안 맞으면 404로 정보 노출 0)."""
    from app.models.event_definition import EventDefinition
    from app.services.event_definition_registry import (
        InvalidActionAuthError,
        InvalidBlockTemplateError,
        InvalidEventRoutingError,
        InvalidPayloadSchemaError,
        InvalidStageMetadataError,
        validate_action_auth,
        validate_block_template,
        validate_event_payload_schema_shape,
        validate_event_routing,
        validate_stage_metadata,
    )

    if not await _is_org_admin(db, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")

    if (
        body.name is None and body.description is None
        and body.payload_schema is None and body.routing is None and body.enabled is None
        and body.block_template is None and body.action_auth is None and body.stage_metadata is None
    ):
        raise HTTPException(status_code=400, detail="at least one field must be provided")

    definition = (await db.execute(
        select(EventDefinition).where(
            EventDefinition.id == definition_id, EventDefinition.org_id == org_id,
        )
    )).scalar_one_or_none()
    if definition is None:
        raise HTTPException(status_code=404, detail="event definition not found")

    # story #2792 가드① — stage_metadata는 payload_schema와 짝인 검증이라, 둘 중 하나만
    # 바뀌어도 **유효 조합**(새 값 있으면 새 값·없으면 기존 값)으로 재검증한다. payload_schema만
    # 줄어들고 stage_metadata를 안 건드리면 기존 메타가 고아가 될 수 있어(예: enum에서 stage
    # 하나를 뺐는데 그 slug를 가리키던 메타는 그대로) — 이 경우도 여기서 걸린다.
    if body.payload_schema is not None or body.stage_metadata is not None:
        effective_schema = body.payload_schema if body.payload_schema is not None else definition.payload_schema
        effective_stage_metadata = (
            body.stage_metadata if body.stage_metadata is not None else definition.stage_metadata
        )
        try:
            validate_stage_metadata(effective_schema, effective_stage_metadata)
        except InvalidStageMetadataError as e:
            raise HTTPException(
                status_code=400, detail={"code": "invalid_definition", "message": str(e)},
            ) from e

    content_changed = False
    if body.name is not None:
        definition.name = body.name
        content_changed = True
    if body.description is not None:
        definition.description = body.description
        content_changed = True
    if body.stage_metadata is not None:
        definition.stage_metadata = body.stage_metadata
        content_changed = True
    if body.payload_schema is not None:
        try:
            validate_event_payload_schema_shape(body.payload_schema)
        except InvalidPayloadSchemaError as e:
            raise HTTPException(
                status_code=400, detail={"code": "invalid_definition", "message": str(e)},
            ) from e
        definition.payload_schema = body.payload_schema
        content_changed = True
    if body.routing is not None:
        try:
            validate_event_routing(body.routing, allow_server_derived=False)
        except InvalidEventRoutingError as e:
            raise HTTPException(
                status_code=400, detail={"code": "invalid_definition", "message": str(e)},
            ) from e
        definition.routing = body.routing
        content_changed = True
    if body.block_template is not None:
        try:
            validate_block_template(body.block_template)
        except InvalidBlockTemplateError as e:
            raise HTTPException(
                status_code=400, detail={"code": "invalid_definition", "message": str(e)},
            ) from e
        definition.block_template = body.block_template
        content_changed = True
    if body.action_auth is not None:
        try:
            validate_action_auth(body.action_auth)
        except InvalidActionAuthError as e:
            raise HTTPException(
                status_code=400, detail={"code": "invalid_definition", "message": str(e)},
            ) from e
        definition.action_auth = body.action_auth
        content_changed = True
    if body.enabled is not None:
        definition.enabled = body.enabled

    if content_changed:
        definition.version += 1

    await db.commit()
    await db.refresh(definition)
    return _event_definition_detail(definition)


class EventPublishHistoryItem(BaseModel):
    id: str
    conversation_id: str
    sender_id: str | None
    sender_name: str | None
    created_at: datetime


@router.get("/definitions/publish-history", response_model=list[EventPublishHistoryItem])
async def get_event_publish_history(
    definition_key: str = Query(...),
    limit: int = Query(default=20, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[EventPublishHistoryItem]:
    """GET /api/v2/events/definitions/publish-history — story #2665(#2664 후속): definition_key
    축 발행 이력 조회.

    발행 기록 자체가 별도 로그 테이블이 아니라 대화 메시지 metadata에만 존재한다(#2637
    AC 0-a — publish_registry_event가 msg_metadata['event']['event_key']로 태깅) — 그
    SSOT를 그대로 조회한다(신규 로그 테이블 발명 안 함).

    org admin/owner 전용(다른 정의 관리 엔드포인트와 동일 게이트 — 발행 이력도 관리 맥락의
    관측 표면). conversation_messages 자체엔 org_id 컬럼이 없어(1:N via conversations)
    conversations.org_id로 JOIN해서 스코프를 건다 — definition_key가 preset이든 org
    커스텀이든 무관하게, "이 org의 대화에서 실제로 발행된 것"만 보인다.
    """
    if not await _is_org_admin(db, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")

    from app.models.conversation import Conversation, ConversationMessage
    from app.services.member_resolver import lookup_members_by_ids

    rows = (await db.execute(
        select(ConversationMessage)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(
            Conversation.org_id == org_id,
            ConversationMessage.msg_metadata["event"]["event_key"].astext == definition_key,
        )
        .order_by(ConversationMessage.created_at.desc())
        .limit(limit)
    )).scalars().all()

    sender_ids = {r.sender_id for r in rows if r.sender_id is not None}
    members = await lookup_members_by_ids(sender_ids, db)

    return [
        EventPublishHistoryItem(
            id=str(r.id),
            conversation_id=str(r.conversation_id),
            sender_id=str(r.sender_id) if r.sender_id else None,
            sender_name=members[r.sender_id].name if r.sender_id in members else None,
            created_at=r.created_at,
        )
        for r in rows
    ]
