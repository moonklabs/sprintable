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
import re
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, ValidationInfo, field_validator
from sqlalchemy import String, and_, cast, delete, func, or_, select, text, update
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
from app.services.agent_onboarding_config import resolve_locale_from_request
from app.services.i18n_catalog import t
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
        # story #2530(2026-08-24, agent_gateway.py::wake_agent과 형제 결함·동일 처방) —
        # 예전엔 QueueFull이 그 큐(연결)를 `_agent_connections`에서 통째로 제거하는
        # 신호였다: 스트림 자체는 안 끊긴 채("연결은 살아 보이는" 상태) 이 member로 오는
        # 모든 이후 push가 이 연결을 dict에서 영원히 못 찾아 조용히 no-op되는 반쪽 상태가
        # 코드로 가능했다. 처방: 큐를 ring-buffer로 다뤄 가장 오래된 항목을 버리고 자리를
        # 만들어 이번 payload를 넣는다 — 연결을 절대 dict에서 지우지 않는다. A계열(event_id
        # 有)은 재연결 시 DB backfill로 회수되니 무해·B계열(transient) 1건 유실은 발생할 수
        # 있으나, 예전처럼 "연결 자체가 사라져 그 뒤 전부 유실"보다는 항상 개선(strict
        # improvement) — 연결이 dict에 남아있는 한 다음 push부터는 정상 도달한다.
        for q in list(queues):
            try:
                # story #3029(카디르+codex 발견, #3447 QA) — 이 member의 모든 큐에 **같은
                # dict 객체**를 넣으면, generate()의 라이브 루프가 그 객체에서
                # `_sse_transient_id`를 pop()할 때(#2158) 공유 객체라 다른 연결 큐에 든
                # "같은" 항목에서도 키가 사라진다 — 두 번째로 처리되는 연결은 원본 id를
                # 잃고 즉석 uuid4를 새로 발급해, 그 연결이 재연결 후 Redis replay로 같은
                # 이벤트를 원본 id로 받으면 라이브 때 발급한 가짜 id와 안 맞아 클라
                # dedup이 무력화된다(3026과 같은 "다중 연결" 문제군의 B계열 발현). 큐마다
                # 독립 객체를 넣어(얕은 복사 — payload 값 자체는 불변으로 다뤄지므로 얕은
                # 복사로 충분) 한 연결의 pop이 다른 연결의 사본에 안 번지게 한다.
                q.put_nowait(dict(payload))
                pushed = True
            except asyncio.QueueFull:
                logger.warning(
                    "_push_to_agent: queue full(maxsize=%d) for member=%s — dropping oldest "
                    "pending payload to make room (connection kept registered, not discarded)",
                    q.maxsize, member_id,
                )
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(dict(payload))
                    pushed = True
                except asyncio.QueueFull:
                    # 극단적 경합 — 이번 push만 포기(무한 재시도 금지). 연결은 dict에 남아
                    # 다음 push부터 정상 도달(agent_gateway.py wake_agent과 동일 근거).
                    pass
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


def _should_skip_live_event(eid: str | None, sent_event_ids: set[str]) -> bool:
    """story #3026 — 라이브 루프의 pre-yield dedup 판단을 순수함수로 뽑아 직접 단위테스트
    가능하게 한다(generate()는 클로저라 직접 호출 불가). `sent_event_ids`는 **연결-로컬**
    집합이어야 한다 — 이 함수 자체는 그 계약을 강제하지 않으므로(순수함수라 호출자 책임),
    호출부(generate())가 매 연결마다 새 집합을 만들어 넘기는 것으로 보장한다. 예전엔 이
    판단을 `Event.status`(DB, org 전체 공유)로 했다 — 같은 member의 다른 연결이 먼저
    yield하면 이 함수 상당 로직이 전역적으로 "이미 처리됨"을 봐서, 자기 큐에 항목이 와
    있는 다른 연결까지 전부 skip시켰다(#3026 실사고 근본원인, 968fe78d 실측). 연결-로컬
    집합으로 바꾸면 그 결함이 구조적으로 성립 안 한다."""
    return bool(eid) and eid in sent_event_ids


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

async def _resolve_stream_member(
    auth: AuthContext, member_id: uuid.UUID | None, org_id: uuid.UUID, db: AsyncSession,
) -> uuid.UUID:
    """/events/stream 구독자 신원 게이트 — 통과하면 구독할 member id, 아니면 HTTPException.

    story #4178(PO CHANGES) — 엔드포인트와 테스트가 같은 함수를 부르도록 뽑았다(테스트가 이
    블록을 옮겨 적으면 원본이 바뀌어도 복제본만 초록으로 남는다). 판정 자체는 무변경."""
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
    member_row = await resolve_member_identity(resolved_member_id, org_id, db)
    if member_row is None:
        raise HTTPException(status_code=404, detail="Member not found")

    # AC4: JWT 사용자는 자신의 신원(user_id 일치)에만 구독 허용
    if not is_api_key:
        if member_row.user_id is None or str(member_row.user_id) != auth.user_id:
            raise HTTPException(status_code=403, detail="Cannot subscribe to another member's stream")
    return resolved_member_id


@router.get("/stream")
async def agent_event_stream(
    request: Request,
    # AC2: API key 시 자동 추출, JWT 시 필수
    member_id: uuid.UUID | None = Query(
        default=None,
        description=(
            "Member to subscribe. Omit for API key sessions (the key's member is used). "
            "Required for human (JWT) sessions: use `org_member_id` from GET /api/v2/auth/me, "
            "called with the same X-Org-Id header (both endpoints resolve the org the same way)."
        ),
    ),
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

    async with async_session_factory() as db:
        resolved_member_id = await _resolve_stream_member(auth, member_id, org_id, db)

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
        # story #3026(실사고, PO 확定 2026-08-24) — 이 연결이 실제로 클라에 내보낸(yield
        # 성공한) A계열(eid 有) event_id 집합. **연결-로컬**이다(다른 연결과 공유 안 함) —
        # 이게 이 스토리의 핵심 처방. 예전엔 이 dedup을 `Event.status`(DB, org 전체 공유
        # 상태)로 판별해 "같은 member의 다른 연결(다른 탭·프로브·잔존 연결)이 먼저 yield해
        # delivered로 찍으면 나머지 연결 전부가 스킵"되는 결함이 있었다(동시 연결 N개 중
        # 1개만 실제 갱신 — 968fe78d 실사고 실측, delivered_at 편차 +0.1s~+103s). `_push_to_
        # agent`의 fan-out(멤버의 모든 큐에 push) 자체는 정상이었으므로, 문제는 순전히 "누가
        # 이미 봤나"를 연결이 아니라 이벤트 자체에 물었던 것 — 연결-로컬 집합으로 바꾸면
        # 같은 연결 내 중복(백필+라이브 겹침)은 그대로 막히면서, 다른 연결은 서로 완전히
        # 독립적으로 판단해 진짜 fan-out이 된다. `Event.status`/`delivered_at` DB 마킹
        # 자체는 그대로 유지(백필 원칙 — "재연결 시 이미 delivered여도 다시 준다"는 이
        # 값을 재연결 커서 판정에 계속 쓴다, 라이브 dedup의 판단 근거로만 안 쓸 뿐).
        _sent_event_ids: set[str] = set()
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
                        # story #3026 — 이 연결이 백필로 이미 내보낸 id. 아래 라이브 루프의
                        # 큐에 같은 event_id가 겹쳐 들어와도(레이스 윈도우) 이 연결에서 또
                        # 안 보낸다(연결-로컬 dedup, DB 공유상태 아님).
                        _sent_event_ids.add(str(evt.id))
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
                        # story #3026 — dedup 판단은 이 연결이 이미 보냈는지(연결-로컬
                        # `_sent_event_ids`)만 본다. ⚠️예전엔 여기서 `Event.status`(DB, org
                        # 전체 공유)를 조회해 "이미 delivered"면 skip했는데, 그러면 같은
                        # member의 다른 연결이 먼저 yield한 순간 **이 연결은 자기 큐에 항목이
                        # 와 있어도 영원히 못 보낸다**(동시 다중 탭 중 1개만 갱신되는 실사고
                        # 근본원인, 968fe78d 실측). 연결-로컬 판단으로 바꾸면 그 결함이
                        # 구조적으로 성립 안 한다 — 부수로 매 라이브 이벤트마다의 DB 왕복도
                        # 없앴다(hot-path DB 0, #2158 B계열과 동일 원칙을 A계열에도 적용).
                        eid = event_data.get("event_id")
                        if _should_skip_live_event(eid, _sent_event_ids):
                            continue  # 이 연결이 이미 보낸 id(백필 또는 이전 라이브) — 중복 skip.
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
                        # story #3026 — 이 연결이 방금 보낸 id를 기록(연결-로컬, 위 pre-yield
                        # 체크가 읽는 그 집합). yield가 여기까지 왔다는 건 이미 성공했다는
                        # 뜻이라 실패 시 기록 안 남는 걱정은 없다(아래 DB 마킹과 동일 순서
                        # 원칙 — "성공 후에만" 기록).
                        if eid:
                            _sent_event_ids.add(eid)
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
        response.headers["X-Result-Count"] = str(len(events))
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
    # story #2935(설계 doc steer-event-axis-design-2927 §2) — 발행 대상 conversation을
    # 호출자가 직접 지정(예: composer가 "지금 보는 스레드"에 STEER 지시를 남기는 경우).
    # 지정되면 _get_or_create_event_conversation의 참가자-집합 자동계산을 건너뛰고 그
    # conversation에 바로 발행한다. None이면(기존 호출부 전부) 현행 동작 그대로 — additive,
    # 무회귀. escalation 대상이 그 conversation의 실 참가자가 아니면 422로 거부한다(doc
    # "⚠️§2 보강" — fail-closed, 조용한 미도달 방지).
    conversation_id: uuid.UUID | None = None


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


def _generic_event_message_lines(definition_key: str, payload: dict) -> list[str]:
    """P2(story #2637)의 block_template 렌더러가 상륙하기 전 제네릭 폴백 — model.py docstring의
    "템플릿 없으면 제네릭 카드"와 동형 원칙을 메시지 본문 레벨에서 지금 구현. 필드 순서는
    payload dict 삽입 순서(파이썬 3.7+ 보장) 그대로 — 임의 정렬로 무의미하게 흔들지 않는다."""
    lines = [f"[이벤트] {definition_key}"]
    lines += [f"- {k}: {v}" for k, v in payload.items()]
    return lines


async def _render_event_notification_work_item_ref(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID,
) -> dict | None:
    """work_item을 클릭되는 참조 토큰으로(story #3313 AC2·story #3884 AC1로 확장).

    두 판별을 **구조로** 갈라 반환한다(story #3884 AC1(d), PO 확定 2026-09-14 15:51Z —
    "구조적 부재"와 "실패"가 같은 모양으로 나오면 FAIL):
    - 리졸버가 있는 타입(story/task/doc/visual_artifact)인데 그 id가 없음(삭제·조직 밖 등):
      `{"found": False, "type": work_item_type}` — **텍스트를 굽지 않는다**, 호출부(FE
      event-block-card.tsx)가 렌더 시점에 `t('eventCard.targetMissing', {type})`로 그린다
      (문구가 읽는 사람 로케일에 달렸기 때문 — story #3881과 같은 원칙).
    - 리졸버 자체가 없는 타입(agent_decision·support_escalation — 참조할 «엔티티» 개념이
      구조적으로 없음, gate 자체도 TARGET_ONLY #2889 그대로): `None` — 호출부가 refs 키를
      아예 안 심어 FE가 `optional: true` 필드 생략으로 처리한다.
    - 찾음: `{"found": True, "token": "[제목](entity:type:id)"}`.

    `work_item_type`("visual_artifact")과 참조 토큰 entity_type("artifact")이 갈리는 자리는
    `toEntityType()`(FE approval-request-card.tsx의 기존 매핑과 동형 — Gate.work_item_type
    어휘 vs embed-card entity_type 어휘가 다른, 2118에서 이미 확認된 차이)."""
    from app.services.reference_token import build_reference_token

    title: str | None = None
    entity_type = work_item_type
    if work_item_type == "story":
        from app.models.pm import Story

        title = (await db.execute(
            select(Story.title).where(
                Story.id == work_item_id, Story.org_id == org_id, Story.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
    elif work_item_type == "task":
        from app.models.pm import Task

        title = (await db.execute(
            select(Task.title).where(
                Task.id == work_item_id, Task.org_id == org_id, Task.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
    elif work_item_type == "doc":
        from app.models.doc import Doc

        title = (await db.execute(
            select(Doc.title).where(
                Doc.id == work_item_id, Doc.org_id == org_id, Doc.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
    elif work_item_type == "visual_artifact":
        from app.models.visual_artifact import VisualArtifact

        entity_type = "artifact"
        title = (await db.execute(
            select(VisualArtifact.title).where(
                VisualArtifact.id == work_item_id, VisualArtifact.org_id == org_id,
                VisualArtifact.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
    elif work_item_type == "epic":
        # story #3893 CHANGES②(PO 확認 2026-09-15) — preset.goal.measured의 goal_id(raw
        # UUID) 처방. `Goal`(구 Epic, app/models/pm.py)은 SoftDeleteMixin이 없어(grep
        # 실측) deleted_at 필터가 없다 — story/task/doc과 필터 개수가 다른 이유. FE
        # entity-ref.ts::parseEntityRef는 entityType을 검증 없이 그대로 통과시키고
        # embed-card.tsx가 'epic' 엔티티(RICH_PREVIEW_TYPES·getEntityHref 둘 다)를 이미
        # 지원한다(사전 확認 済 — 새 FE 렌더 경로 0).
        from app.models.pm import Goal

        title = (await db.execute(
            select(Goal.title).where(Goal.id == work_item_id, Goal.org_id == org_id)
        )).scalar_one_or_none()
    else:
        # agent_decision·support_escalation — 참조할 «엔티티» 개념이 구조적으로 없음
        # (gate.work_item_type 실사용 5종 中 2종, story #3884 AC1 그라운딩 실측).
        return None

    if not title:
        return {"found": False, "type": work_item_type}
    token = build_reference_token(entity_type, work_item_id, title)
    if not token:
        return {"found": False, "type": work_item_type}
    return {"found": True, "token": token}


async def _work_item_ref_token(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID,
) -> str | None:
    """평문 알림 줄(SSE·웹훅 등 구계통)용 얇은 어댑터 — story #3884가 확장한
    `_render_event_notification_work_item_ref`의 dict 반환에서 "찾음" 토큰만 뽑는다.
    found:False(삭제 등)·None(리졸버 없음) 둘 다 여기선 동일하게 폴백(raw id 표시, 호출부
    기존 동작 그대로)으로 합류한다 — 구계통은 대화 카드처럼 두 모양을 구분해 보여줄 표면이
    없다(평문 1줄, 회귀 0 유지가 목적)."""
    result = await _render_event_notification_work_item_ref(
        db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
    )
    if result and result.get("found"):
        return result.get("token")
    return None


async def _render_event_notification_member_ref(
    db: AsyncSession, *, org_id: uuid.UUID, member_id: uuid.UUID,
) -> dict | None:
    """story #3893(PO 確定 2026-09-14 20:07Z) — payload의 raw member UUID(예:
    `assignee_member_id`)를 표시 이름으로. `_render_event_notification_work_item_ref`와
    동형 계약(dict found-판별, 텍스트를 여기서 굽지 않는다)이되, member는 항상 단일
    리졸버(TeamMember/OrgMember, `resolve_member_display_name` 기존 SSOT 재사용 — 새
    조회 로직 0)라 "리졸버 자체가 없는 타입" 갈래가 없다(work_item의 3모양 中 2모양만
    성립):
    - 찾음: `{"found": True, "name": "표시 이름"}`
    - 못 찾음(탈퇴·삭제 등, 이름을 지어내지 않는다 원칙): `{"found": False}` — 호출부
      (event-block-card.tsx)가 렌더 시점 로케일로 문구를 짓는다(targetMissing과 동일
      원칙, 새 fail 텍스트를 여기서 굽지 않는다).

    참조 토큰(`[제목](entity:type:id)`)이 아니라 순 이름 문자열만 돌려준다 — member는
    work_item처럼 클릭 딥링크 대상이 아니다(PO 確定 — 「담당자=이름 해석」만, 토큰화
    요구 0)."""
    from app.services.member_resolver import resolve_member_display_name

    name = await resolve_member_display_name(member_id, org_id, db)
    if not name:
        return {"found": False}
    return {"found": True, "name": name}


async def _render_event_notification_doc_ref(
    db: AsyncSession, *, org_id: uuid.UUID, doc_id_raw: str,
) -> str | None:
    """story #3323 AC1/AC3 — payload의 `*_doc_id` 값(uuid 문자열)을 doc 클릭 참조 토큰으로.
    파싱 실패·같은 org에 존재하지 않는 doc은 None(지어내지 않음 — 호출부가 raw 값 폴백)."""
    from app.models.doc import Doc
    from app.services.reference_token import build_reference_token

    try:
        doc_id = uuid.UUID(str(doc_id_raw))
    except (ValueError, AttributeError, TypeError):
        return None
    title = (await db.execute(
        select(Doc.title).where(Doc.id == doc_id, Doc.org_id == org_id)
    )).scalar_one_or_none()
    if not title:
        return None
    return build_reference_token("doc", doc_id, title)


# story #3323 — previous_output_doc_id는 일반 *_doc_id 토큰화와 같은 해소·폴백 규칙을 따르되
# (present+해소 실패 시 raw 폴백, 부재 시 줄 자체 없음 — AC1/AC3 공통), 사람이 읽는 레이블만
# 「앞 단계 산출물」로 특별 표기한다(승인자가 «이게 뭘 검토하는지» 한눈에 보게, 처방 1).
_DOC_ID_PAYLOAD_LABELS: dict[str, str] = {"previous_output_doc_id": "앞 단계 산출물"}


# story #3329 — stage_metadata.action 같은 자유 문구 안에 "박힌" UUID/8자 prefix를 찾는다.
# ⚠️`\b`(Python re 기본 Unicode 워드 경계)는 한글을 워드 문자로 쳐서 "20808e14의"처럼
# hex 뒤에 한글 조사가 바로 붙으면 경계가 안 생겨 매치 자체가 실패한다(실측 확인, 이
# 스토리의 정확히 그 실패 사례) — 그래서 ASCII 영숫자만 보는 lookaround로 직접 짠다.
# 전체 UUID를 8자 alt보다 먼저 두어, 8자 alt가 UUID의 첫 세그먼트만 따로 집어가지
# 않게 한다(추가로 8자 alt는 뒤에 `-`가 오면 자체적으로 제외 — 이중 방어).
_EMBEDDED_FULL_UUID_RE = re.compile(
    r"(?<![0-9a-zA-Z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-zA-Z])",
    re.IGNORECASE,
)
_EMBEDDED_HEX8_RE = re.compile(
    r"(?<![0-9a-zA-Z])[0-9a-f]{8}(?![0-9a-zA-Z-])",
    re.IGNORECASE,
)


async def _resolve_doc_or_story_by_id(
    db: AsyncSession, *, org_id: uuid.UUID, entity_id: uuid.UUID,
) -> tuple[str, str] | None:
    """entity_id가 이 org의 doc 또는 story로 실재하면 (entity_type, title). doc을 먼저 본다
    (story #3329 실사례가 doc뿐이나 AC 문구가 doc/story 둘 다 명시 — doc/story id가 서로
    겹칠 확률은 사실상 0이라 우선순위 자체는 결과에 영향 없음)."""
    from app.models.doc import Doc

    doc_title = (await db.execute(
        select(Doc.title).where(Doc.id == entity_id, Doc.org_id == org_id, Doc.deleted_at.is_(None))
    )).scalar_one_or_none()
    if doc_title:
        return ("doc", doc_title)

    from app.models.pm import Story

    story_title = (await db.execute(
        select(Story.title).where(Story.id == entity_id, Story.org_id == org_id, Story.deleted_at.is_(None))
    )).scalar_one_or_none()
    if story_title:
        return ("story", story_title)
    return None


async def _resolve_doc_or_story_by_hex8_prefix(
    db: AsyncSession, *, org_id: uuid.UUID, prefix: str,
) -> tuple[str, uuid.UUID, str] | None:
    """story #3329 AC2 — 8자 hex prefix는 그 자체로 유일하지 않을 수 있다. doc+story를 합쳐
    이 org에서 그 prefix로 시작하는 id가 **정확히 1건**일 때만 치환 대상으로 인정한다
    (0건="그런 거 없음"·2건 이상="어느 쪽인지 모름" — 둘 다 원문 유지가 안전하다, AC1
    "오탐 0"의 직접 구현). 대소문자 무관 매칭(id는 소문자로 저장되지만 문구엔 대문자로
    적혔을 가능성 방어)."""
    from app.models.doc import Doc
    from app.models.pm import Story

    like_pattern = f"{prefix.lower()}%"
    doc_rows = (await db.execute(
        select(Doc.id, Doc.title).where(
            Doc.org_id == org_id, Doc.deleted_at.is_(None),
            cast(Doc.id, String).like(like_pattern),
        )
    )).all()
    story_rows = (await db.execute(
        select(Story.id, Story.title).where(
            Story.org_id == org_id, Story.deleted_at.is_(None),
            cast(Story.id, String).like(like_pattern),
        )
    )).all()
    candidates: list[tuple[str, uuid.UUID, str]] = (
        [("doc", r.id, r.title) for r in doc_rows] + [("story", r.id, r.title) for r in story_rows]
    )
    if len(candidates) != 1:
        return None
    return candidates[0]


async def _async_regex_sub(pattern: "re.Pattern[str]", async_replacer, text: str) -> str:
    """`re.sub`의 async 버전 — stdlib엔 없다(콜백이 동기 함수만 허용). 매치를 순서대로
    돌며 각 자리를 `await async_replacer(match)`의 결과로 채운다(non-overlapping은
    `finditer`가 이미 보장)."""
    parts: list[str] = []
    last_end = 0
    for m in pattern.finditer(text):
        parts.append(text[last_end:m.start()])
        parts.append(await async_replacer(m))
        last_end = m.end()
    parts.append(text[last_end:])
    return "".join(parts)


def _protected_reference_token_spans(text: str) -> list[tuple[int, int]]:
    """PO 리뷰(PR#3713, 2026-09-02) — 이미 참조 토큰인 구간(`[제목](entity:type:id)`)의
    **제목 부분**엔 커밋 sha·다른 엔티티의 8자 prefix·전체 UUID가 우연히 들어있을 수 있다
    (정의 문구·스토리 제목에 sha 언급이 흔함). 그 구간까지 훑으면 "토큰 속 토큰"(중첩 마크다운
    링크로 구조가 깨짐)을 만든다 — 기존 하이픈 제외 방어(`(?![0-9a-zA-Z-])`)는 `entity:
    doc:XXXXXXXX-...`의 **첫 세그먼트만** 막지, 토큰 앞쪽 제목 텍스트는 못 막는다.

    파싱은 이 조직의 기존 SSOT(`mention_parser.py::_CHAT_TOKEN_RE` — FE `applyEntity`가
    만드는 정확한 토큰 모양, escape된 대괄호까지 인식하도록 여러 사고를 거쳐 다듬어진 정규식)를
    그대로 재사용한다(새 정규식 발명 0). 호출부가 이 span 안에서 시작하는 매치를 스킵한다."""
    from app.services.mention_parser import _CHAT_TOKEN_RE

    return [(m.start(), m.end()) for m in _CHAT_TOKEN_RE.finditer(text)]


def _starts_within_spans(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(start <= pos < end for start, end in spans)


async def _tokenize_embedded_entity_refs(db: AsyncSession, *, org_id: uuid.UUID, text: str) -> str:
    """story #3329 — stage_metadata.action 같은 자유 문구 안에 박힌 org 내 doc/story
    UUID(전체 또는 8자 prefix)를 클릭 참조 토큰으로 치환한다. 실재하는 엔티티로 해소될
    때만 바꾸고(없으면·모호하면 원문 그대로 둔다) — AC1 "오탐 0"의 직접 구현. 전체 UUID
    패스를 먼저 끝내고 나서 8자 prefix 패스를 돈다.

    PO 리뷰(PR#3713) — 각 패스 직전에 `_protected_reference_token_spans`로 "이미 토큰인
    구간"을 다시 계산해, 그 구간 **안에서 시작하는** 매치는 건드리지 않는다. 전체 UUID
    패스는 원문 기준 보호구간(원문에 이미 있던 토큰의 제목 안 UUID 방어) — 8자 prefix
    패스는 **전체 UUID 패스가 끝난 뒤의 텍스트** 기준으로 보호구간을 다시 계산한다(방금
    만든 새 토큰의 제목 안 8자 hex까지 함께 방어 — 재계산이 핵심, 원문 기준 보호구간을
    재사용하면 새로 생긴 토큰은 못 막는다)."""
    from app.services.reference_token import build_reference_token

    protected = _protected_reference_token_spans(text)

    async def _replace_full(match: re.Match) -> str:
        raw = match.group(0)
        if _starts_within_spans(match.start(), protected):
            return raw
        try:
            entity_id = uuid.UUID(raw)
        except ValueError:
            return raw
        resolved = await _resolve_doc_or_story_by_id(db, org_id=org_id, entity_id=entity_id)
        if resolved is None:
            return raw
        entity_type, title = resolved
        return build_reference_token(entity_type, entity_id, title) or raw

    text = await _async_regex_sub(_EMBEDDED_FULL_UUID_RE, _replace_full, text)

    protected = _protected_reference_token_spans(text)

    async def _replace_prefix(match: re.Match) -> str:
        raw = match.group(0)
        if _starts_within_spans(match.start(), protected):
            return raw
        resolved = await _resolve_doc_or_story_by_hex8_prefix(db, org_id=org_id, prefix=raw)
        if resolved is None:
            return raw
        entity_type, entity_id, title = resolved
        return build_reference_token(entity_type, entity_id, title) or raw

    return await _async_regex_sub(_EMBEDDED_HEX8_RE, _replace_prefix, text)


def _stage_capability_kind(stage_meta: dict | None) -> str | None:
    """stage_metadata[stage].capability.kind 읽기 공용 — 멘션 도구 안내(`_CAPABILITY_KIND_HINTS`)·서버 몫 다음 단계 판별
    (story #4174)·블로그 레시피 문맥 판별(`resolve_site_post_recipe_context`)이 같이 쓴다. capability가 없거나 dict가
    아니면 None."""
    capability = (stage_meta or {}).get("capability")
    return capability.get("kind") if isinstance(capability, dict) else None


def _next_recipe_stage(definition, stage: str) -> str | None:
    """story #4076 — `definition.payload_schema.properties.stage.enum`에서 `stage` 바로
    다음 원소. `_render_event_message_content`(사이클 렌더러)·`_render_gate_verdict_message`
    (판정 렌더러) 둘 다 같은 계산을 쓴다 — 공유 추출, 드리프트 금지(PR11 `_captured_spend_
    minor_for_gate` 선례 동형)."""
    enum = ((definition.payload_schema.get("properties") or {}).get("stage") or {}).get("enum") or []
    if stage not in enum:
        return None
    idx = enum.index(stage)
    return enum[idx + 1] if idx + 1 < len(enum) else None


def _next_stage_publish_payload_json(definition, next_stage: str, base_payload: dict) -> str:
    """story #4076 — `next_stage`로 넘어가는 `publish_event` 호출의 JSON 페이로드만(라벨·
    "publish_event(" 감싸기는 호출부가 i18n_catalog 문구로 한다 — BE 한글 사용자 문장 가드
    #3779가 라벨 literal도 AST로 잡으므로, 라벨은 이 함수가 아니라 카탈로그 쪽에 둔다).
    `base_payload`의 기존 키(`stage` 제외)를 그대로 이어받아 실값 예시를 만든다(스키마만이
    아니라 실제로 복붙 가능한 예시 — AC3)."""
    next_payload = {k: v for k, v in base_payload.items() if k != "stage"}
    next_payload["stage"] = next_stage
    return json.dumps({"definition_key": definition.key, "payload": next_payload}, ensure_ascii=False)


async def _resolve_sealed_field_specs_and_payload(
    db: AsyncSession, org_id: uuid.UUID, next_gate_decl: dict | None, base_payload: dict,
) -> tuple[tuple, dict]:
    """story #4085 AC1 공유 — 자기설명 사이클 렌더러(`_render_event_message_content`)·
    게이트 판정 렌더러(`_render_gate_verdict_message`) 둘 다 "다음 stage가 게이트를
    여는 자리인가"를 같은 사실로 답해야 한다(recipe_gate_hooks.py::_GATE_TYPE_
    SEALED_FIELDS SSOT, 레시피 키·stage 하드코딩 0). `next_gate_decl`이 봉인 필드를
    요구하면 그 스펙들과, 예시 payload에 실값 예시를 채운 버전을 함께 반환한다
    (base_payload에 이미 같은 키가 있으면 안 덮는다 — 우연한 동명 키 보존).

    ⛔story #4085(페드루 PO 리뷰 정정, PR #4461 코멘트) — 두 렌더러가 처음엔 이
    구성을 각자 인라인으로 복제했다가(사이클 쪽만 실제로 착지) 판정 렌더러 쪽이
    빠진 채 merge돼 2호 실측에서 재발했다 — 공유 함수 하나로 합쳐 드리프트 자체를
    구조로 막는다."""
    from app.services.recipe_gate_hooks import _GATE_TYPE_SEALED_FIELDS, sealed_field_example

    specs = _GATE_TYPE_SEALED_FIELDS.get(next_gate_decl["type"], ()) if next_gate_decl is not None else ()
    if not specs:
        return specs, base_payload
    # story #4191 — 시각 예시는 조직 시간대로 계산한다(시각 필드가 있을 때만 조회).
    org_timezone = None
    if any(spec.kind == "datetime" for spec in specs):
        from app.services.org_time import get_org_timezone

        org_timezone = await get_org_timezone(db, org_id)
    enriched_payload = {
        **{
            spec.name: sealed_field_example(spec, org_timezone=org_timezone)
            for spec in specs if spec.name not in base_payload
        },
        **base_payload,
    }
    return specs, enriched_payload


# story #4090/#4093/#4142 공유 — gate.publish_outcome(닫힌 어휘 코드)을 "다음 행동" 한
# 줄로 번역한다. `_render_gate_verdict_message`의 두 표면이 같은 변환을 쓴다: ① 다음
# stage가 채널 자동발행 대상인 게이트의 승인 안내(#4090 AC3) ② scoped channel_post
# 게이트 자신의 승인 안내(#4142 AC3 — «발행은 휴먼이 화면에서 해요»가 실제로는 자동
# 발행되는 채널에도 잘못 뜨던 결함). 지어내지 않는다 원칙 — 실제 publish_outcome 값
# 그대로만 반영.
def _recipe_auto_publish_outcome_line(outcome: str | None, resolved_locale: str) -> str:
    if outcome == "published":
        return t("events.gate_verdict_recipe_auto_published", resolved_locale)
    # story #4142(페드루 PO 처방, 2026-09-22) — 비동기 컨테이너(REELS 등)가 아직 완결
    # 안 된 비최종 상태. "이미 발행됐어요"라고 지어내지 않는다.
    if outcome == "publishing":
        return t("events.gate_verdict_recipe_auto_publish_processing", resolved_locale)
    if outcome == "scheduled":
        return t("events.gate_verdict_recipe_auto_publish_scheduled", resolved_locale)
    if outcome:
        # story #3779 정정 — gate.publish_outcome은 닫힌 어휘 코드(한글 완성 문장
        # 아님). 여기서 코드→locale 문구로 번역한다.
        _reason_key_map = {
            "no_channel_binding": "events.gate_verdict_recipe_auto_publish_reason_no_channel",
            "no_submitted_draft": "events.gate_verdict_recipe_auto_publish_reason_no_draft",
            "no_resolver": "events.gate_verdict_recipe_auto_publish_reason_no_resolver",
        }
        # story #4090/#4093 정정 — "publish_failed:<code>"의 <code>도 닫힌 어휘라 그
        # 코드도 별도 키로 번역한다(커넥터 원문 미노출, 미지 코드는 제네릭 폴백).
        _failure_reason_key_map = {
            "connector_error": "events.gate_verdict_recipe_auto_publish_reason_connector_error",
            "rate_limited": "events.gate_verdict_recipe_auto_publish_reason_rate_limited",
            "auth_expired": "events.gate_verdict_recipe_auto_publish_reason_auth_expired",
        }
        if outcome in _reason_key_map:
            _reason_text = t(_reason_key_map[outcome], resolved_locale)
        elif outcome.startswith("publish_failed:"):
            _failure_code = outcome[len("publish_failed:"):]
            _failure_key = _failure_reason_key_map.get(_failure_code)
            _reason_text = (
                t(_failure_key, resolved_locale) if _failure_key
                else t("events.gate_verdict_recipe_auto_publish_reason_unknown_failure", resolved_locale)
            )
        else:
            _reason_text = t("events.gate_verdict_recipe_auto_publish_reason_unknown_failure", resolved_locale)
        return t("events.gate_verdict_recipe_auto_publish_skipped", resolved_locale, reason=_reason_text)
    return t("events.gate_verdict_recipe_auto_publish_pending", resolved_locale)


async def _render_gate_verdict_message(
    db: AsyncSession, *, org_id: uuid.UUID, payload: dict, resolved_locale: str = "ko",
) -> str:
    """story #3330 — `preset.gate.verdict` 전용 렌더. 승인/반려 대상 work item·게이트
    종류·판정·(반려 시) 사유·대상 산출물 doc 클릭 토큰·다음 행동을 담는다(AC2, #3323이
    stage 알림에 한 것과 같은 규격). `preset.gate.verdict`는 `stage_metadata`가 없는
    비사이클형 정의라 `_render_event_message_content`의 사이클 분기를 안 타므로 별도
    함수로 둔다.

    draft_doc_reference_token은 payload 계약에 없다(스키마 변경 0, AC4 "새 경로 발명
    0") — `recipe_gate_hooks.py::_build_approval_neutral_facts`가 게이트 생성 시점에
    이미 계산해 둔 `neutral_facts`를 게이트 행 재조회로 그대로 재사용한다(새로 계산
    안 함)."""
    from app.models.gate import Gate
    from app.services.gate_reason_signal import has_discontinue_signal

    work_item_type = payload.get("work_item_type")
    work_item_id_raw = payload.get("work_item_id")
    gate_type = payload.get("gate_type")
    verdict = payload.get("verdict")
    resolution_note = payload.get("resolution_note")

    work_item_id: uuid.UUID | None = None
    if work_item_id_raw:
        try:
            work_item_id = uuid.UUID(str(work_item_id_raw))
        except (ValueError, AttributeError, TypeError):
            work_item_id = None

    lines = ["[이벤트] preset.gate.verdict"]

    work_item_ref: str | None = None
    if work_item_type and work_item_id is not None:
        work_item_ref = await _work_item_ref_token(
            db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
        )
    if work_item_ref:
        lines.append(f"- work item: {work_item_ref}")
    elif work_item_id_raw:
        lines.append(f"- work_item_id: {work_item_id_raw}")

    lines.append(f"- 게이트: {gate_type} → {verdict}")
    # story #3370 AC2(유나 실측 2026-09-10 13:23Z) — 게이트가 종류로만 표기되고 있었다
    # (gate_id는 아래 재조회 대상으로만 쓰이고 사람이 읽는 줄로는 한 번도 안 나갔다).
    # 에이전트 표면(이 함수)이 AC2의 「gate ID」 요구를 실제로 충족하려면 값 자체를 찍어야
    # 한다 — payload에 항상 있음(story #3487, 이 함수의 유일한 발행부가 항상 채움).
    gate_id_raw = payload.get("gate_id")
    if gate_id_raw:
        lines.append(f"- gate_id: {gate_id_raw}")

    # story 1cd72bfc(2026-09-02, 담롱 4바퀴 승인 실측·PO 확定) — 이전엔 verdict=="rejected"
    # 게이트가 있어 승인(approved) 판정에 사유가 있어도(예: "Ddddd") 원천 차단됐다.
    # 에이전트 표면(MCP message.content)에서는 이 함수가 사유 노출의 전부다(사람 표면인
    # block_template의 "사유" 필드는 별개 — chat-bubble.tsx event-block-card, 이 스토리
    # 스코프 밖). 값 없으면 줄 자체를 생략(승인·반려 공통 — 지어내지 않는다).
    if resolution_note:
        lines.append(f"- 사유: {resolution_note}")

    draft_doc_ref: str | None = None
    draft_id: str | None = None
    version_id: str | None = None
    # story #3359 — 레시피 stage 게이트의 neutral_facts엔 게이트 생성 시점(recipe_gate_
    # hooks.py::_build_approval_neutral_facts)에 이미 stage/channel이 박혀 있다. 이
    # payload 자체엔 없어(preset.gate.verdict 계약 불변) 아래 gate_row 재조회에서만
    # 채워진다 — publish 다음-행동 문구를 채널별 커넥터명으로 구체화하는 데 쓴다.
    gate_stage: str | None = None
    gate_channel: str | None = None
    # story #4076 — gate_row.neutral_facts["triggered_by_event"]는 이 게이트를 만든 recipe
    # 정의의 key(recipe_gate_hooks.py:188 `_build_approval_neutral_facts`가 게이트 생성
    # 시점에 이미 찍어 둔다, 새 계산 0). ④ 구체 발행 예시가 이 값으로 정의를 재조회한다 —
    # 이 필드가 없는 옛 게이트 row(그 주석이 추가되기 전에 생성된 게이트)는 None 그대로
    # 남아 아래에서 기존 제네릭 문구로 폴백한다(크래시 대신 폴백, PO 확定).
    triggered_by_event_key: str | None = None
    gate_row = None
    # story #3487(0329) — payload에 gate_id가 있으면(이 함수의 유일한 발행부는 항상
    # 채운다) 그 행만 정확히 읽는다. story #3478(gate.scope_key) 이후 같은 work_item에
    # 목적지가 다른 external_publish 게이트가 둘 이상일 수 있어, 아래 (work_item_id,
    # gate_type, status) 재조회+`order_by(resolved_at desc).limit(1)`는 "가장 최근
    # resolved"인 게이트를 고르는 것이지 "지금 이 이벤트가 말하는" 그 게이트가 아니다
    # — 옛 payload(gate_id 없음, 레거시 큐 재생 등)에 대한 하위호환 폴백으로만 유지.
    # (gate_id_raw는 위에서 이미 구했다 — 「gate_id:」 줄과 이 재조회가 같은 값을 쓴다.)
    if work_item_type and work_item_id is not None and gate_type:
        if gate_id_raw:
            try:
                gate_row = await db.get(Gate, uuid.UUID(str(gate_id_raw)))
            except (ValueError, TypeError, AttributeError):
                gate_row = None
        else:
            gate_row = (await db.execute(
                select(Gate).where(
                    Gate.org_id == org_id, Gate.work_item_id == work_item_id,
                    Gate.work_item_type == work_item_type, Gate.gate_type == gate_type,
                    Gate.status == verdict,
                ).order_by(Gate.resolved_at.desc()).limit(1)
            )).scalar_one_or_none()
        if gate_row is not None:
            facts = gate_row.neutral_facts or {}
            triggered_by_event_key = facts.get("triggered_by_event")
            token = facts.get("draft_doc_reference_token")
            if token and token != "미확認":
                draft_doc_ref = token
            # story #3387 — site_posts.py 흐름(external_publish)이 stamp한 draft_id.
            # 레시피 흐름의 draft_doc_reference_token과는 상호배타(한 게이트가 두 흐름
            # 모두에서 만들어지지 않는다) — 링크가 아니라 참조로만 싣는다(PO 2026-09-03
            # 13:33Z, 실행 권유 아님).
            draft_id = facts.get("draft_id")
            # story #3370 AC2(유나 실측 2026-09-10 13:23Z) — draft_id(초안 자체 식별)와
            # version_id(그 초안 중 «이번에 봉인·판정된» 특정 버전)는 다른 축이다. 이전엔
            # version 자리가 아예 없어 draft_id를 version처럼 오독할 여지가 있었다 —
            # site_posts.py/channel_posts.py의 submit/reseal 훅이 neutral_facts에 새로
            # stamp한 값(gate.sealed_content_sha256과 동시에 찍히는, 그 sha256이 가리키는
            # 실제 버전 행의 id)을 그대로 읽는다.
            version_id = facts.get("version_id")
            gate_stage = facts.get("stage")
            _channel_raw = facts.get("channel")
            gate_channel = _channel_raw if isinstance(_channel_raw, str) and _channel_raw and _channel_raw != "미확認" else None
    if draft_doc_ref:
        lines.append(f"- 대상 산출물: {draft_doc_ref}")
    if draft_id:
        lines.append(f"- draft_id: {draft_id}")
    if version_id:
        lines.append(f"- version_id: {version_id}")

    # story #3387(결함·오도 문구, PO 2026-09-03 13:33Z 스코프 확定) — gate_type=
    # external_publish는 이 아래 레시피 전용 문구(다른 gate_type용, 변경 없음)를 타지
    # 않는다. 담롱 실사례 5건(온찬 eb9e797d) 전부 이 분기의 옛 문구와 문자 그대로
    # 일치했다 — verdict만 보고 gate_type을 안 봐 "발행 도구"(제품에 없음)를 approved에
    # 권하고, rejected엔 사유 무관 재상신을 권해 «폐기 대상» 반려와 정면으로 모순됐다.
    #
    # 유나 8칸 표(2026-09-03) 중 에이전트 칸(3·4·6·8)만 여기서 구현한다 — 휴먼 칸
    # (1·2·5·7)은 이 함수의 스코프 밖(agent-only MCP 표면, 휴먼 3표면엔 다음 행동 문구를
    # 신설하지 않기로 PO가 확定, 화면 실 버튼이 있는데 문구를 더하면 새 오도 자리가 된다).
    # 실행 동사 0건 규율: "할 일 없음"으로 시작 — 이 표면 수신자는 항상 에이전트라
    # "누르세요/쓰세요/발행하세요"류를 전부 금지한다(사람 표면 버튼과 헷갈릴 여지 자체를
    # 없앤다).
    if gate_type == "external_publish":
        if verdict == "approved":
            # story #3487(PO 실측 2026-09-05) — 옛 문구("발행은 휴먼이 화면에서 합니다")는
            # site_post(외부 목적지·hosted_site 공통)의 실동작과 어긋난다: 승인 훅이
            # publication_command를 즉시 만들고 **다음 워커 tick(최대 1분)이 어댑터를
            # 호출**한다 — 휴먼 화면의 발행 버튼은 이미 completed된 command를 멱등
            # 반환할 뿐(회수만 화면 액션이 실제로 필요). channel_post(예약 상신)는
            # scheduled_at 시각에 발행되는 게 이미 맞는 문구라 무변(회귀 pin, AC2).
            # draft_id가 site_post_drafts에 있는지로 도메인을 가른다 — destination
            # 문자열(hosted_site/wordpress/webhook vs threads)에 기대는 것보다
            # 채널 목록이 늘어나도 안 깨지는 축이다.
            #
            # story #3369 후속(자기점검 2차, 유나 실측·페드루 지시 2026-09-10) — 위
            # #3487 주석은 "hosted_site 공통"이라 적었지만 실제로는 아니다:
            # `gate_service.py::_maybe_create_scheduled_publication_command`가
            # `destination_channel == "hosted_site"`면 publication_command 생성을
            # 그 자리에서 건너뛴다("내부 동기 경로 그대로 — publication_command 불요").
            # 즉 hosted_site 승인은 워커가 자동으로 발행하지 않는다 — 휴먼이 여전히
            # 화면에서 «발행»/«재발행»을 직접 눌러야 한다. 이 표면의 수신자는 항상
            # 에이전트(위 주석)라, hosted_site draft에 옛 문구("다음 워커 tick에
            # 발행됩니다")를 그대로 보내면 에이전트가 "할 일 없음"으로 오판해 사람에게
            # 재발행이 필요하다는 것을 못 알릴 수 있다.
            #
            # story #4155 유나 CHANGES(2026-09-10) — 위 수정이 connection_id 유무를
            # 대리값으로 썼는데, `gate_service.py:1037-1072`엔 외부 목적지(connection_id
            # 있음)인데도 command를 안 만들고 return하는 경로가 6개(_mark_unresolved 5·
            # _mark_scope_mismatch 1 — scope mismatch는 설계된 도달 상태) 있어 그 경로
            # 에서도 이 대리값이 "명령이 만들어졌다"로 잘못 읽었다. 대리값을 버리고 실제
            # `PublicationCommand` 존재 여부를 직접 조회한다(gate_id로, 인덱스 有) — 이
            # 한 조회가 hosted_site(애초에 명령 자체가 없는 경로)와 외부-이지만-생성
            # 실패(위 6경로) 둘 다를 같은 방식으로 정확히 잡는다.
            is_site_post = False
            site_post_command_exists = False
            if draft_id:
                try:
                    draft_uuid = uuid.UUID(draft_id)
                except (ValueError, TypeError, AttributeError):
                    draft_uuid = None
                if draft_uuid is not None:
                    from app.models.site_post_draft import SitePostDraft
                    is_site_post = (await db.execute(
                        select(SitePostDraft.id).where(SitePostDraft.id == draft_uuid)
                    )).scalar_one_or_none() is not None
            if is_site_post and gate_row is not None:
                from app.models.publication_command import PublicationCommand
                site_post_command_exists = (await db.execute(
                    select(PublicationCommand.id).where(PublicationCommand.gate_id == gate_row.id)
                )).first() is not None
            # story #4142(페드루 PO 처방, 2026-09-22) — «발행은 휴먼이 화면에서 해요»가
            # 레시피 자동발행 대상 channel_post 게이트(scope_key=connection_id, #4090
            # AC2가 사람 클릭 0으로 처리)에도 잘못 뜨던 결함. 이 gate_row 자신이 scoped
            # external_publish 게이트일 때만, 그 연결을 트리거한 unscoped 게이트를
            # 거꾸로 찾아(#4093 리졸버 재사용 — 새 판별 로직 발명 0) 실제
            # publish_outcome을 그대로 반영한다. 못 찾으면(레시피 무관 수동 channel_post)
            # 기존 human_only 그대로 — 정말 사람이 눌러야 하는 경우까지 잘못 바꾸지
            # 않는다.
            # ⛔페드루 PO CHANGES-1(PR #4518 리뷰) — 실 Gate 행에선 scope_key/work_item_id
            # 둘 다 NOT NULL 컬럼(gate.py 62-85행)이라 getattr 방어는 프로덕션 코드에
            # 쓸 반창고가 아니라 mock 테스트더블(_FakeGateRow)을 살리려는 우회였다 —
            # 직접 접근으로 되돌리고, 테스트더블 쪽을 실 모양으로 채운다(4514에서 같은
            # 이유로 SimpleNamespace 목을 GateResponse.model_construct로 바꾼 선례와
            # 동형 원칙: 목을 실물에 맞추지, 실물을 목에 맞추지 않는다).
            _recipe_auto_publish_line: str | None = None
            # story #4149(리허설 2호 실측, 페드루 PO 確定 2026-09-22) — 위 #4142 분기는
            # gate_row 자신이 "scoped" channel_post 게이트(scope_key=connection_id)일
            # 때만 역방향 조회로 publish_outcome을 찾았다. 실측: 리허설 2호 게이트
            # 952fb0fd는 그 반대 축 — gate_row 자신이 unscoped 레시피 external_publish
            # 게이트(scope_key="")였고, gate.py publish_outcome 필드 자신의 계약("external_
            # publish 게이트(scope_key="", 레시피 unscoped 게이트)에서만 채워진다",
            # gate_service.py:1280 publish_recipe_approved_draft가 같은 트랜잭션에서 이미
            # 채워 둔다)대로 gate_row.publish_outcome을 새 조회 없이 그대로 읽으면 된다 —
            # 역방향 조회(resolve_recipe_context_for_scheduled_publication)는 애초에 이
            # 축(scope_key="") 전용이 아니다. 비레시피 external_publish 게이트(scope_key=""
            # 이지만 레시피 무관)는 publish_outcome이 계약대로 항상 None이라 이 분기가
            # 조용히 안 타고 기존 human_only로 그대로 폴백한다(회귀 0).
            if not is_site_post and gate_row is not None and not gate_row.scope_key and gate_row.publish_outcome:
                _recipe_auto_publish_line = _recipe_auto_publish_outcome_line(
                    gate_row.publish_outcome, resolved_locale,
                )
            elif not is_site_post and gate_row is not None and gate_row.scope_key:
                try:
                    _scope_connection_id = uuid.UUID(gate_row.scope_key)
                except (ValueError, TypeError, AttributeError):
                    _scope_connection_id = None
                if _scope_connection_id is not None:
                    from app.services.channel_posts import resolve_recipe_context_for_scheduled_publication

                    _recipe_ctx = await resolve_recipe_context_for_scheduled_publication(
                        db, org_id=org_id, work_item_id=gate_row.work_item_id,
                        connection_id=_scope_connection_id,
                    )
                    if _recipe_ctx is not None:
                        _recipe_gate, _recipe_def_key, _recipe_next_stage = _recipe_ctx
                        _recipe_auto_publish_line = _recipe_auto_publish_outcome_line(
                            _recipe_gate.publish_outcome, resolved_locale,
                        )
            # story #4174 — 블로그 레시피의 «발행 승인 대기» 단계에서 초안 게이트가 승인됐으면: 서버가 발행하고 레시피가
            # 다음 단계로 넘어간다(발행·이벤트는 story #4192). 판별은 resolve_site_post_recipe_context(4192와 같은 판정).
            _site_recipe_ctx = None
            if is_site_post and gate_row is not None:
                _site_recipe_ctx = await resolve_site_post_recipe_context(
                    db, org_id=org_id, work_item_type=gate_row.work_item_type, work_item_id=gate_row.work_item_id,
                    draft_id=(gate_row.neutral_facts or {}).get("draft_id"),
                )
            if _recipe_auto_publish_line is not None:
                lines.append(f"- {_recipe_auto_publish_line}")
            elif _site_recipe_ctx is not None:
                lines.append(f"- {t('events.gate_verdict_next_action_recipe_site_auto_publish', resolved_locale)}")
            elif is_site_post and site_post_command_exists:
                lines.append(f"- {t('events.gate_verdict_next_action_publish_command_created', resolved_locale)}")
            else:
                lines.append(f"- {t('events.gate_verdict_next_action_publish_human_only', resolved_locale)}")
        elif verdict == "rejected":
            # AC3 — 사유에 «폐기/중단» 신호가 있으면 다음 행동 자체를 비운다(침묵도
            # 문구다). 재상신을 권하면 카드가 사람의 결정과 정면으로 반대되는 행동을
            # 시킨다(스토리 관측 사례 5).
            if not has_discontinue_signal(resolution_note):
                lines.append("- 다음 행동: 할 일 없음 — 다시 올릴지는 작성자가 정합니다.")
    # 페드루 리뷰(PR#3711) — "approve 게이트를 다시 발행"은 실재하지 않는 동작(게이트는
    # 발행 대상이 아니라 이벤트 발행의 부산물)이라 최저 지능 에이전트가 그대로 따라도
    # 실패하지 않을 실제 동작으로 정정: rejected는 「산출물 수정→같은 정의의 approve
    # stage 이벤트 재발행(게이트는 그 발행에 자동 재오픈됨)」, approved는 「이 정의의
    # 다음 stage 이벤트 발행」. ⚠️story #3387 — 이 갈래는 external_publish 이외
    # gate_type 전용이다(회귀 0, 위에서 이미 갈라냈다).
    elif verdict == "rejected":
        lines.append(
            "- 다음 행동: 산출물을 수정한 뒤, 같은 레시피 정의의 approve stage 이벤트를 "
            "다시 발행하세요(payload.previous_output_doc_id=수정본 id) — 게이트는 그 "
            "발행으로 자동 재오픈됩니다."
        )
    elif verdict == "approved":
        # story #3359 — publish stage면 channel→connector_key를 리졸버로 구체화한다
        # (예전엔 "발행 도구를 쓰세요"뿐이라 모든 채널이 정의에 박힌 connector_key
        # 그대로 threads로 새는 클래스였다). publish가 아니거나 channel을 모르면
        # 기존 제네릭 문구 그대로(회귀 0).
        _connector_line: str | None = None
        if gate_stage == "publish" and gate_channel:
            from app.services.channel_connector_map import resolve_connector_key_for_channel

            _connector_key = await resolve_connector_key_for_channel(db, org_id=org_id, channel=gate_channel)
            if _connector_key:
                _connector_line = (
                    f"- 다음 행동: {_connector_key} 커넥터로 발행하세요(channel={gate_channel})."
                )
            else:
                _connector_line = (
                    f"- 다음 행동: channel={gate_channel}에 대한 커넥터 매핑이 없습니다 — "
                    "조직 설정에 channel_connector_map을 등록하세요."
                )
        # story #4076 — ④ 갭 처방: "다음 stage 이벤트를 발행하세요"뿐이던 자리를
        # triggered_by_event_key(위, gate_row.neutral_facts — 이 게이트를 만든 recipe
        # 정의)로 그 정의를 재조회해 구체 definition_key+payload 예시로 채운다(사이클
        # 렌더러 `_next_recipe_stage`/`_next_stage_publish_payload_json`과 동일 계산 재사용,
        # 새 로직 0). 키가 없는 옛 게이트 row·정의를 못 찾음·다음 stage가 없음(마지막
        # stage) 중 하나라도 걸리면 크래시 대신 기존 제네릭 문구로 폴백(PO 확定).
        _example_line: str | None = None
        if _connector_line is None and triggered_by_event_key and gate_stage:
            from app.models.event_definition import EventDefinition

            _recipe_definition = (await db.execute(
                select(EventDefinition).where(
                    EventDefinition.key == triggered_by_event_key,
                    EventDefinition.enabled.is_(True),
                    or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
                ).order_by(EventDefinition.org_id.is_(None)).limit(1)
            )).scalars().first()
            if _recipe_definition is not None:
                _next_stage = _next_recipe_stage(_recipe_definition, gate_stage)
                if _next_stage is not None:
                    _base_payload: dict = {"stage": gate_stage}
                    if work_item_type:
                        _base_payload["work_item_type"] = work_item_type
                    if work_item_id_raw:
                        _base_payload["work_item_id"] = work_item_id_raw
                    _next_meta = (_recipe_definition.stage_metadata or {}).get(_next_stage) or {}
                    # story #4085 AC1(2/2, 페드루 PO CHANGES — 2호 실측 재발) — 이 판정
                    # 렌더러는 자기설명 사이클 렌더러(`_render_event_message_content`)와
                    # 별개 표면인데, PR #4461은 사이클 쪽에만 봉인 필드 주입을 붙였다.
                    # `structure_approval`처럼 "지금 stage가 이미 자기 게이트를 여는"
                    # 경우(사이클 렌더러 스코프 B, 발행 예시 자체를 생략) 다음 stage
                    # (`structure_passed`)의 봉인 필드 안내는 오직 **이 승인-판정 알림**
                    # (사람이 그 게이트를 승인한 직후 댄이 받는 멘션)에서만 나온다 —
                    # 2호가 실제로 이 경로였다(구조 승인→예산 게이트 봉인 필드 안내 0).
                    # 같은 SSOT를 공유 헬퍼로 재사용(드리프트 재발 방지, 새 로직 0).
                    _sealed_specs, _example_base_payload = await _resolve_sealed_field_specs_and_payload(
                        db, org_id, _next_meta.get("gate"), _base_payload,
                    )
                    _example_json = _next_stage_publish_payload_json(_recipe_definition, _next_stage, _example_base_payload)
                    # story #4090 AC3(페드루 PO 確定 2026-09-21) — 다음 stage가 채널
                    # 자동발행 대상(capability.target=="channel_connection")이면 "다음
                    # stage 이벤트를 발행하세요" 지시 자체가 더는 맞지 않는다(AC2가 사람
                    # 클릭 0으로 자동 처리) — gate_row.publish_outcome(AC2 훅이 이미 채운
                    # 기계 소유 결과, transition_gate→publish_recipe_approved_draft가
                    # _render_gate_verdict_message보다 먼저 실행되므로 이 시점에 이미
                    # 값이 있다)을 그대로 안내문으로 쓴다 — 새 문구를 짓지 않고 AC2의
                    # 실제 결과를 그대로 반영(지어내지 않는다, PO 확定 반복 원칙).
                    if (_next_meta.get("capability") or {}).get("target") == "channel_connection":
                        _outcome = gate_row.publish_outcome if gate_row is not None else None
                        _example_line = f"- {_recipe_auto_publish_outcome_line(_outcome, resolved_locale)}"
                    else:
                        _example_line = (
                            f"- {t('events.gate_verdict_next_action_publish_example', resolved_locale, example=_example_json)}"
                        )
                        if _next_meta.get("gate") is not None:
                            _example_line += f" — {t('events.stage_gate_opens_on_publish', resolved_locale)}"
                            for _spec in _sealed_specs:
                                _example_line += f"\n- {t(_spec.explanation_catalog_key, resolved_locale)}"
        lines.append(
            _connector_line
            or _example_line
            or "- 다음 행동: 이 정의의 다음 stage 이벤트를 발행하세요(publish 단계라면 이 "
            "승인 게이트를 확인하는 발행 도구를 쓰세요)."
        )

    return "\n".join(lines)


# story #4088(E-RECIPE-1, PO 분담조정 2026-09-21 "2/2") — stage_metadata[stage].capability.kind
# → 안내 문구 i18n_catalog 키. recipe_gate_hooks.py::_GATE_TYPE_SEALED_FIELDS와 동일
# 패턴(닫힌 조회, 새 kind 추가 시 여기 한 줄만 늘리면 됨) — "generate"는 live_generation
# stage가 이미 쓰던 값(#4058/#4063), "attach_video"는 0389 마이그가 신설.
_CAPABILITY_KIND_HINTS: dict[str, str] = {
    "attach_video": "events.capability_hint_attach_video",
    "attach_image": "events.capability_hint_attach_image",
    "generate": "events.capability_hint_master_cut_evidence",
    # story #4174(레시피 2호 블로그) — 초안 작성·제출은 에이전트가 site post 도구로, 발행은 서버가(블로그 발행은
    # 사람 전용 권한 · 승인된 초안을 서버가 발행 — story #4192). 셋 다 org 커넥터 준비 검사 대상 아님.
    "draft_site_post": "events.capability_hint_draft_site_post",
    "submit_site_post": "events.capability_hint_submit_site_post",
    "site_post_auto_publish": "events.capability_hint_site_post_auto_publish",
}
# story #4174 — 이 kind의 단계는 에이전트가 아니라 서버가 이벤트를 낸다(실제 발행 뒤). 그 앞 단계 멘션은 발행 예시
# 대신 대기 안내를 싣는다(_render_event_message_content).
_SERVER_DRIVEN_CAPABILITY_KINDS = frozenset({"site_post_auto_publish"})
# story #4174(까디르 P1) — 레시피 회차 ↔ 블로그 초안의 **명시적 연결**. «서버가 낼 단계» 바로 앞 단계(발행 승인 대기)의
# 발행 payload에 에이전트가 제출한 초안 id를 싣는다. 레시피 문맥은 «이 회차가 연결한 바로 그 초안»에만 성립한다 —
# 버려진 회차가 남은 work item의 무관 초안·같은 회차의 다른 목적지 초안은 문맥이 아니다(사람 클릭 흐름 그대로).
RECIPE_SITE_DRAFT_LINK_FIELD = "site_post_draft_id"
# story #4104(페드루 PO 리뷰, 2026-09-21) — 준비 경고 루프(apply_recipe_role_bindings)가
# 같은 딕셔너리를 "이 kind는 에이전트 자기 도구로 처리(org 커넥터 무관)"라는 다른 목적으로
# 재사용한다 — 이름을 붙여 그 의도를 다음 사람이 안 물어도 되게 한다(값은 여전히 하나뿐,
# 새 원천 아님).
_AGENT_TOOL_CAPABILITY_KINDS = _CAPABILITY_KIND_HINTS

# story #4108 design CHANGES(유나·페드루 PO, 2026-09-21) — stage_metadata[stage].role은
# 사람말이 아니라 영어 enum(FE 정본 `apps/web/src/lib/stage-role.ts`, story #3773 유나
# 定)이다. 그 17종 집합과 1:1(값은 i18n_catalog.py의 `events.stage_role.<Role>` 키) —
# 미등재 role(조직 커스텀 데이터)은 FE `stageRoleLabel`과 동형 원칙으로 raw pass-through.
_STAGE_ROLE_LABEL_KEYS = frozenset({
    "Agent", "Any", "Approver", "Compute", "Creator", "Dev", "Director", "Executor",
    "Human", "Lead", "Maker", "Member", "PO", "Publisher", "QA", "Reviewer", "Worker",
})

# story #4119(페드루 PO 確定, 2026-09-21) — 준비 경고 문장의 {kind} 자리가 여전히 영어
# 식별자(publish/collect)를 그대로 실었다(#4108이 stage는 한글 라벨로 바꿨지만 kind는
# 남겼음, 유나 #4115 앵커 비차단 지적). capability.kind는 event_definition_registry.py가
# 명시하듯 열린 값이라(판별 기준으로 못 씀) 새 kind가 늘어도 이 닫힌 라벨 집합만 갱신하면
# 되고, 미등재 kind는 _STAGE_ROLE_LABEL_KEYS와 동형 원칙으로 raw pass-through한다(값은
# i18n_catalog.py의 `events.capability_kind.<kind>` 키). 이 경고 루프에 실제로 도달하는
# kind는 org 커넥터로 채워지는 kind뿐(_AGENT_TOOL_CAPABILITY_KINDS는 그 앞에서 continue로
# 걸러짐) — 현재 그 값은 publish/collect 둘뿐(test_3317b 등 기존 realdb 픽스처 기준).
_CAPABILITY_KIND_LABEL_KEYS = frozenset({"publish", "collect"})


async def _resolve_stage_gate_approver_clause(
    db: AsyncSession, *, org_id: uuid.UUID, resolved_locale: str,
) -> str:
    """story #4149(리허설 2호 실측, 페드루 PO 確定 2026-09-22) — stage 진입 멘션의
    «승인자» 절. stage_metadata[stage].gate.approver는 역할참조 슬러그(현재 유일값
    "org_owner")일 뿐 실제 지정 승인자가 아니다 — #4083(recipe_gate_hooks.py::
    _resolve_org_owner)이 OrgGatePolicy.recipe_gate_default_approver_member_id를
    org_owner role보다 우선시키는데, 이 멘션 템플릿만 그 우선순위를 몰라 role 슬러그
    리터럴("org_owner")을 문장에 그대로 꽂고 있었다(실사고, 댄 보고 원문). 새 판정
    로직 0 — _resolve_org_owner와 똑같은 순서(정책 먼저, 없으면 org owner)로 "정책이
    설정돼 있는가"만 다시 묻는다(그 결과로 실제 approver_id를 또 계산하지 않는다 —
    이 함수의 관심사는 "그 값이 정책에서 왔는지" 뿐, 실 게이트의 designated_approver_id
    재조회는 불요)."""
    from app.models.hitl_config import OrgGatePolicy

    policy_member_id = (await db.execute(
        select(OrgGatePolicy.recipe_gate_default_approver_member_id).where(OrgGatePolicy.org_id == org_id)
    )).scalar_one_or_none()
    if policy_member_id is None:
        return t("events.stage_gate_approver_clause_default", resolved_locale)

    from app.services.member_resolver import UNNAMED_MEMBER_LABEL, lookup_members_by_ids

    _members = await lookup_members_by_ids({policy_member_id}, db)
    _resolved = _members.get(policy_member_id)
    _name = (_resolved.name if _resolved else None) or (
        UNNAMED_MEMBER_LABEL if resolved_locale == "ko" else "unnamed member"
    )
    return t("events.stage_gate_approver_clause_policy", resolved_locale, name=_name)


async def _render_event_message_content(
    db: AsyncSession, *, org_id: uuid.UUID, definition, payload: dict, resolved_locale: str = "ko",
) -> str:
    """story #3313(마케팅자동화·온보딩 결함) — `block_template`가 없는 사이클형 정의(stage
    이벤트)의 알림 본문이 "stage/work_item_id뿐"이라 수신 에이전트가 `list_event_definitions`
    조회+스토리 정독 없이는 못 움직였다(담롱 실측, "최저 지능 LLM도 이벤트만 보고 척척" 온보딩
    철학 미달). `stage_metadata[stage]`에 이미 있는 role/action과 `payload_schema.stage.enum`
    순서로 뽑은 다음 stage+발행 예시를 본문에 싣는다.

    ⚠️PO 확定(2026-09-02) — 조직 규칙/우리 문구를 기본값으로 박지 않는다: role/action은
    정의(stage_metadata)에 이미 적힌 값을 그대로 옮길 뿐 새 문구를 짓지 않고, 발행 예시도
    definition_key+payload 골격만(값 없이 구조만). 회귀 0인 한 갈래(기존 제네릭 그대로):
    stage_metadata가 비어있는 비사이클형 정의("담당자 없는 stage는 모르면 안 준다" 원칙과
    동일 — 지어낼 stage_metadata 자체가 없다).

    story #3330 — `preset.gate.verdict`는 `stage_metadata`가 없는 비사이클형 정의라 위
    갈래로 떨어져 여태 제네릭 폴백뿐이었다(반려 사유·산출물 링크·다음 행동이 전혀 안
    실림). 그 키만 전용 렌더(`_render_gate_verdict_message`)로 먼저 갈라낸다.

    ⛔story #4076(2026-09-21, 페드루 PO 確定) — 원설계는 「block_template가 있는 정의는
    FE block_template 렌더러(event-block-card.tsx)가 이미 담당한다」는 전제로 이 자기설명
    분기를 스킵시켰다. 그 전제가 틀렸다: block_template 렌더는 FE 채팅 UI 전용(chat-bubble.tsx
    가 파싱 성공했을 때만 EventBlockCard를 태움)이고, 멘션을 받는 에이전트(webhook/SSE 채널)는
    block_template을 전혀 못 본다 — content(이 함수의 반환값)가 그 채널의 전부다. 실측(moonklabs
    org, GET /api/v2/events/definitions): stage_metadata 있는 정의 10개 중 9개가 block_template도
    있어 자기설명 0(제네릭 폴백만)이었다. block_template 필드 자체는 무변경(FE 카드 회귀 0) —
    이 분기의 「block_template 있으면 스킵」 조건만 제거한다."""
    if definition.key == "preset.gate.verdict":
        return await _render_gate_verdict_message(db, org_id=org_id, payload=payload, resolved_locale=resolved_locale)
    if not definition.stage_metadata:
        return "\n".join(_generic_event_message_lines(definition.key, payload))

    stage = payload.get("stage")
    stage_meta = definition.stage_metadata.get(stage) if stage else None
    if stage_meta is None:
        # stage가 payload에 없거나 stage_metadata에 등재 안 됨 — 지어내지 않고 기존 폴백.
        return "\n".join(_generic_event_message_lines(definition.key, payload))

    # PO 리뷰(페드루, 2026-09-02) — validate_stage_metadata의 role/action 필수 검증은
    # 2026-08-19 이후 "쓰기 시점" 가드라, 그 전에 저장된 정의는 role/action이 누락된 채
    # DB에 있을 수 있다. 직접 인덱싱(stage_meta['role'])하면 그 정의의 publish 자체가
    # KeyError로 죽는다(알림 개선이 발행 회귀가 되는 자리) — .get()으로 방어, 하나라도
    # 없으면 지어내지 않고 기존 제네릭 폴백.
    role = stage_meta.get("role")
    action = stage_meta.get("action")
    if not role or not action:
        return "\n".join(_generic_event_message_lines(definition.key, payload))

    # story #3329 — action 문구 안에 박힌 doc/story UUID(전체 또는 8자 prefix)를 참조
    # 토큰으로. work_item_ref/*_doc_id와 같은 "실재하는 것만" 원칙(없으면 원문 그대로).
    rendered_action = await _tokenize_embedded_entity_refs(db, org_id=org_id, text=action)

    # story #4174(유나 · PO 12:37Z) — 머리 줄·할 일 줄도 로케일 키(«다음 단계» 줄들과 같은 방식) — en 본문 안에 한국어가 섞이지 않게.
    lines = [
        t("events.event_line_header", resolved_locale, event_key=definition.key),
        f"- stage: {stage} ({role})",
        f"- {t('events.stage_action_label', resolved_locale, action=rendered_action)}",
    ]

    # story #4088(E-RECIPE-1, PO 분담조정 2026-09-21 "2/2") — 리허설 1호 실측 구멍 ①②:
    # role/action만으로는 "무엇을 만들지"는 알아도 산출물을 제품에 편입시키는 방법(①)이나
    # 계보 생성에 필요한 evidence 형식(②)을 몰랐다. 하드코딩 0 — 지금 stage의 capability.
    # kind 선언에서만 유도(live_generation.capability.kind=="generate"는 #4058/#4063
    # 기존 선언 그대로, verification/editing.capability.kind=="attach_video"는 이 카드
    # 0389 마이그 신설).
    _capability_hint_key = _CAPABILITY_KIND_HINTS.get(_stage_capability_kind(stage_meta))
    if _capability_hint_key:
        lines.append(f"- {t(_capability_hint_key, resolved_locale)}")

    next_stage = _next_recipe_stage(definition, stage)

    # story #4076 ④ — 게이트가 어느 발행에 걸리는지에 따라 다음 행동 문구가 갈린다
    # (recipe_gate_hooks.py:1845-1854 — routing 해석 직후·메시지 발송 이전에
    # `maybe_create_stage_gate(payload["stage"])`가 이미 실행됨, 즉 **지금 이 stage**의
    # gate 선언은 이 알림을 만드는 바로 그 발행이 이미 열어 둔 게이트다):
    #   ①지금 stage에 gate 있음 → 게이트가 이미 열려 있다(스코프 B). 다음 stage를 지금
    #     발행하면 안 된다(승인 전 발행 유도 금지) — 발행 예시를 생략하고 대기 문구로.
    #   ②지금 stage엔 gate가 없지만 다음 stage에 gate가 있음 → 그 발행 자체가 게이트를
    #     여는 트리거다(스코프 A). 발행 예시는 그대로 두되(빼면 에이전트가 게이트를 여는
    #     방법 자체를 모르게 됨, 페드루 PO 지적) 그 결과를 안내하는 문장만 덧붙인다.
    current_gate = stage_meta.get("gate")
    if current_gate is not None:
        _approver_clause = await _resolve_stage_gate_approver_clause(
            db, org_id=org_id, resolved_locale=resolved_locale,
        )
        lines.append(
            f"- {t('events.stage_gate_already_open', resolved_locale, approver_clause=_approver_clause)}"
        )
        if next_stage is not None:
            next_role = (definition.stage_metadata.get(next_stage) or {}).get("role")
            lines.append(f"- {t('events.stage_next_label', resolved_locale, stage=next_stage)}" + (f" ({next_role})" if next_role else ""))
        else:
            lines.append(f"- {t('events.stage_next_none', resolved_locale)}")
    elif (
        next_stage is not None
        and _stage_capability_kind(definition.stage_metadata.get(next_stage)) in _SERVER_DRIVEN_CAPABILITY_KINDS
    ):
        # story #4174 — 다음 단계는 서버가 실제 발행 뒤 낸다(블로그 발행은 사람 전용 권한 — 에이전트가 그 단계 이벤트를
        # 먼저 내면 발행 안 된 글이 «발행됨»으로 보인다). 발행 예시 대신 대기 안내.
        next_role = (definition.stage_metadata.get(next_stage) or {}).get("role")
        lines.append(f"- {t('events.stage_next_label', resolved_locale, stage=next_stage)}" + (f" ({next_role})" if next_role else ""))
        lines.append(f"- {t('events.stage_next_server_driven', resolved_locale)}")
    elif next_stage is not None:
        next_meta = definition.stage_metadata.get(next_stage) or {}
        next_role = next_meta.get("role")
        lines.append(f"- {t('events.stage_next_label', resolved_locale, stage=next_stage)}" + (f" ({next_role})" if next_role else ""))

        # story #4085 AC1(리허설 1호 실측) — 다음 stage가 게이트를 여는데 그 gate_type이
        # 봉인 필드를 요구하면(recipe_gate_hooks.py::_GATE_TYPE_SEALED_FIELDS, 검증과 같은
        # SSOT·레시피 하드코딩 0) 예시 payload에 그 필드를 실값 예시로 채운다 — 실사고:
        # 예산 게이트가 estimated_cost_minor 없이 열려 승인 카드에 예상 비용이 비어 있었다
        # (예시가 필드를 안 보여줘 에이전트가 몰랐다, "최저 지능 LLM도 이걸로 척척" 철학
        # 미달). base_payload에 sealed field가 이미 있으면 덮지 않는다(발행자가 이미 그
        # stage용으로 실은 값이 있을 리는 없지만 — payload는 "지금 stage"의 값이라
        # 안전하게 덮어도 되나, 혹시 모를 우연한 동명 키 보존이 더 정직하다).
        _next_gate_decl = next_meta.get("gate")
        _sealed_specs, _example_base_payload = await _resolve_sealed_field_specs_and_payload(
            db, org_id, _next_gate_decl, payload,
        )
        # story #4174(까디르 P1) — 다음 단계가 «서버가 낼 단계» 바로 앞(블로그: 발행 승인 대기)이면 그 발행이 이 회차의
        # 블로그 초안을 명시적으로 연결해야 한다(RECIPE_SITE_DRAFT_LINK_FIELD) — 예시에 그 자리를 싣는다.
        _after_next = _next_recipe_stage(definition, next_stage)
        if _after_next is not None and _stage_capability_kind(
            definition.stage_metadata.get(_after_next)
        ) in _SERVER_DRIVEN_CAPABILITY_KINDS:
            _example_base_payload = {**_example_base_payload, RECIPE_SITE_DRAFT_LINK_FIELD: "<draft_id you passed to submit_site_post_draft>"}
        example_json = _next_stage_publish_payload_json(definition, next_stage, _example_base_payload)
        lines.append(f"- {t('events.stage_next_publish_example', resolved_locale, example=example_json)}")
        if _next_gate_decl is not None:
            lines.append(f"- {t('events.stage_gate_opens_on_publish', resolved_locale)}")
            for spec in _sealed_specs:
                lines.append(f"- {t(spec.explanation_catalog_key, resolved_locale)}")
            # story #4088(E-RECIPE-1, PO 분담조정 "2/2") — 리허설 1호 실측 구멍 ③: 댄이
            # pending_approval 게이트가 열리는 걸 몰라 승인 대기만 하다 "같은 스토리에
            # 채널 초안을 제출하면 자동 충족"(story #4069, PR #4442, channel_posts.py 제출
            # 시점 Hook A) 경로를 놓쳤다. gate_type 자체로 유도(stage 이름 하드코딩 0) —
            # external_publish 게이트가 열리는 자리마다 동일하게 뜬다(레시피 1호뿐 아님).
            if _next_gate_decl.get("type") == "external_publish":
                lines.append(f"- {t('events.gate_hint_external_publish_auto_satisfy', resolved_locale)}")
    else:
        lines.append(f"- {t('events.stage_next_none', resolved_locale)}")

    work_item_type = payload.get("work_item_type")
    work_item_id_raw = payload.get("work_item_id")
    work_item_ref: str | None = None
    if work_item_type and work_item_id_raw:
        try:
            work_item_id = uuid.UUID(str(work_item_id_raw))
        except (ValueError, AttributeError, TypeError):
            work_item_id = None
        if work_item_id is not None:
            work_item_ref = await _work_item_ref_token(
                db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id,
            )
    if work_item_ref:
        lines.append(f"- work item: {work_item_ref}")
    else:
        # 참조 토큰을 못 만들었으면(타입 미지원·존재 안 함 등) raw 값을 그대로 남긴다 —
        # 기존 폴백이 주던 정보(원시 id)를 잃지 않는다(지어내지 않음).
        for k in ("work_item_type", "work_item_id"):
            if k in payload:
                lines.append(f"- {k}: {payload[k]}")

    shown_keys = {"stage", "work_item_type", "work_item_id"}
    for k, v in payload.items():
        if k in shown_keys:
            continue
        if k.endswith("_doc_id") and isinstance(v, str) and v:
            doc_ref = await _render_event_notification_doc_ref(db, org_id=org_id, doc_id_raw=v)
            if doc_ref:
                lines.append(f"- {_DOC_ID_PAYLOAD_LABELS.get(k, k)}: {doc_ref}")
                continue
        lines.append(f"- {k}: {v}")

    return "\n".join(lines)


@router.post("/publish", status_code=201)
async def publish_registry_event(
    body: EventPublishRequest,
    background_tasks: BackgroundTasks,
    request: Request,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    locale: str | None = None,
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
    원칙(#2633 AC2)을 유지한다. 이 엔드포인트는 auth 의존성 해석만 하고 넘긴다.

    story #3369(BE, 페드루 PO 確定 2026-09-11) — `_render_gate_verdict_message`의
    i18n_catalog 이관분이 쓸 locale. `#3796`/`#3614`와 같은 우선순위(explicit locale
    → Accept-Language → 기본 "ko")이되, 이 함수는 이미 `request: Request`(plain
    파라미터, `Header()` DI 마커가 아니다)를 받고 있어 그걸로 헤더를 직접 읽는다 —
    별도 `Header()` 진입점/직접-호출 분리가 불필요하다(이 레포 realdb 테스트
    10여 곳이 이 함수를 HTTP 경유 없이 직접 호출하는데, `request`는 이미 실
    Starlette Request라 `.headers`가 항상 안전하게 동작한다 — `Header()` 마커였다면
    그 호출부 전부가 깨졌을 것)."""
    resolved_locale = resolve_locale_from_request(locale, request.headers.get("accept-language"))
    return await _publish_registry_event_core(
        db, org_id, auth, body.definition_key, body.payload, background_tasks,
        request=request, extra_broadcast_member_ids=body.extra_broadcast_member_ids,
        conversation_id=body.conversation_id, resolved_locale=resolved_locale,
    )


async def _find_existing_stage_publish(
    db: AsyncSession, *, org_id: uuid.UUID, definition_key: str, work_item_type: str, work_item_id: str, stage: str,
) -> ConversationMessage | None:
    """story #4075 — 게이트 없는 첫 stage(draft) 재발행 이력 조회. publish-history(#2665)와
    동일 SSOT(conversation_messages.msg_metadata['event'], #2637 AC 0-a payload additive)를
    work_item_type/work_item_id/stage까지 좁힌다 — 신규 로그 테이블 발명 안 함.

    ⛔story #4081(2026-09-21, 디디군 크로스세션 그라운딩) — `.msg_metadata["event"][...]`
    (ORM bracket-subscript accessor)는 JSON 키 자체를 **bind parameter**로 컴파일한다
    (`metadata[$1][$2] ->> $3` — `.compile()` 실측 확認, `literal_binds=True` 없이는
    'event'/'payload'/'work_item_id' 전부 파라미터). 0384의 표현식 인덱스는 리터럴 키에
    고정돼 있어, custom plan(파라미터 값을 알고 재계획)에선 우연히 맞아도 generic plan
    (`EXPLAIN (GENERIC_PLAN)`로 PG16 로컬 재현 — 파라미터 값 무관 계획, asyncpg가 같은
    커넥션에서 이 statement를 반복 실행하면 Postgres가 자동 전환할 수 있는 자리)에선
    Seq Scan으로 조용히 되돌아간다(에러 없음 — `?` vs `IS NOT NULL` 사고와 같은 클래스).
    처방: JSON 키는 `text()`로 리터럴 SQL에 직접 박고(코드에 고정된 상수라 인젝션 위험
    없음), 비교 **값**만 bind parameter로 남긴다 — 이러면 GENERIC_PLAN에서도 Index Scan
    확認(재실측)."""
    from app.models.conversation import Conversation, ConversationMessage

    return (await db.execute(
        select(ConversationMessage)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(
            Conversation.org_id == org_id,
            text("conversation_messages.metadata->'event'->>'event_key' = :event_lookup_definition_key"),
            text(
                "conversation_messages.metadata->'event'->'payload'->>'work_item_type' "
                "= :event_lookup_work_item_type"
            ),
            text(
                "conversation_messages.metadata->'event'->'payload'->>'work_item_id' "
                "= :event_lookup_work_item_id"
            ),
            text("conversation_messages.metadata->'event'->'payload'->>'stage' = :event_lookup_stage"),
        )
        .params(
            event_lookup_definition_key=definition_key, event_lookup_work_item_type=work_item_type,
            event_lookup_work_item_id=work_item_id, event_lookup_stage=stage,
        )
        .order_by(ConversationMessage.created_at.desc())
        .limit(1)
    )).scalars().first()


async def resolve_site_post_recipe_context(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID,
    draft_id: uuid.UUID | str | None,
) -> tuple[str, str] | None:
    """story #4174 — 이 work item이 «다음 단계를 서버가 실제 발행 뒤 내는» 레시피(블로그 — capability kind
    `site_post_auto_publish`)의 바로 앞 단계(발행 승인 대기)에 있는가. 반환 (정의 key, 서버가 낼 다음 stage) · 아니면
    None(레시피 밖 블로그 — 승인 뒤 사람 클릭 흐름 그대로). 레시피 문맥 판별의 유일한 자리 — 승인 알림의 «다음 행동»
    문구(여기)와 실제 발행 뒤 이벤트·레시피 문맥 자동 발행(story #4192)이 같이 쓴다. 현재 단계 = 이 정의로 이 work
    item에 발행된 가장 최근 stage 이벤트(`_find_latest_stage_publish`, publish-history와 같은 SSOT).

    까디르 P1(4572 CHANGES) — work item의 현재 단계만 보면 버려진 회차·다른 목적지 초안까지 «레시피 문맥»이 된다. 그래서
    그 단계 이벤트 payload의 `RECIPE_SITE_DRAFT_LINK_FIELD`(회차가 연결한 초안 id)가 **이 초안 id와 같을 때만** 문맥이다.
    `draft_id` 없음·연결 필드 없음·다른 id → None."""
    from sqlalchemy import String, cast, or_

    from app.models.event_definition import EventDefinition

    candidates = (await db.execute(
        select(EventDefinition).where(
            EventDefinition.enabled.is_(True),
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
            cast(EventDefinition.stage_metadata, String).contains("site_post_auto_publish"),
        )
    )).scalars().all()
    for definition in candidates:
        for auto_stage, meta in (definition.stage_metadata or {}).items():
            if _stage_capability_kind(meta) not in _SERVER_DRIVEN_CAPABILITY_KINDS:
                continue
            latest = await _find_latest_stage_publish(
                db, org_id=org_id, definition_key=definition.key, work_item_type=work_item_type,
                work_item_id=str(work_item_id),
            )
            latest_payload = (((latest.msg_metadata or {}).get("event") or {}).get("payload") or {}) if latest is not None else {}
            current = latest_payload.get("stage")
            if (
                current is not None and _next_recipe_stage(definition, current) == auto_stage
                and draft_id is not None and latest_payload.get(RECIPE_SITE_DRAFT_LINK_FIELD) == str(draft_id)
            ):
                return definition.key, auto_stage
    return None


async def _find_latest_stage_publish(
    db: AsyncSession, *, org_id: uuid.UUID, definition_key: str, work_item_type: str, work_item_id: str,
) -> ConversationMessage | None:
    """story #4082 — `_find_existing_stage_publish`와 동일 SSOT·동일 조인 축이되 stage
    필터가 없다(이 work_item에 이 정의로 발행된 가장 최근 stage 이벤트 1건, 어느
    stage든) — "지금 몇 단계인지" 판정용. #4081(인덱스, 미르코 2026-09-21 확定)의
    `(event_key, work_item_type, work_item_id, created_at DESC)` 설계와 stage를 뺀 축이
    정확히 같아 그 인덱스를 그대로 탄다(별도 정렬 불요).

    ⛔story #4081 정정(미르코, head 03f8fb191, 페드루 지시 2026-09-21) — ORM bracket-
    subscript accessor(`.msg_metadata["event"][...]`)는 JSON 키 자체를 bind parameter로
    컴파일해(`.compile()` 실측: `metadata[$1][$2] ->> $3`) generic plan(`EXPLAIN
    (GENERIC_PLAN)`, PG16 재현)에서 0384 표현식 인덱스가 후보에도 못 오르고 Seq Scan으로
    조용히 되돌아간다 — `_find_existing_stage_publish`와 동일 함정이라 같은 처방(JSON 키는
    `text()`로 리터럴 SQL에 직접 박고, 비교 값만 bind parameter)을 그대로 옮긴다."""
    from app.models.conversation import Conversation, ConversationMessage

    return (await db.execute(
        select(ConversationMessage)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(
            Conversation.org_id == org_id,
            text("conversation_messages.metadata->'event'->>'event_key' = :event_lookup_definition_key"),
            text(
                "conversation_messages.metadata->'event'->'payload'->>'work_item_type' "
                "= :event_lookup_work_item_type"
            ),
            text(
                "conversation_messages.metadata->'event'->'payload'->>'work_item_id' "
                "= :event_lookup_work_item_id"
            ),
        )
        .params(
            event_lookup_definition_key=definition_key, event_lookup_work_item_type=work_item_type,
            event_lookup_work_item_id=work_item_id,
        )
        .order_by(ConversationMessage.created_at.desc())
        .limit(1)
    )).scalars().first()


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
    conversation_id: uuid.UUID | None = None,
    # story #3369(BE, 페드루 PO 確定 2026-09-11) — `_render_gate_verdict_message`의
    # i18n_catalog 이관분(#3796/#3614와 같은 형)이 쓸 locale. 서버 자동발행(publish_
    # preset_event, HTTP 요청 컨텍스트 없음 — 이 함수 docstring 참조)은 이 인자를
    # 안 넘겨 기본값 "ko"로 떨어진다(회귀 0) — HTTP 진입점(publish_registry_event)만
    # Header()로 실제 값을 풀어 넘긴다.
    resolved_locale: str = "ko",
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

    # story #4075(FE 실사고 그라운딩, 2026-09-20, 페드루 PO 確定) — «레시피 시작» 버튼이
    # 첫 stage(draft)를 발행하는데, 사람의 새로고침+재클릭이 같은 work_item에 draft를
    # 중복 발행시킬 수 있다. 게이트 있는 stage는 이미 안전(create_gate가 (work_item_id,
    # work_item_type, gate_type) 키로 멱등, recipe_gate_hooks.py) — 게이트 없는 stage
    # 전부로 넓히면 미르코 그라운딩(#4076 조사 중 확인)대로 디렉터 재작업 요청 등 정당한
    # 동일-stage 재발행(에이전트발)을 조용히 삼켜 다음 역할에게 알림이 안 가는 클래스가
    # 새로 생긴다 — 그래서 **첫 stage 한정**. recipe_repeat_schedule.py 실측(같은 문제
    # 조사) — repeat 메커니즘은 항상 **다음 회차의 새 work_item_id**를 겨냥해(last_story_id
    # 로 이전 회차와 분리 추적) 같은 work_item_id에 첫 stage를 다시 쏘는 정당한 경로가
    # 원천적으로 없다 — 그래서 시간 창(N분) 없이 **영구** 이력 기반으로 막아도 정당한
    # 경로를 안 삼킨다(오히려 시간 창을 두면 "창 밖이면 통과"라는 새 엣지케이스가 생겨
    # 더 복잡해진다). FE "진행 중" 표시도 이 판정과 대칭인 영구 이력 기반(§publish-status
    # 엔드포인트)이라 시간이 지나도 버튼이 되살아나지 않는다.
    first_stage = (definition.payload_schema.get("properties") or {}).get("stage", {}).get("enum") or []
    stage = payload.get("stage")
    work_item_type = payload.get("work_item_type")
    work_item_id = payload.get("work_item_id")
    if (
        first_stage and stage == first_stage[0]
        and isinstance(work_item_type, str) and work_item_type
        and work_item_id
    ):
        # AC7(두 탭 동시 클릭) — 아래 "조회 후 없으면 발행"은 그 자체로 TOCTOU다(check-then-
        # insert, [[feedback_check_then_insert_toctou]] 동형 — SELECT는 동시 두 트랜잭션
        # 모두에서 "없음"을 볼 수 있다). allocate_story_number의 story.py 관례를 그대로
        # 재사용 — 이 (org, definition, work_item, stage) 조합을 pg_advisory_xact_lock으로
        # 직렬화한다. 이 함수는 락 획득부터 아래 send_message()의 실제 커밋까지 중간 commit이
        # 0(위 두 지점 사이 grep 확認) — 두 번째 요청은 첫 요청의 커밋이 끝난 뒤에야 락을
        # 얻어 그때는 이미 첫 메시지가 보인다.
        await db.execute(select(func.pg_advisory_xact_lock(func.hashtext(
            f"recipe_start:{org_id}:{definition.key}:{work_item_type}:{work_item_id}:{stage}"
        ))))
        existing_publish = await _find_existing_stage_publish(
            db, org_id=org_id, definition_key=definition.key,
            work_item_type=work_item_type, work_item_id=str(work_item_id), stage=str(stage),
        )
        if existing_publish is not None:
            return {
                "conversation_id": str(existing_publish.conversation_id),
                "message_id": str(existing_publish.id),
                "escalation_member_ids": [],
                "broadcast_member_ids": [],
                "zero_reach_warning": False,
                # story #4075 — 호출자(FE·에이전트)가 "새로 발행됐다"와 "이미 발행돼
                # 있었다(그 기존 발행분을 그대로 돌려줬다)"를 가를 수 있게 조용히 삼키지
                # 않는다.
                "deduplicated": True,
            }

    from app.services.event_routing_resolver import (
        InvalidWorkItemReferenceError,
        MissingRoutingPayloadFieldError,
        UnknownRoutingMemberError,
        resolve_routing_leg,
    )

    try:
        escalation_ids = await resolve_routing_leg(
            definition.routing["escalation"], payload=payload, org_id=org_id, db=db,
            definition_key=definition.key,
        )
        broadcast_ids = await resolve_routing_leg(
            definition.routing["broadcast"], payload=payload, org_id=org_id, db=db,
            definition_key=definition.key,
        )
    except (MissingRoutingPayloadFieldError, InvalidWorkItemReferenceError, UnknownRoutingMemberError) as e:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_payload", "message": str(e), "errors": [str(e)]},
        ) from e

    # story #3312(M1→M3·마케팅자동화) — routing 해석 직후, 메시지 발송 이전에 게이트 부수효과를
    # 먼저 정착시킨다(routing_resolver 호출과 동일 컴포지션 스타일 — 인라인 분기 아님).
    # definition에 이 stage의 gate 선언이 없으면 완전 no-op(AC3 회귀 0).
    from app.services.generation_budget import GenerationBudgetExceededError
    from app.services.newsletter_send import (
        NewsletterApproverRoleMissingError,
        NewsletterPublicationChannelError,
        NewsletterPublicationNotFoundError,
        NewsletterPublicationNotPublishedError,
    )
    from app.services.recipe_gate_hooks import MissingGateSealedFieldError, maybe_create_stage_gate

    _NEWSLETTER_SEND_ERRORS = {
        NewsletterPublicationNotFoundError: (404, "NEWSLETTER_SEND_PUBLICATION_NOT_FOUND", "newsletter_send.publication_not_found"),
        NewsletterPublicationChannelError: (422, "NEWSLETTER_SEND_INVALID_CHANNEL", "newsletter_send.invalid_channel"),
        NewsletterPublicationNotPublishedError: (409, "NEWSLETTER_SEND_NOT_PUBLISHED", "newsletter_send.not_published"),
        NewsletterApproverRoleMissingError: (409, "NEWSLETTER_SEND_APPROVER_ROLE_MISSING", "newsletter_send.approver_role_missing"),
    }

    try:
        await maybe_create_stage_gate(
            db, org_id=org_id, definition=definition, payload=payload, requester_member_id=sender.id,
        )
    except GenerationBudgetExceededError as e:
        # story #4044 — channel_posts.py/site_posts.py의 submit 경로(#3498 AC2)와 동일
        # 4값 detail shape 재사용(신규 에러 계약 발명 0).
        raise HTTPException(
            status_code=422,
            detail={
                "code": "GENERATION_BUDGET_EXCEEDED",
                "limit_minor": e.limit_minor, "spent_minor": e.spent_minor,
                "estimated_cost_minor": e.estimated_cost_minor, "remaining_minor": e.remaining_minor,
            },
        ) from e
    except MissingGateSealedFieldError as e:
        # story #4085(리허설 1호 실측, PO 확定) — "숫자 없는 예산 게이트는 게이트가
        # 아니다": 봉인 필드가 빠지면 게이트를 만들지 않고 어떤 필드가 빠졌는지 명시한다
        # (에이전트가 같은 발행을 그 필드만 채워 재시도할 수 있게).
        raise HTTPException(
            status_code=422,
            detail={
                "code": "GATE_SEALED_FIELD_MISSING",
                "gate_type": e.gate_type,
                "missing_fields": e.missing_fields,
                "message": t(
                    "events.gate_sealed_field_missing", resolved_locale,
                    gate_type=e.gate_type, fields=", ".join(e.missing_fields),
                ),
            },
        ) from e
    except tuple(_NEWSLETTER_SEND_ERRORS) as e:
        # story #4191 — 레시피 발송 단계가 사람 API와 같은 서비스(request_newsletter_send)로 발송
        # 요청을 연다. 거부도 사람 API(routers/newsletter_send.py)와 같은 코드·상태·문구로 낸다.
        status_code, code, catalog_key = _NEWSLETTER_SEND_ERRORS[type(e)]
        raise HTTPException(
            status_code=status_code, detail={"code": code, "message": t(catalog_key, resolved_locale)},
        ) from e

    # story #3337(선생님 4바퀴 실사고) — 위 게이트 훅과 같은 컴포지션 지점, 같은 원칙(정의에
    # 해당 없으면 완전 no-op). 첫 stage가 payload.repeat를 실었으면 반복 스케줄을 세우고,
    # 이후 매 stage 발행마다 다음 회차 입력 스냅샷을 최신화한다.
    from app.services.recipe_repeat_schedule import maybe_upsert_repeat_schedule

    await maybe_upsert_repeat_schedule(db, org_id=org_id, definition=definition, payload=payload)

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

    # story #3340(선생님 4바퀴 실사고, 페드루 PO 확定 — 시스템 발행만 좁힘) — escalation·
    # broadcast 둘 다 빈 집합이면 참가자는 sender 하나뿐이 된다. 사람이 publish_event를
    # 직접 호출한 경우는 그 응답의 zero_reach_warning을 읽는 사람이 있으니 현행 유지
    # (범위 밖) — 여기는 `publish_preset_event`(서버 자동전이, 응답을 아무도 안 읽는다)
    # 발신만 좁혀서, «시스템 발행 혼자 있는 방»(2026-08-19 생성 group 같은 사례)에 통지가
    # 쌓이고 아무도 못 보는 경로를 없앤다 — project human owner(project_auth.py::
    # resolve_project_relay_owner, sprint relay용으로 이미 존재하는 project owner→org
    # owner→admin 순위 폴백을 그대로 재사용) 없으면 org owner/admin 순으로 대신 넣는다.
    _is_system_publisher = auth.claims.get("app_metadata", {}).get("api_key_id") == "system-publisher"
    if _is_system_publisher and not (escalation_ids | broadcast_ids) and project_id is not None:
        from app.services.project_auth import resolve_project_relay_owner

        _relay_owner_id = await resolve_project_relay_owner(db, project_id, org_id)
        if _relay_owner_id is not None:
            participant_ids.add(_relay_owner_id)

    if conversation_id is not None:
        # story #2935(설계 doc §2 보강) — 지정 conversation에 바로 발행. sender의 참가자
        # 여부는 send_message()의 기존 인가가 그대로 검증(및 human+non-dm이면 auto-join)한다
        # — 여기서 중복 검사하지 않는다. 이 함수가 추가로 지켜야 하는 것은 escalation 대상
        # ("실제로 도달해야 하는" 대상 — routing이 계산한 것)이 그 conversation의 실 참가자가
        # 아닌 경우다: 정상 경로(_get_or_create_event_conversation)는 참가자 집합 자체를 그
        # 대상들로 구성하므로 이 문제가 구조적으로 없는데, 오버라이드는 그 계산을 건너뛰므로
        # escalation 대상이 실제로 그 스레드에 없으면 메시지가 "성공"해도 대상은 못 보는
        # 조용한 미도달이 된다 — fail-closed 422로 거부(doc §2 "⚠️§2 보강", 대안: 자동 멘션
        # 부여는 프라이버시 침범+신규 전달계통 원칙 위반으로 기각됨).
        from app.models.conversation import Conversation, ConversationParticipant

        conv = (await db.execute(
            select(Conversation).where(Conversation.id == conversation_id, Conversation.org_id == org_id)
        )).scalar_one_or_none()
        if conv is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        conv_participant_ids = set((await db.execute(
            select(ConversationParticipant.member_id).where(
                ConversationParticipant.conversation_id == conv.id
            )
        )).scalars().all())
        missing_escalation = escalation_ids - conv_participant_ids
        if missing_escalation:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "conversation_target_mismatch",
                    "message": (
                        "지정된 conversation_id에 escalation 대상이 참가자로 없어 발행을 "
                        "거부합니다(지시가 조용히 미도달하는 것을 막기 위함)."
                    ),
                    "errors": [str(i) for i in missing_escalation],
                },
            )
    else:
        conv = await _get_or_create_event_conversation(
            db, org_id=org_id, project_id=project_id,
            participant_ids=participant_ids, created_by=sender.id,
        )

    from app.routers.conversations import SendMessageRequest, send_message

    # story #3332 — block_template의 `{{ref.X}}` 머스태시가 FE에서 해소할 값. `{{payload.X}}`
    # 와 달리 발행자가 직접 준 값이 아니라 **서버가 발행 시점에 계산**하는 참조 토큰이다 —
    # 지금은 work_item 1종만(payload에 work_item_type/work_item_id 둘 다 있을 때만 계산,
    # 기존 함수 재사용 — 새 로직 0). BLOCK_TEMPLATE_REF_VOCAB(event_definition_registry.py)
    # 과 짝인 어휘라 새 종류를 추가하려면 둘 다 넓혀야 한다.
    #
    # story #3884 AC1(d) — refs["work_item"] 값은 세 모양(FE event-block-card.tsx가 그대로
    # 소비): 찾음(dict found:True+token)·리졸버 있는데 못 찾음(dict found:False+type, FE가
    # 렌더 시점 로케일로 targetMissing 텍스트를 짓는다)·리졸버 자체가 없음(키 자체 부재,
    # FE optional 필드 생략). 텍스트를 여기서 굽지 않는다(3881과 동일 원칙).
    refs: dict[str, str | dict | None] = {}
    _refs_work_item_type = payload.get("work_item_type")
    _refs_work_item_id_raw = payload.get("work_item_id")
    if _refs_work_item_type and _refs_work_item_id_raw:
        try:
            _refs_work_item_id = uuid.UUID(str(_refs_work_item_id_raw))
        except (ValueError, AttributeError, TypeError):
            _refs_work_item_id = None
        if _refs_work_item_id is not None:
            _work_item_ref_result = await _render_event_notification_work_item_ref(
                db, org_id=org_id, work_item_type=_refs_work_item_type, work_item_id=_refs_work_item_id,
            )
            if _work_item_ref_result is not None:
                refs["work_item"] = _work_item_ref_result

    # story #3893(PO 確定 2026-09-14) — assignee_member_id/assigned_by_member_id(raw
    # UUID, 지금은 preset.work.assigned 1곳)도 위 work_item과 동일 원칙(key 존재
    # 여부만으로 트리거, definition_key 무관 — 신규 발행 갈래 0, #2633 AC2 단일 파이프
    # 유지)으로 발행 시점에 이름 해석한다. 두 필드 다 같은 리졸버(member_ref) 재사용 —
    # payload 키 이름만 다르다(담당자 vs 배정자, 유나 확定 2026-09-14 20:16Z).
    for _refs_member_payload_key, _refs_member_refs_key in (
        ("assignee_member_id", "assignee"),
        ("assigned_by_member_id", "assigned_by"),
    ):
        _refs_member_id_raw = payload.get(_refs_member_payload_key)
        if not _refs_member_id_raw:
            continue
        try:
            _refs_member_id = uuid.UUID(str(_refs_member_id_raw))
        except (ValueError, AttributeError, TypeError):
            continue
        refs[_refs_member_refs_key] = await _render_event_notification_member_ref(
            db, org_id=org_id, member_id=_refs_member_id,
        )

    # story #3893 CHANGES②(PO 확認 2026-09-15) — preset.goal.measured의 `goal_id`(raw UUID,
    # 실제로는 epic.id — cron.py가 그렇게 싣는다)도 work_item과 동일 원칙(key 존재 여부만
    # 트리거)으로 발행 시점에 참조 토큰을 계산한다. `_render_event_notification_work_item_ref`
    # 의 "epic" 갈래를 work_item_type="epic"으로 직접 호출 — work_item_type/work_item_id
    # 페어가 아니라 goal_id 단일 키라 위 work_item 블록과 트리거 조건이 다르다(신규 refs
    # 키 "goal", 새 리졸버 함수는 만들지 않는다).
    _refs_goal_id_raw = payload.get("goal_id")
    if _refs_goal_id_raw:
        try:
            _refs_goal_id = uuid.UUID(str(_refs_goal_id_raw))
        except (ValueError, AttributeError, TypeError):
            _refs_goal_id = None
        if _refs_goal_id is not None:
            _goal_ref_result = await _render_event_notification_work_item_ref(
                db, org_id=org_id, work_item_type="epic", work_item_id=_refs_goal_id,
            )
            if _goal_ref_result is not None:
                refs["goal"] = _goal_ref_result

    # story #2637 AC 0-a: event_context → msg_metadata['event'](additive) — FE가 이 메시지를
    # "이벤트 발행분"으로 인지하고 event_key로 event_definitions를 조회해 block_template
    # 렌더러를 태울 근거. 렌더러 자체는 #2637 FE 레인(이 커밋은 스키마 배선만).
    send_body = SendMessageRequest(
        content=await _render_event_message_content(
            db, org_id=org_id, definition=definition, payload=payload, resolved_locale=resolved_locale,
        ),
        mentioned_ids=list(escalation_ids),
        event_context={"event_key": definition.key, "payload": payload, "refs": refs},
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
        # story #4092(E-RECIPE-1 팔로우업, PO 확定 2026-09-21) — 리허설 1호 실측: Director
        # (사람) 역할 stage(concept_confirmed·structure_passed·pending_approval)는 애초
        # 에이전트 바인딩이 없는 게 정상이라 zero_reach가 매번 뜨고 있었다. 정의가 자기
        # role 어휘로 선언한 role_actor_kinds(§b)에서 이 stage의 role이 human으로 분류되면
        # "진짜 갭"이 아니라 "정상"이므로 경고 대신 중립 안내로 대체한다. 선언이 없으면
        # (role_actor_kinds가 None이거나 role이 그 안에 없음, "모름") 오늘과 동일하게
        # 경고 그대로 — 개선은 선언한 정의만(회귀 0).
        stage_value = payload.get("stage")
        stage_meta_for_kind = (
            (definition.stage_metadata or {}).get(stage_value)
            if isinstance(stage_value, str) else None
        )
        role_for_kind = stage_meta_for_kind.get("role") if isinstance(stage_meta_for_kind, dict) else None
        actor_kind = (
            (definition.role_actor_kinds or {}).get(role_for_kind)
            if isinstance(role_for_kind, str) else None
        )
        if actor_kind == "human":
            result["zero_reach_warning"] = False
            result["notice"] = t("events.human_stage_zero_reach_notice", resolved_locale)
        else:
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
    # story #4092(§b) — 선언 없으면 None("모름").
    role_actor_kinds: dict | None
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
            role_actor_kinds=r.role_actor_kinds,
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


def _render_one_definition(r: "EventDefinition") -> list[str]:
    """정의 1건을 마크다운 라인 목록으로 — 실패하면(malformed 데이터) 그대로 raise한다.
    격리는 호출자(`_render_onboarding_guide`)의 몫(다른 부류의 격리와 동일 조직 원칙,
    story_status_events.py류 — 함수 자체는 삼키지 않고 호출자가 포위한다)."""
    lines = [f"## {r.name} (`{r.key}`)"]
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
            # ⛔실버그(카디르군 QA, 2026-08-19) — validate_stage_metadata(쓰기 시점)가 값
            # 모양을 강제하지만, 이 렌더러는 그 가드를 못 거친(레거시·경합 등) 데이터가
            # 와도 안전해야 한다 — dict가 아니거나 role/action이 없으면 명시 raise해
            # 아래 per-row try/except가 "이 정의 1건만" 건너뛰게 한다.
            if not isinstance(meta, dict) or not isinstance(meta.get("role"), str) or not isinstance(meta.get("action"), str):
                raise ValueError(f"{r.key}: stage_metadata[{slug!r}] malformed({meta!r})")
            lines.append(f"- 단계 `{slug}`: **{meta['role']}** 담당 — {meta['action']}")
    else:
        required = (r.payload_schema or {}).get("required") or []
        if required:
            lines.append("")
            lines.append(f"발행 시 필수 항목: {', '.join(f'`{f}`' for f in required)}")
    return lines


def _render_onboarding_guide(rows: list["EventDefinition"]) -> str:
    """enabled 정의만으로 마크다운 가이드 조립 — disabled를 넣으면 "발행 가능"이라는
    잘못된 다음-행동 지시가 된다(list_event_definitions의 admin 감사 목적과 다른 축이라
    disabled 포함 여부도 다르다, 의도적 비대칭).

    ⛔실버그 fix(카디르군 QA, 2026-08-19) — 이전엔 이 루프 자체에서 렌더링해 정의 1건의
    malformed stage_metadata가 org 전체 가이드를 500으로 죽였다(폭발 반경 = 그 org가
    보는 모든 정의, preset 포함). 정의 1건 렌더를 `_render_one_definition`으로 분리해
    per-row try/except로 격리 — 문제 있는 정의는 **그 항목만** 조용히 건너뛰고 나머지
    가이드는 그대로 산다(로그로 관측 가능, exc_info 포함 — 완전 침묵 아님)."""
    lines = [_ONBOARDING_PHILOSOPHY, ""]
    for r in rows:
        if not r.enabled:
            continue
        try:
            lines.extend(_render_one_definition(r))
        except Exception:
            logger.warning(
                "onboarding-guide: 정의 렌더 실패, 이 항목만 건너뜀(key=%s)", r.key, exc_info=True,
            )
            continue
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
    # 기계용 식별자로 그대로 둔다.
    # story #3745(페드루 PO 決 2026-09-09) — 옛 기본값 ""(#2636 하위호환 안전망)이 "이름
    # 없는 정의"(화면에 코드 키가 그대로 서는 결함)의 발생 경로였다 — 기본값을 없애 필수화
    # (누락 자체가 자동 422), 빈 문자열·공백뿐인 값도 검증기로 막는다. 기존 행은 무변
    # (이 검증은 신규 생성부터만 적용).
    name: str
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
    # story #4092(§b) — 정의 자기 role 어휘의 사람/에이전트 선언(옵션, {role명: "human"|
    # "agent"}). 없으면(대부분의 정의) "모름" — validate_role_actor_kinds가 값 어휘+
    # stage_metadata 실재성만 강제, role 이름 자체는 안 막는다.
    role_actor_kinds: dict | None = None

    # story #3745(name===key 잔존, 페드루 PO 決 2026-09-09) — 빈 이름을 막아도 org 커스텀
    # 정의가 name=key로(코드 키를 그대로 이름 자리에) 등록되면 화면 제목 자리에 코드 키가
    # 그대로 서는 같은 결함이 재발한다 — 빈 문자열과 "같은 결함 클래스"라 같은 필드
    # validator에서 나란히 막는다(에러 loc도 name 그대로).
    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str, info: ValidationInfo) -> str:
        if not v.strip():
            raise ValueError("name은 비울 수 없습니다(공백뿐인 값도 안 됨)")
        key = info.data.get("key")
        if key is not None and v.strip() == key:
            raise ValueError("name은 key와 같을 수 없습니다(코드 키를 이름으로 쓸 수 없음)")
        return v


class UpdateEventDefinitionRequest(BaseModel):
    # story #3745 — PATCH는 부분 갱신이라 None(=이 필드는 안 건드림)은 그대로 허용한다.
    # 값을 실어 보내는 경우에만(빈 문자열·공백뿐인 값 포함) 막는다 — "이름을 지운다"는
    # 요청 자체가 성립하지 않는다(정의는 항상 이름을 가진다는 계약).
    name: str | None = None
    description: str | None = None
    payload_schema: dict | None = None
    routing: dict | None = None
    enabled: bool | None = None
    block_template: dict | None = None
    action_auth: dict | None = None
    stage_metadata: dict | None = None
    # story #4092(§b) — PATCH도 부분 갱신(None=안 건드림) 관례 그대로.
    role_actor_kinds: dict | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank_if_present(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("name은 비울 수 없습니다(공백뿐인 값도 안 됨)")
        return v


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
    # story #4092(§b) — 선언 없으면 None("모름").
    role_actor_kinds: dict | None
    enabled: bool
    version: int
    created_by: str | None


def _event_definition_detail(d: "EventDefinition") -> EventDefinitionDetailResponse:
    return EventDefinitionDetailResponse(
        id=str(d.id), key=d.key, org_id=str(d.org_id) if d.org_id else None,
        name=d.name, description=d.description,
        payload_schema=d.payload_schema, routing=d.routing,
        block_template=d.block_template, action_auth=d.action_auth,
        stage_metadata=d.stage_metadata, role_actor_kinds=d.role_actor_kinds,
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
        InvalidRoleActorKindsError,
        InvalidStageMetadataError,
        validate_action_auth,
        validate_block_template,
        validate_block_template_refs,
        validate_event_definition_key,
        validate_event_payload_schema_shape,
        validate_event_routing,
        validate_role_actor_kinds,
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
            # story #3332 — 구조 게이트(validate_block_template) 통과 뒤, block_template이
            # 참조하는 {{payload.X}}/{{ref.X}}가 실제로 해소 가능한지 내용 교차검증(오타를
            # 등록 시점에 막는다 — 이전엔 이 검증이 전혀 없었다, PR#3711 리뷰 실측).
            validate_block_template_refs(body.payload_schema, body.block_template)
        if body.action_auth is not None:
            validate_action_auth(body.action_auth)
        validate_stage_metadata(body.payload_schema, body.stage_metadata)
        validate_role_actor_kinds(body.stage_metadata, body.role_actor_kinds)
    except (
        InvalidEventDefinitionKeyError, InvalidPayloadSchemaError,
        InvalidEventRoutingError, InvalidBlockTemplateError, InvalidActionAuthError,
        InvalidStageMetadataError, InvalidRoleActorKindsError,
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
        stage_metadata=body.stage_metadata, role_actor_kinds=body.role_actor_kinds,
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
        InvalidRoleActorKindsError,
        InvalidStageMetadataError,
        validate_action_auth,
        validate_block_template,
        validate_block_template_refs,
        validate_event_payload_schema_shape,
        validate_event_routing,
        validate_role_actor_kinds,
        validate_stage_metadata,
    )

    if not await _is_org_admin(db, org_id, uuid.UUID(auth.user_id)):
        raise HTTPException(status_code=403, detail="org admin/owner required")

    if (
        body.name is None and body.description is None
        and body.payload_schema is None and body.routing is None and body.enabled is None
        and body.block_template is None and body.action_auth is None and body.stage_metadata is None
        and body.role_actor_kinds is None
    ):
        raise HTTPException(status_code=400, detail="at least one field must be provided")

    definition = (await db.execute(
        select(EventDefinition).where(
            EventDefinition.id == definition_id, EventDefinition.org_id == org_id,
        )
    )).scalar_one_or_none()
    if definition is None:
        raise HTTPException(status_code=404, detail="event definition not found")

    # story #3745(name===key 잔존, 페드루 PO 決 2026-09-09) — `UpdateEventDefinitionRequest`
    # 스키마엔 key가 없어(PATCH는 key를 안 바꾼다) 이 규칙을 Pydantic field_validator로 못
    # 건다 — DB에서 방금 읽은 `definition.key`와 대조해 여기서 막는다. POST의 빈 이름
    # 검증(`_name_not_blank`)과 같은 결함 클래스라 코드도 그 이웃에 등록.
    if body.name is not None and body.name.strip() == definition.key:
        raise HTTPException(
            status_code=422,
            detail={"code": "definition_name_equals_key", "message": "name은 key와 같을 수 없습니다(코드 키를 이름으로 쓸 수 없음)"},
        )

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

    # story #4092(§b) — role_actor_kinds도 stage_metadata와 짝인 검증(선언된 role명이
    # stage_metadata에 실재하는지 대조하므로) — 위와 동일 "유효 조합" 규율. stage_metadata만
    # 바뀌고 role_actor_kinds를 안 건드리면 기존 선언이 고아가 될 수 있어(role명을 바꿨는데
    # role_actor_kinds가 옛 이름을 그대로 가리킴) 이 경우도 여기서 걸린다.
    if body.stage_metadata is not None or body.role_actor_kinds is not None:
        effective_stage_metadata_for_kinds = (
            body.stage_metadata if body.stage_metadata is not None else definition.stage_metadata
        )
        effective_role_actor_kinds = (
            body.role_actor_kinds if body.role_actor_kinds is not None else definition.role_actor_kinds
        )
        try:
            validate_role_actor_kinds(effective_stage_metadata_for_kinds, effective_role_actor_kinds)
        except InvalidRoleActorKindsError as e:
            raise HTTPException(
                status_code=400, detail={"code": "invalid_definition", "message": str(e)},
            ) from e

    # story #3332 — block_template↔payload_schema 교차검증도 위 stage_metadata와 동일
    # 규율: 둘 중 하나만 바뀌어도 **유효 조합**(새 값 있으면 새 값·없으면 기존 값)으로
    # 재검증한다 — payload_schema만 줄어들고 block_template을 안 건드리면 그 템플릿이
    # 참조하던 필드가 조용히 사라질 수 있다. 유효 block_template이 없으면(둘 다 None)
    # 검증 대상 자체가 없어 스킵.
    if body.payload_schema is not None or body.block_template is not None:
        effective_schema_for_template = (
            body.payload_schema if body.payload_schema is not None else definition.payload_schema
        )
        effective_block_template = (
            body.block_template if body.block_template is not None else definition.block_template
        )
        if effective_block_template is not None:
            try:
                validate_block_template_refs(effective_schema_for_template, effective_block_template)
            except InvalidBlockTemplateError as e:
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
    if body.role_actor_kinds is not None:
        definition.role_actor_kinds = body.role_actor_kinds
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


class ApplyRecipeRoleBindingsRequest(BaseModel):
    project_id: uuid.UUID | None = None
    # story #3288(축2-ⓐ) — stage_slug → TeamMember.id(str). None project_id = org 전역
    # 바인딩(모든 project 적용, 특정 project 바인딩이 있으면 그쪽이 우선 — 조회는
    # event_routing_resolver.py의 project-먼저 순서로 이미 강제).
    role_mapping: dict[str, str]


class ApplyRecipeRoleBindingsResponse(BaseModel):
    ok: bool
    bindings_upserted: int
    # story #3317 PR B(마케팅자동화·레시피 결함, PO 확定 2026-09-02) — capability(publish:
    # <channel> 등) 요구 stage의 커넥터가 org_connector_registry에 미등록이거나 필수
    # org_config가 미충족이면 여기 담긴다. apply 자체는 안 막는다(경고뿐 — role_mapping이
    # 이미 정상 upsert됐는데 커넥터 설정이 늦어졌다고 그 upsert를 막을 이유가 없다는 PO
    # 판단). additive·기존 호출부 무회귀(default 빈 배열).
    warnings: list[str] = []


@router.post(
    "/definitions/{definition_id}/apply", response_model=ApplyRecipeRoleBindingsResponse, status_code=201,
)
async def apply_recipe_role_bindings(
    definition_id: uuid.UUID,
    body: ApplyRecipeRoleBindingsRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ApplyRecipeRoleBindingsResponse:
    """POST /api/v2/events/definitions/{id}/apply — story #3288(축2-ⓐ).

    구 `workflow_templates.py::apply_template`의 검증 체인을 이식(생성 로직 자체는 폐기 —
    doc axis2-recipe-mechanism-event-definitions-design §설계정정 참고, AgentRoutingRule을
    만들지 않고 recipe_role_bindings에 upsert만 한다):
    ①project_id 지정 시 has_project_access 선검증(SEC-S8 CRITICAL 재발 방지 — 이 사고가 난
    그 자리) ②role_mapping 키 집합이 정의의 stage_metadata.keys()(=사실상 stage enum) ⊇
    하는지 검증 ③agent_id가 실제로 이 org의 TeamMember인지 검증.
    """
    from app.models.channel_connection import ChannelConnection
    from app.models.event_definition import EventDefinition
    from app.models.org_generation_connector import OrgGenerationConnector
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.models.team import TeamMember
    from app.services.project_auth import require_project_access

    if body.project_id is not None:
        # story #2697 SSOT — require_project_access로 수렴(raw inline has_project_access+raise
        # 패턴 신규 추가 금지, 카디르 QA #3686 적발). 실패 시 항상 404(존재 비노출).
        await require_project_access(db, uuid.UUID(auth.user_id), body.project_id, org_id, not_found_detail="Project not found")

    definition = (await db.execute(
        select(EventDefinition).where(
            EventDefinition.id == definition_id,
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        )
    )).scalar_one_or_none()
    if definition is None:
        raise HTTPException(status_code=404, detail="event definition not found")

    valid_stages = set(definition.stage_metadata.keys())
    unknown_stages = sorted(set(body.role_mapping.keys()) - valid_stages)
    if unknown_stages:
        raise HTTPException(
            status_code=422,
            detail=f"role_mapping에 이 정의의 stage_metadata에 없는 stage가 있습니다: {unknown_stages}",
        )

    # story #4090(alembic 0385, 페드루 PO 確定 2026-09-21) — capability.target=
    # "channel_connection"인 stage(Publisher)는 알릴 사람이 아니라 **발행할 채널**을
    # 가리킨다(0381 원 설계의 "Publisher도 Creator와 동형으로 agent 바인딩"을 이 카드가
    # 대체 — 리허설 1호 ⑤가 발행자 슬롯 선택지 0으로 그 설계가 실사용을 못 견딘다는 것을
    # 실측했다). ⚠️capability.kind(예: 'publish')로 판별하지 않는다 — kind는 열린 값이라
    # 기존 정의(#3317 PR B, test_3317b/test_3359)가 "kind=publish + agent 바인딩"을 이미
    # 쓰고 있다(회귀 7건이 그 계약을 pin) — target은 그 kind와 독립된 별도 닫힌 어휘
    # 필드(event_definition_registry.py::_CAPABILITY_TARGETS, 명시 선언 없으면 기본
    # "agent" = 오늘 계약 그대로).
    # story #4101(alembic 0391) — 두 값 판별을 세 값으로 확장. "agent"가 기본(무선언 stage
    # 회귀 0)은 그대로.
    def _stage_target(stage: str) -> str:
        capability = (definition.stage_metadata.get(stage) or {}).get("capability")
        target = (capability or {}).get("target")
        return target if target in ("channel_connection", "generation_connector") else "agent"

    channel_stage_values = {s: v for s, v in body.role_mapping.items() if _stage_target(s) == "channel_connection"}
    generation_stage_values = {
        s: v for s, v in body.role_mapping.items() if _stage_target(s) == "generation_connector"
    }
    agent_stage_values = {s: v for s, v in body.role_mapping.items() if _stage_target(s) == "agent"}

    agent_ids = {uuid.UUID(v) for v in agent_stage_values.values()}
    valid_agents = set((await db.execute(
        select(TeamMember.id).where(TeamMember.id.in_(agent_ids), TeamMember.org_id == org_id)
    )).scalars().all()) if agent_ids else set()
    missing_agents = [v for v in agent_stage_values.values() if uuid.UUID(v) not in valid_agents]
    if missing_agents:
        raise HTTPException(
            status_code=422,
            detail=f"agent(s) not found in this org: {missing_agents}",
        )

    channel_connection_ids = {uuid.UUID(v) for v in channel_stage_values.values()}
    valid_connections = set((await db.execute(
        select(ChannelConnection.id).where(
            ChannelConnection.id.in_(channel_connection_ids), ChannelConnection.org_id == org_id,
        )
    )).scalars().all()) if channel_connection_ids else set()
    missing_connections = [v for v in channel_stage_values.values() if uuid.UUID(v) not in valid_connections]
    if missing_connections:
        raise HTTPException(
            status_code=422,
            detail=f"channel connection(s) not found in this org: {missing_connections}",
        )

    # story #4101 — generation_connector target도 org 경계 안 존재 검증 + revoke된 커넥터는
    # 바인딩 대상 불가(status='active'만 유효, 스토리 판별 조건 "revoke 뒤 바인딩 대상 불가").
    generation_connector_ids = {uuid.UUID(v) for v in generation_stage_values.values()}
    valid_generation_connectors = set((await db.execute(
        select(OrgGenerationConnector.id).where(
            OrgGenerationConnector.id.in_(generation_connector_ids),
            OrgGenerationConnector.org_id == org_id,
            OrgGenerationConnector.status == "active",
        )
    )).scalars().all()) if generation_connector_ids else set()
    missing_generation_connectors = [
        v for v in generation_stage_values.values() if uuid.UUID(v) not in valid_generation_connectors
    ]
    if missing_generation_connectors:
        raise HTTPException(
            status_code=422,
            detail=f"generation connector(s) not found or not active in this org: {missing_generation_connectors}",
        )

    # story #3317 PR B — capability(publish:<channel> 등) 요구 stage의 커넥터 준비 상태를
    # 경고로만 알린다(apply 자체는 안 막음, PO 확定). capability 선언 없는 stage는 완전
    # no-op(무선언 정의 회귀 0).
    from app.services.channel_connector_map import resolve_connector_key_for_channel
    from app.services.connector_registry import (
        find_org_connectors_by_kind, get_org_connector, missing_required_org_config,
    )

    warnings: list[str] = []
    for stage in body.role_mapping:
        stage_meta = definition.stage_metadata.get(stage) or {}
        capability = stage_meta.get("capability")
        if not capability:
            continue
        kind = capability["kind"]
        # story #4115(페드루 PO 確定, 2026-09-21 라이브 실사고 · CHANGES — 스킵 범위 확장) —
        # target="channel_connection"·"generation_connector" stage 둘 다 이 루프가 묻는
        # org_connectors 레지스트리(설정 스킬이 에이전트 손으로 등록하는 것)와 완전히 다른
        # 준비 축이다 — 두 target의 실제 준비 여부는 이미 위(3251~3298행)의 apply 본문
        # 검증(role_mapping 값이 이 org의 실존·active ChannelConnection/OrgGenerationConnector
        # 인지, 422)이 판정했다. 그런데 이 루프는 target을 안 보고 capability만 있으면 전부
        # 돌아, publish kind의 channel_connection-target stage도 find_org_connectors_by_kind
        # (kind="publish")를 물어 레지스트리 미등록을 "미준비"로 오판했다(라이브 실사고: 채널
        # 연결 10건·발행자=Instagram Sandbox 선택해도 «채널을 먼저 연결하세요» 거짓 경고 —
        # 이미 연결된 채널을 "연결하라"는 모순 문장이었다). generation_connector-target은
        # 첫 push 시점엔 kind="generate"가 이미 _AGENT_TOOL_CAPABILITY_KINDS에 있어 아래
        # kind 스킵으로 "우연히" 커버됐지만, 그건 그 kind가 마침 겹쳤을 뿐(다른 kind로 선언된
        # generation_connector-target stage — 예: connector_key 없이 kind="publish"류 —
        # 는 여전히 오판 경로에 남아 있었다) — 두 target 다 명시로 같이 건너뛴다(우연한
        # 커버가 아니라 "이 target들은 애초에 이 루프의 대상이 아니다"라는 규칙 자체로).
        if _stage_target(stage) in ("channel_connection", "generation_connector"):
            continue
        # story #4108(페드루 PO 確定, 2026-09-21 · design CHANGES) — 준비 경고 문장에
        # 내부 식별자를 그대로 싣지 않는다(#4104가 해요체·목적지 문장으로 바꿨지만 stage
        # 자체는 여전히 repr 토큰이었다). stage_metadata[stage].role은 사람말이 아니라
        # 영어 enum(FE 정본 stage-role.ts 17종) — 그 집합에 있으면 카탈로그 한글 라벨로,
        # 미등재(조직 커스텀) role은 raw pass-through(FE stageRoleLabel과 동형 원칙),
        # role 자체가 비어 있는 방어적 경우(이론상 도달 불가)에만 stage 키로 폴백.
        role = stage_meta.get("role")
        if role:
            role_label = t(f"events.stage_role.{role}", "ko") if role in _STAGE_ROLE_LABEL_KEYS else role
            stage_label = t("events.apply_stage_role_label", "ko", role=role_label)
        else:
            stage_label = stage
        # story #4104(페드루 PO 라이브 실측·판단, 2026-09-21) — 준비 경고는 «org 커넥터로
        # 채워지는 kind»만 대상이다. target 필드(#4090)로는 못 가른다 — collect/publish
        # 같은 커넥터-백드 kind도 target 기본값이 "agent"라 attach_video/generate(에이전트
        # 자기 도구 힌트)와 구분이 안 된다. 새 필드를 만드는 대신 이미 있는 닫힌 선언
        # (`_CAPABILITY_KIND_HINTS` — 자기설명 멘션이 "이 kind는 에이전트가 자기 도구로
        # 처리"라고 말하는 바로 그 자리)을 재사용한다 — 같은 원천, 새 kind는 거기 한 줄만
        # 늘리면 이 스킵도 자동으로 맞는다(발명 0·하드코딩 0).
        if kind in _AGENT_TOOL_CAPABILITY_KINDS:
            continue
        # story #3359 — capability.connector_key는 정의 저자가 적은 채널 라벨(예:
        # "threads"·"blog")이지 반드시 실 connector_key는 아니다. 리졸버(진리원천 하나,
        # publish 다음-행동 문구와 동일 함수)로 해소한다 — 매핑 없으면 옛처럼 "그 커넥터가
        # 없다"로 오인시키지 않고 "channel=X 매핑 없음"으로 명시(삼키지 않는다).
        declared_channel = capability.get("connector_key")
        connector_key = (
            await resolve_connector_key_for_channel(db, org_id=org_id, channel=declared_channel)
            if declared_channel else None
        )
        if declared_channel and not connector_key:
            warnings.append(t("events.apply_channel_connector_map_missing", "ko", stage_label=stage_label, channel=declared_channel))
            continue
        if connector_key:
            row = await get_org_connector(db, org_id=org_id, connector_key=connector_key)
            if row is None:
                warnings.append(t("events.apply_connector_registered_missing", "ko", stage_label=stage_label, connector_key=connector_key))
                continue
            missing = missing_required_org_config(row)
            if missing:
                # story #4108 CHANGES(페드루 PO 리뷰, 2026-09-21) — missing이 list[str]
                # 그대로 .format()에 들어가면 파이썬 list repr(대괄호·따옴표, `['api_key']`)
                # 이 그대로 문장에 실린다 — 이 카드 AC1 "값은 따옴표 없는 사람말" 그 자체
                # 위반이라 별건이 아니라 스코프 안. 쉼표로 이어 붙인 사람말 목록으로.
                warnings.append(t("events.apply_connector_config_incomplete", "ko", stage_label=stage_label, connector_key=connector_key, missing=", ".join(missing)))
        else:
            # story #4119 — 경고 문장의 {kind} 자리는 org 커넥터 조회용 원시 kind(위
            # find_org_connectors_by_kind 호출)가 아니라 사람말 라벨을 받는다. 등재
            # 안 된 kind는 raw pass-through(#4108 role 규칙과 동형).
            kind_label = t(f"events.capability_kind.{kind}", "ko") if kind in _CAPABILITY_KIND_LABEL_KEYS else kind
            candidates = await find_org_connectors_by_kind(db, org_id=org_id, kind=kind)
            if not candidates:
                warnings.append(t("events.apply_kind_connector_not_registered", "ko", stage_label=stage_label, kind=kind_label))
            elif not any(not missing_required_org_config(c) for c in candidates):
                warnings.append(t("events.apply_kind_connector_config_incomplete", "ko", stage_label=stage_label, kind=kind_label))

    actor_id: uuid.UUID | None = None
    try:
        actor_id = uuid.UUID(str(auth.user_id))
    except Exception:
        pass

    # SQL NULL은 `= NULL`로 안 잡힌다(IS NULL 필요) — project_id 스코프 절을 조건부로 구성.
    project_scope_clause = (
        RecipeRoleBinding.project_id.is_(None) if body.project_id is None
        else RecipeRoleBinding.project_id == body.project_id
    )

    upserted = 0
    for stage, value_str in body.role_mapping.items():
        value_id = uuid.UUID(value_str)
        target = _stage_target(stage)
        col_agent = value_id if target == "agent" else None
        col_channel = value_id if target == "channel_connection" else None
        col_generation = value_id if target == "generation_connector" else None
        existing = (await db.execute(
            select(RecipeRoleBinding).where(
                RecipeRoleBinding.org_id == org_id,
                project_scope_clause,
                RecipeRoleBinding.event_definition_key == definition.key,
                RecipeRoleBinding.stage == stage,
            )
        )).scalar_one_or_none()
        if existing is not None:
            # story #4090/#4101 — 재-apply가 같은 stage를 다른 target kind로 바꿀 수도 있다
            # (예: 정의 개정으로 capability가 붙거나 빠짐) — 세 컬럼 다 명시로 재설정해야
            # CHECK(ck_recipe_role_bindings_exactly_one_target)가 안 걸린다(한쪽만
            # setattr하면 구 값이 다른 컬럼에 남아 XOR 위반).
            existing.agent_member_id = col_agent
            existing.channel_connection_id = col_channel
            existing.generation_connector_id = col_generation
        else:
            db.add(RecipeRoleBinding(
                org_id=org_id, project_id=body.project_id, event_definition_key=definition.key,
                stage=stage,
                agent_member_id=col_agent,
                channel_connection_id=col_channel,
                generation_connector_id=col_generation,
                created_by=actor_id,
            ))
        upserted += 1

    await db.commit()
    return ApplyRecipeRoleBindingsResponse(ok=True, bindings_upserted=upserted, warnings=warnings)


class RecipeRoleBindingsResponse(BaseModel):
    bindings: dict[str, str]


@router.get("/definitions/{definition_id}/bindings", response_model=RecipeRoleBindingsResponse)
async def get_recipe_role_bindings(
    definition_id: uuid.UUID,
    project_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> RecipeRoleBindingsResponse:
    """GET /api/v2/events/definitions/{id}/bindings — story #3293(축2-ⓒ §B).

    축2-ⓐ(apply, story #3288)는 쓰기(upsert)만 만들었다 — 갤러리 FE가 "이미 배정됨"
    배지·기존 role_mapping 프리필을 하려면 이 read가 필요(doc
    axis2c-gallery-migration-map-and-design §3-B). project_id 지정 시 그 project
    특이성 바인딩이 org 전역보다 우선(event_routing_resolver.py의 조회 우선순위와
    동형 — 여기도 그대로 병합해 "실제로 발행 시 어느 값이 쓰일지"와 일치하는 뷰를
    보여준다). project_id 미지정 시 org 전역 바인딩만.
    """
    from app.models.event_definition import EventDefinition
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.services.project_auth import require_project_access

    if project_id is not None:
        await require_project_access(db, uuid.UUID(auth.user_id), project_id, org_id, not_found_detail="Project not found")

    definition = (await db.execute(
        select(EventDefinition).where(
            EventDefinition.id == definition_id,
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        )
    )).scalar_one_or_none()
    if definition is None:
        raise HTTPException(status_code=404, detail="event definition not found")

    # story #4090/#4101 — 셋 중 정확히 하나만 채워지므로(DB CHECK) coalesce로 하나의
    # 문자열 값만 반환한다(agent_member_id/channel_connection_id/generation_connector_id
    # 어느 쪽이든 호출부 입장에선 "이 stage의 role_mapping 값"으로 동형 — apply 요청
    # 바디와 왕복 대칭). org 전역(project_id IS NULL) 먼저 채우고, project 특이성으로
    # 덮어써 우선순위를 정확히 반영(project_scope_clause와 동형 우선순위, resolver의
    # 실 조회 순서와 일치).
    binding_value = func.coalesce(
        RecipeRoleBinding.agent_member_id, RecipeRoleBinding.channel_connection_id,
        RecipeRoleBinding.generation_connector_id,
    )
    org_wide = (await db.execute(
        select(RecipeRoleBinding.stage, binding_value).where(
            RecipeRoleBinding.org_id == org_id,
            RecipeRoleBinding.project_id.is_(None),
            RecipeRoleBinding.event_definition_key == definition.key,
        )
    )).all()
    bindings: dict[str, str] = {stage: str(value) for stage, value in org_wide}

    if project_id is not None:
        project_scoped = (await db.execute(
            select(RecipeRoleBinding.stage, binding_value).where(
                RecipeRoleBinding.org_id == org_id,
                RecipeRoleBinding.project_id == project_id,
                RecipeRoleBinding.event_definition_key == definition.key,
            )
        )).all()
        for stage, value in project_scoped:
            bindings[stage] = str(value)

    return RecipeRoleBindingsResponse(bindings=bindings)


class RecipeStartCandidate(BaseModel):
    definition_id: str
    key: str
    name: str
    # story #4202 — FE가 플랫폼 프리셋(None)만 로케일 문안으로 바꿔 그린다(조직 정의는 원문).
    # EventDefinitionResponse.org_id와 같은 꼴.
    org_id: str | None = None
    first_stage: str
    role_bound: bool
    started: bool
    conversation_id: str | None = None
    message_id: str | None = None
    # story #4082([E-RECIPE-1] 진행 위치 표시) — started=True일 때만 채워진다(시작 전엔
    # "지금 단계"라는 질문 자체가 성립하지 않는다). current_stage는 이 work_item에 이
    # 정의로 발행된 가장 최근 stage(어느 stage든, _find_latest_stage_publish)이지 항상
    # first_stage가 아니다 — 3단계까지 진행됐으면 current_stage="stage3". next_stage는
    # payload_schema.stage.enum 순서상 다음 값(마지막 stage면 None — "마지막 단계"는 FE
    # 표시 문구, BE는 정직하게 없음만 알린다).
    current_stage: str | None = None
    current_role: str | None = None
    next_stage: str | None = None
    next_role: str | None = None
    last_published_at: datetime | None = None
    # story #4082(유나 design CHANGES 2026-09-21) — current_stage가 recipe-stage-label.ts의
    # 고정 테이블에 없는(미등재) slug일 때 FE가 raw 값을 그대로 못 띄우게(내부어 노출 0)
    # «단계 n/9»류 자리표시로 대체할 수 있게, 이미 stage_enum.index()로 구한 위치를
    # 1-indexed로 얹는다(새 조회 0 — next_stage 계산과 같은 자리에서 파생).
    current_stage_position: int | None = None
    total_stages: int | None = None


class RecipeStartCandidatesResponse(BaseModel):
    candidates: list[RecipeStartCandidate]


@router.get("/definitions/start-candidates", response_model=RecipeStartCandidatesResponse)
async def get_recipe_start_candidates(
    project_id: uuid.UUID,
    work_item_type: str = Query(...),
    work_item_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> RecipeStartCandidatesResponse:
    """GET /api/v2/events/definitions/start-candidates — story #4075 AC1/AC6.

    스토리 화면 «레시피 시작» 진입점의 활성화 판단용 단일 읽기. "적용된 레시피"는 신규
    상태 필드가 아니라 RecipeRoleBinding에 이 project(또는 org 전역, project_id IS NULL)
    행이 하나라도 있는 정의(apply_recipe_role_bindings가 그 upsert 유일 진입점, story
    #3288) — 여기서도 신규 "적용" 컬럼을 만들지 않는다. 정의별로 첫 stage
    (payload_schema.stage.enum[0], _cyclic_stages·get_event_publish_history와 동일 SSOT)
    에 role이 실제로 바인딩됐는지(role_bound)와 이미 발행됐는지(started —
    `_find_existing_stage_publish` 재사용, `_publish_registry_event_core`의 dedup 판정과
    동일 SSOT라 새로고침·다른 탭·다른 사람 화면에서도 같게 보인다, AC6)를 한 번에 반환해
    FE가 정의 수만큼 왕복하지 않게 한다.
    """
    from app.models.event_definition import EventDefinition
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.services.project_auth import require_project_access

    await require_project_access(db, uuid.UUID(auth.user_id), project_id, org_id, not_found_detail="Project not found")

    binding_rows = (await db.execute(
        select(RecipeRoleBinding.event_definition_key, RecipeRoleBinding.stage).where(
            RecipeRoleBinding.org_id == org_id,
            or_(RecipeRoleBinding.project_id == project_id, RecipeRoleBinding.project_id.is_(None)),
        )
    )).all()
    if not binding_rows:
        return RecipeStartCandidatesResponse(candidates=[])
    bound_pairs = {(k, s) for k, s in binding_rows}
    applied_keys = sorted({k for k, _s in binding_rows})

    definitions = (await db.execute(
        select(EventDefinition)
        .where(
            EventDefinition.key.in_(applied_keys),
            EventDefinition.enabled.is_(True),
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        )
        # org 커스텀이 프리셋보다 우선(apply_recipe_role_bindings·_publish_registry_event_core
        # 와 동일 우선순위) — key당 먼저 만난 행만 채택.
        .order_by(EventDefinition.org_id.is_(None))
    )).scalars().all()
    by_key: dict[str, "EventDefinition"] = {}
    for d in definitions:
        by_key.setdefault(d.key, d)

    candidates: list[RecipeStartCandidate] = []
    for key in applied_keys:
        definition = by_key.get(key)
        if definition is None:
            continue
        stage_enum = ((definition.payload_schema.get("properties") or {}).get("stage") or {}).get("enum")
        if not isinstance(stage_enum, list) or not stage_enum:
            continue
        first_stage = stage_enum[0]
        role_bound = (key, first_stage) in bound_pairs

        existing_publish = await _find_existing_stage_publish(
            db, org_id=org_id, definition_key=key,
            work_item_type=work_item_type, work_item_id=str(work_item_id), stage=str(first_stage),
        )

        # story #4082 — 시작된 레시피만 "지금 어느 단계·다음은 누구·언제 마지막으로
        # 발행됐는지"를 추가로 읽는다(시작 전엔 물을 질문이 아니다). _render_event_
        # message_content(위)의 "다음 단계" 계산과 동일 SSOT(payload_schema.stage.enum
        # 순서 + stage_metadata) — 새 파생 로직 발명 안 함.
        current_stage = current_role = next_stage = next_role = None
        current_stage_position = None
        last_published_at = None
        if existing_publish is not None:
            latest = await _find_latest_stage_publish(
                db, org_id=org_id, definition_key=key,
                work_item_type=work_item_type, work_item_id=str(work_item_id),
            )
            if latest is not None:
                last_published_at = latest.created_at
                event_payload = ((latest.msg_metadata or {}).get("event") or {}).get("payload") or {}
                stage_value = event_payload.get("stage")
                if isinstance(stage_value, str):
                    current_stage = stage_value
                    current_role = (definition.stage_metadata.get(stage_value) or {}).get("role")
                    if stage_value in stage_enum:
                        idx = stage_enum.index(stage_value)
                        current_stage_position = idx + 1
                        if idx + 1 < len(stage_enum):
                            next_stage = stage_enum[idx + 1]
                            next_role = (definition.stage_metadata.get(next_stage) or {}).get("role")

        candidates.append(RecipeStartCandidate(
            definition_id=str(definition.id),
            key=definition.key,
            name=definition.name,
            org_id=str(definition.org_id) if definition.org_id else None,
            first_stage=first_stage,
            role_bound=role_bound,
            started=existing_publish is not None,
            conversation_id=str(existing_publish.conversation_id) if existing_publish else None,
            message_id=str(existing_publish.id) if existing_publish else None,
            current_stage=current_stage,
            current_role=current_role,
            next_stage=next_stage,
            next_role=next_role,
            last_published_at=last_published_at,
            current_stage_position=current_stage_position,
            total_stages=len(stage_enum) if current_stage is not None else None,
        ))

    return RecipeStartCandidatesResponse(candidates=candidates)


async def _resolve_crew_scoped_recipe_binding(
    db: AsyncSession, *, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID,
    auth: AuthContext, capability_target: str, code_prefix: str, binding_id_column,
) -> tuple[uuid.UUID, str, object]:
    """story #4132 CHANGES-1(페드루 PO 리뷰, 2026-09-22) — `get_my_generation_connector`
    (#4110/#4109 PO 결정)와 `get_my_channel_connection_status`(#4132)가 판정 1~6단계를
    ~150줄 그대로 복사하고 있었다: target 문자열·바인딩 id 컬럼·에러 코드 접두만 달랐다.
    두 엔드포인트 docstring이 스스로 "순서 자체가 계약"이라 썼는데 계약이 두 벌이면
    다음 #4124류 수정(넓은 crew 사전 관문이 그 예)을 두 번 해야 하고, 한 벌만 고쳐지면
    그날부터 두 엔드포인트가 다른 판정을 한다 — 이 함수로 공용화해 그 위험을 구조로
    없앤다. 7단계(호출부별 커넥터/연결 조회 + 그 결과에 따른 응답 형태)와 응답 조립은
    각 엔드포인트에 남는다(이 함수는 "바인딩 id 하나를 안전하게 해소"까지만 책임).

    판정 순서(전부 되돌리면 RED — 이 함수 하나를 두 스위트(`test_4110_generation_
    connector_read_realdb.py`·`test_4132_channel_connection_status_realdb.py`)가
    공유하므로, 순서를 깨는 변경은 두 스위트 모두에서 RED가 난다 — 뮤테이션으로 직접
    확認, PR#4509 CHANGES-1):
    1. 호출자가 agent 아니면(human) 403 — 자격 인접 엔드포인트는 "누가 부르는지"로
       먼저 가른다(사람용 BFF들의 반대축).
    2. work_item → project를 못 찾으면(work item 자체가 없음) 404.
    3. ⛔story #4124(PO 실측, 2026-09-21) — 이 project(+ org 전역)에 **적용된**(바인딩이
       하나라도 있는) 모든 event_definition_key에 걸쳐, 호출 에이전트가 그 어느 키에도
       `RecipeRoleBinding.agent_member_id`로 안 묶여 있으면 여기서 바로 403(그 다음
       검사 0 — stage 매칭도 안 돈다). #4110 CHANGES-1이 crew 판정을 바인딩/자격
       조회보다 앞으로 옮겼지만 그 판정 자체가 아래 4번(stage 매칭 루프, matched_key
       필요) **뒤**에 있었다 — 완전히 crew 밖인 호출자(라이브 실측: 이 project/org
       어느 적용에도 전혀 안 묶인 에이전트)도 그 루프가 먼저 돌아 "지금 활성 target
       stage가 없다"(stage-mismatch, 4번)는 사실을 crew 판정보다 먼저 알 수 있었다.
       이 넓은 사전 관문이 그 구멍을 막는다.
    4. 그 project(+ org 전역)에 바인딩된 레시피 중 **이 work_item에 실제로 시작된**
       것(`get_recipe_start_candidates`와 동일 SSOT — `_find_existing_stage_publish`로
       "시작됐는가", `_find_latest_stage_publish`로 "지금 어느 stage인가")을 찾아, 그
       현재 stage 중 `capability.target==capability_target`인 게 하나도 없으면 403
       (stage 불일치 — "지금 이 도구를 쓸 차례가 아니다"). 여러 레시피가 동시에 걸려도
       새 판정을 안 짓는다 — target이 맞는 stage가 하나라도 나오면 그것을 쓴다.
    5. 호출 에이전트가 이 특정 matched_key의 crew(#4109 PO 결정 — 같은 org·[project
       특이 ∪ org 전역]·event_definition_key의 `RecipeRoleBinding.agent_member_id`
       집합) 밖이면 403 — 3번(넓은 사전 관문)을 통과했어도(다른 키의 crew일 뿐) 이
       좁은 최종 판정은 그대로 지킨다(다른 적용의 crew가 이 stage를 요청하는 경계
       사례를 여전히 정확히 막는다). `resolve_member().id` 직접비교는 휴먼 JWT
       caller에서 축이 어긋날 수 있다는 기존 경고(S19)가 있으나 그건 human 축 얘기 —
       1번에서 이미 agent만 통과시켰고 `agent_member_id` 자체가 agent 전용 컬럼
       (TeamMember.id 공간)이라 여기선 axis-safe.
    6. 그 stage에 바인딩된 `binding_id_column`(호출부가 넘기는 `RecipeRoleBinding.
       generation_connector_id`|`.channel_connection_id`) 값이 없으면 404(project
       특이 우선, org 전역 폴백 — `_resolve_recipe_role_binding`과 동일 우선순위).

    반환: `(caller.id, matched_stage, binding_id)` — 호출부가 7단계(자기 자원 조회 +
    응답 조립)를 이어서 한다.
    """
    from app.models.event_definition import EventDefinition
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.services.event_routing_resolver import _resolve_work_item_project_id, resolve_broad_crew_member_ids
    from app.services.member_resolver import resolve_member

    caller = await resolve_member(auth, org_id, db)
    if caller.type != "agent":
        raise HTTPException(status_code=403, detail={"code": f"{code_prefix}_READ_AGENT_ONLY"})

    project_id = await _resolve_work_item_project_id(
        db, org_id=org_id,
        payload={"work_item_type": work_item_type, "work_item_id": str(work_item_id)},
    )
    if project_id is None:
        raise HTTPException(status_code=404, detail={"code": f"{code_prefix}_WORK_ITEM_NOT_FOUND"})

    # story #4147 — 넓은 crew 집합 계산은 event_routing_resolver.py::resolve_broad_crew_
    # member_ids로 뽑혀나갔다(SQL 그대로 이동, 새 판정 0) — channel_posts.py(#4147 draft
    # 미디어 참여 판정)도 이제 같은 함수를 쓴다. applied_keys 자체는 아래 stage-매칭
    # 루프가 그대로 필요해 여기 남긴다(그 함수 내부에서 한 번 더 계산되지만 이 판정
    # 순서·결과는 원래 인라인 코드와 동일 — 쿼리 중복 1회는 두 관심사(누가 crew인지 vs
    # 어느 stage가 지금 활성인지)를 억지로 한 값에 묶지 않기 위한 트레이드오프).
    binding_rows = (await db.execute(
        select(RecipeRoleBinding.event_definition_key).where(
            RecipeRoleBinding.org_id == org_id,
            or_(RecipeRoleBinding.project_id == project_id, RecipeRoleBinding.project_id.is_(None)),
        )
    )).all()
    applied_keys = sorted({k for (k,) in binding_rows})

    broad_crew_ids = await resolve_broad_crew_member_ids(db, org_id=org_id, project_id=project_id)
    if caller.id not in broad_crew_ids:
        raise HTTPException(status_code=403, detail={"code": f"{code_prefix}_CREW_ONLY"})

    matched_key: str | None = None
    matched_stage: str | None = None
    if applied_keys:
        definitions = (await db.execute(
            select(EventDefinition)
            .where(
                EventDefinition.key.in_(applied_keys),
                EventDefinition.enabled.is_(True),
                or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
            )
            .order_by(EventDefinition.org_id.is_(None))
        )).scalars().all()
        by_key: dict[str, EventDefinition] = {}
        for d in definitions:
            by_key.setdefault(d.key, d)

        for key in applied_keys:
            definition = by_key.get(key)
            if definition is None:
                continue
            stage_enum = ((definition.payload_schema.get("properties") or {}).get("stage") or {}).get("enum")
            if not isinstance(stage_enum, list) or not stage_enum:
                continue
            first_stage = stage_enum[0]
            existing_publish = await _find_existing_stage_publish(
                db, org_id=org_id, definition_key=key,
                work_item_type=work_item_type, work_item_id=str(work_item_id), stage=str(first_stage),
            )
            if existing_publish is None:
                continue
            latest = await _find_latest_stage_publish(
                db, org_id=org_id, definition_key=key,
                work_item_type=work_item_type, work_item_id=str(work_item_id),
            )
            if latest is None:
                continue
            event_payload = ((latest.msg_metadata or {}).get("event") or {}).get("payload") or {}
            stage_value = event_payload.get("stage")
            if not isinstance(stage_value, str):
                continue
            capability = (definition.stage_metadata.get(stage_value) or {}).get("capability") or {}
            if capability.get("target") == capability_target:
                matched_key, matched_stage = key, stage_value
                break

    if matched_stage is None or matched_key is None:
        raise HTTPException(status_code=403, detail={"code": f"{code_prefix}_STAGE_MISMATCH"})

    crew_ids = set((await db.execute(
        select(RecipeRoleBinding.agent_member_id).where(
            RecipeRoleBinding.org_id == org_id,
            RecipeRoleBinding.event_definition_key == matched_key,
            RecipeRoleBinding.agent_member_id.is_not(None),
            or_(RecipeRoleBinding.project_id == project_id, RecipeRoleBinding.project_id.is_(None)),
        )
    )).scalars().all())
    if caller.id not in crew_ids:
        raise HTTPException(status_code=403, detail={"code": f"{code_prefix}_CREW_ONLY"})

    binding_id = (await db.execute(
        select(binding_id_column).where(
            RecipeRoleBinding.org_id == org_id,
            RecipeRoleBinding.project_id == project_id,
            RecipeRoleBinding.event_definition_key == matched_key,
            RecipeRoleBinding.stage == matched_stage,
        )
    )).scalar_one_or_none()
    if binding_id is None:
        binding_id = (await db.execute(
            select(binding_id_column).where(
                RecipeRoleBinding.org_id == org_id,
                RecipeRoleBinding.project_id.is_(None),
                RecipeRoleBinding.event_definition_key == matched_key,
                RecipeRoleBinding.stage == matched_stage,
            )
        )).scalar_one_or_none()
    if binding_id is None:
        raise HTTPException(status_code=404, detail={"code": f"{code_prefix}_BINDING_NOT_FOUND"})

    return caller.id, matched_stage, binding_id


class GenerationConnectorReadResponse(BaseModel):
    """story #4110(#4109 PO 결정, 2026-09-21) — 바인딩 crew 에이전트 전용 읽기 응답.
    org_generation_connectors.py::GenerationConnectorResponse(사람용 BFF)와 달리
    credentials 필드가 **있다** — 그쪽은 write-only 계약(사람 화면엔 절대 노출 안 함)이고
    이 경로는 애초에 에이전트가 그 값으로 provider를 직접 호출하라고 짓는 자리라 반환이
    곧 계약이다(#4095 Q①(b) — 제품이 아니라 에이전트가 자기 실행)."""
    model_config = {"protected_namespaces": ()}

    provider_key: str
    label: str
    model_config_json: dict
    # story #4140(페드루 PO 처방, 2026-09-22) — 제품이 정한 리전 정책값. crew는 이 값
    # «그대로만» 호출한다(재량 0) — 2호 실사고(aa1c2330·gemini-2.5-flash-image가
    # asia-northeast3에서 404 → 댄군 자체 판단으로 global 재시도)의 직접 처방.
    # `resolve_generation_connector_location()` 단일 통로(org_generation_connectors.py의
    # 사람용 응답과 동일 해소 로직 공유 — 두 벌 계약 방지, #4132 CHANGES-1 선례).
    location: str
    credentials: str


@router.get(
    "/work-items/{work_item_type}/{work_item_id}/generation-connector",
    response_model=GenerationConnectorReadResponse,
)
async def get_my_generation_connector(
    work_item_type: str,
    work_item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> GenerationConnectorReadResponse:
    """story #4110(#4109 그라운딩 doc 733459ac «PO 결정», 2026-09-21) — 바인딩 crew
    에이전트가 자기 레시피 적용의 generation_connector-target stage에 바인딩된 org
    연산 커넥터 config·자격을 읽는다. `decrypt_generation_connector_credential()`의
    첫 실제 호출처(#4101이 write-only로 지어둔 뒤 콜러 0이었던 것을 #4109 그라운딩이
    확認 — 이 카드가 그 첫 독자).

    판정 1~6단계는 `_resolve_crew_scoped_recipe_binding`(story #4132 CHANGES-1로
    `get_my_channel_connection_status`와 공유 — 순서 자체가 계약이라 계약을 한 벌로
    합쳤다) 위임. 여기 남는 건 7단계뿐:
    7. 그 커넥터가 이 org 소속이 아니거나 존재하지 않으면 404, `status != "active"`면
       409(자격 인접 엔드포인트라 "재인증 필요"를 200으로 알려주지 않는다 —
       `get_my_channel_connection_status`와 의도적으로 다른 지점).
    8. 감사 로그 1행 — `logger.info`(구조화, 자격값 절대 미포함). 신규 DB 테이블/마이그
       0: `permission_audit_logs`는 `action` 닫힌 CHECK(member_added/member_removed/
       role_changed, baseline/schema.sql 1541행 실측)라 이 목적에 안 맞아 재사용하지
       않는다 — 새 테이블을 여는 대신(스코프 밖) 기존 로그 축에 싣는다.
    9. `{provider_key, label, model_config_json, location, credentials}` 평문 1회 반환
       (story #4140 — `location`은 제품이 해소한 정책값, crew 재량 0).
    """
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.services.generation_connector_credential_crypto import (
        decrypt_generation_connector_credential,
    )
    from app.services.org_generation_connector import (
        get_org_generation_connector,
        resolve_generation_connector_location,
    )

    caller_id, matched_stage, generation_connector_id = await _resolve_crew_scoped_recipe_binding(
        db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id, auth=auth,
        capability_target="generation_connector", code_prefix="GENERATION_CONNECTOR",
        binding_id_column=RecipeRoleBinding.generation_connector_id,
    )

    connector = await get_org_generation_connector(db, org_id=org_id, connector_id=generation_connector_id)
    if connector is None:
        raise HTTPException(status_code=404, detail={"code": "GENERATION_CONNECTOR_BINDING_NOT_FOUND"})
    if connector.status != "active":
        raise HTTPException(status_code=409, detail={"code": "GENERATION_CONNECTOR_REVOKED"})

    logger.info(
        "generation_connector_read: actor=%s org=%s connector=%s work_item=%s:%s stage=%s",
        caller_id, org_id, connector.id, work_item_type, work_item_id, matched_stage,
    )

    return GenerationConnectorReadResponse(
        provider_key=connector.provider_key,
        label=connector.label,
        model_config_json=connector.model_config_json,
        location=resolve_generation_connector_location(connector.model_config_json),
        credentials=decrypt_generation_connector_credential(connector.encrypted_credentials),
    )


class ChannelConnectionStatusReadResponse(BaseModel):
    """story #4132 — 바인딩 crew 에이전트 전용 상태 읽기. 자격/토큰/계정 식별자 0 —
    `channel_connections.py::ChannelConnectionResponse`(사람용 BFF)는 account_id까지
    노출하지만 이 응답은 발행 전 "쓸 수 있는지"만 답하는 게 계약이라 그보다도 더 좁다."""
    connection_id: uuid.UUID
    provider: str
    status: str
    needs_reauth: bool
    # story #4132 CHANGES-1(PO 리뷰) — 이 값은 `ChannelConnection.last_refreshed_at`을
    # 크루 친화적 이름으로 노출한 것뿐(같은 컬럼, 별도 "동작 확認" 이벤트가 실제로
    # 있어 찍히는 타임스탬프가 아니다) — 이름만 보고 "방금 provider를 호출해 확認한
    # 시각"으로 과신하지 말 것(last_refreshed_at은 토큰 갱신 성공 시각).
    last_verified_at: str | None
    display_name: str | None


@router.get(
    "/work-items/{work_item_type}/{work_item_id}/channel-connection",
    response_model=ChannelConnectionStatusReadResponse,
)
async def get_my_channel_connection_status(
    work_item_type: str,
    work_item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ChannelConnectionStatusReadResponse:
    """story #4132(민 실측 2026-09-21 20:21Z, PO 실측 23:40Z) — 발행(published) 단계를
    맡은 crew 에이전트가 자기 바인딩된 채널 연결이 살아 있는지(재인증 필요 여부)를
    발행 시점 전에 미리 안다. `channel-connections`(사람 전용 BFF, 403)의 자격 인접
    대안.

    판정 1~6단계는 `_resolve_crew_scoped_recipe_binding`(#4110/#4124와 공유, CHANGES-1
    — target 문자열만 "generation_connector"→"channel_connection") 위임. 여기 남는
    건 7단계뿐:
    7. 그 연결이 이 org 소속이 아니거나 존재하지 않으면 404. **generation-connector와
       달리 status!="active"여도 409를 안 던진다** — "재인증이 필요하다"는 사실 자체가
       이 엔드포인트가 답해야 하는 정보라, revoked/expired/error도 200으로 status·
       needs_reauth에 실어 보고한다(AC1 명시 — "연결 revoked/disconnected면 그 상태를
       200으로 보고").
    8. 감사 로그 1행 — `logger.info`(자격값 0, generation-connector와 동일 관례).
    9. `{connection_id, provider, status, needs_reauth, last_verified_at, display_name}`
       반환. `needs_reauth = status != "active"` — FE
       `components/channel-connect/connection-status.ts::deriveChannelConnectionStatus`가
       이미 이 판별(serverStatus가 expired/revoked/error면 reauth_required)을 쓰는
       SSOT라 새 규칙을 여기서 발명하지 않는다.
    """
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.services.channel_connection import get_channel_connection

    caller_id, matched_stage, channel_connection_id = await _resolve_crew_scoped_recipe_binding(
        db, org_id=org_id, work_item_type=work_item_type, work_item_id=work_item_id, auth=auth,
        capability_target="channel_connection", code_prefix="CHANNEL_CONNECTION",
        binding_id_column=RecipeRoleBinding.channel_connection_id,
    )

    connection = await get_channel_connection(db, org_id=org_id, connection_id=channel_connection_id)
    if connection is None:
        raise HTTPException(status_code=404, detail={"code": "CHANNEL_CONNECTION_BINDING_NOT_FOUND"})

    logger.info(
        "channel_connection_status_read: actor=%s org=%s connection=%s work_item=%s:%s stage=%s",
        caller_id, org_id, connection.id, work_item_type, work_item_id, matched_stage,
    )

    return ChannelConnectionStatusReadResponse(
        connection_id=connection.id,
        provider=connection.channel,
        status=connection.status,
        needs_reauth=connection.status != "active",
        last_verified_at=connection.last_refreshed_at.isoformat() if connection.last_refreshed_at else None,
        display_name=connection.account_label,
    )


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

    # story #4081 — `.msg_metadata["event"]["event_key"]`(bracket accessor)는 JSON 키를
    # bind parameter로 컴파일해 0384 표현식 인덱스가 generic plan에서 안 탈 수 있다
    # (_find_existing_stage_publish 문서화 근거 그대로) — 키를 text()로 리터럴 고정.
    rows = (await db.execute(
        select(ConversationMessage)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(
            Conversation.org_id == org_id,
            text("conversation_messages.metadata->'event'->>'event_key' = :event_lookup_definition_key"),
        )
        .params(event_lookup_definition_key=definition_key)
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
