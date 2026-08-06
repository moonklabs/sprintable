"""EE Expo Push 발송기 (E-MOBILE M0·S3).

dispatch_notification(core)의 채널 확장 지점에서 호출됨 — push_devices(활성) 소비 → Expo Push
API 발송. 파이프라인 무변경(발송기는 별개 채널·best-effort). is_ee_enabled 환경에서만 core 훅이
이 모듈을 import/호출(비-EE 무동작).

crux §2 계약: POST exp.host/--/api/v2/push/send · 배치 ≤100/req · 메시지 ≤4096B · 신규 패키지 0
(httpx JSON POST) · 재시도/백오프 = dispatch_router 패턴 재사용 · DeviceNotRegistered → is_active=false.
receipt(getReceipts) 기반 지연 확인은 M1(관측)로 미룸 — M0은 send 응답 ticket 의 즉시 에러로 만료 판정.
"""
from __future__ import annotations

import asyncio
import json as _json
import logging
import uuid

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.push_device import PushDevice

# 재시도/백오프 = dispatch_router._post_with_retry 와 동일 정책(단일 SSOT 재사용).
from app.services.dispatch_router import _WEBHOOK_BACKOFF_BASE, _WEBHOOK_MAX_RETRIES

logger = logging.getLogger(__name__)

_EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send"
_EXPO_MAX_BATCH = 100  # crux §2: 최대 100개/요청


async def _expo_send_chunk(messages: list[dict]) -> list[dict]:
    """단일 청크(≤100) 발송 → ticket 리스트(응답 data) 반환. 5xx/429 는 backoff 재시도.

    _post_with_retry(bool 반환·HMAC 서명)와 달리 ticket 응답을 파싱해야 DeviceNotRegistered 를
    잡으므로 별도 함수 — 단 재시도 상수(_WEBHOOK_MAX_RETRIES/BACKOFF)는 그대로 재사용.
    """
    body = _json.dumps(messages)
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    for attempt in range(_WEBHOOK_MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(_EXPO_SEND_URL, content=body, headers=headers)
            # 429(MessageRateExceeded)·5xx 는 재시도, 그 외(2xx/4xx)는 응답 파싱.
            if resp.status_code != 429 and resp.status_code < 500:
                data = resp.json()
                return data.get("data", []) if isinstance(data, dict) else []
        except Exception:
            logger.warning(
                "expo push attempt %d/%d failed", attempt + 1, _WEBHOOK_MAX_RETRIES, exc_info=True
            )
        if attempt < _WEBHOOK_MAX_RETRIES - 1:
            await asyncio.sleep(_WEBHOOK_BACKOFF_BASE * (2 ** attempt))
    logger.warning("expo push all retries exhausted (%d msgs)", len(messages))
    return []


def _build_push_data_payload(
    *,
    event_type: str,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None = None,
    reference_type: str | None = None,
    reference_id: uuid.UUID | None = None,
    story_id: uuid.UUID | None = None,
    sprint_id: uuid.UUID | None = None,
) -> dict:
    """story #1953(P1a-S3): Expo push data payload 구성(순수 함수 — DB/IO 없음).

    org_id는 dispatch_notification()의 non-null 필수 파라미터라 **전 타입 항상 포함**
    (manifest DeepLinkPayloadFields.org_id_included=True 근거). project_id는 호출부가
    알고 있으면 포함하되(대부분의 타입은 project-scoped라 알고 있음), org-wide 브로드캐스트
    등 미상인 경우 키 자체를 생략(None/빈문자열로 오염하지 않음 — 클라이언트가 "값 없음"과
    "필드 없음"을 구분할 필요가 없게 아예 안 실음).

    story_id(task_completed)·sprint_id(가설 관련 dispatched/handoff_stuck)는 특정 타입에서만
    유의미한 타겟 보강 식별자 — 호출부가 안 넘기면(None) 생략.
    """
    data: dict = {"event_type": event_type, "org_id": str(org_id)}
    if project_id:
        data["project_id"] = str(project_id)
    if reference_type:
        data["reference_type"] = reference_type
    if reference_id:
        data["reference_id"] = str(reference_id)
    if story_id:
        data["story_id"] = str(story_id)
    if sprint_id:
        data["sprint_id"] = str(sprint_id)
    return data


async def deliver_expo_push(
    db: AsyncSession,
    org_id: uuid.UUID,
    member_ids: list[uuid.UUID],
    *,
    title: str,
    body: str | None,
    event_type: str,
    reference_type: str | None = None,
    reference_id: uuid.UUID | None = None,
    context: dict | None = None,
    muted_member_ids: set[uuid.UUID] | None = None,
    project_id: uuid.UUID | None = None,
    story_id: uuid.UUID | None = None,
    sprint_id: uuid.UUID | None = None,
    via_outbox: bool = False,
) -> None:
    """story #2460(§6 봉합②, PO 스코프 확定 2026-08-05): outbox 경유는 **opt-in**이다
    (``via_outbox=True``) — dispatch_notification 호출부 중 story_status_events.py·
    conversations.py send_message 둘만 켠다. 나머지 dispatch_notification 호출부는 기본값
    False로 기존과 동일하게 이 함수 안에서 즉시 발송한다(behavior 무변경).
    ``via_outbox=True``면 즉시 발송 대신 `delivery_jobs`에 job row만 insert(caller
    세션·트랜잭션에 실림, commit은 caller 책임 — at-least-once) — 실 발송은
    `delivery_dispatcher.py` 워커가 자기 세션으로 `_deliver_expo_push_now()`를 수행한다
    (요청 트랜잭션 밖에서 외부 I/O)."""
    if not member_ids:
        return
    if via_outbox:
        from app.models.delivery_job import DeliveryJob

        db.add(
            DeliveryJob(
                org_id=org_id,
                kind="expo_push",
                payload={
                    "member_ids": [str(m) for m in member_ids],
                    "title": title,
                    "body": body,
                    "event_type": event_type,
                    "reference_type": reference_type,
                    "reference_id": str(reference_id) if reference_id else None,
                    "context": context,
                    "muted_member_ids": (
                        [str(m) for m in muted_member_ids] if muted_member_ids is not None else None
                    ),
                    "project_id": str(project_id) if project_id else None,
                    "story_id": str(story_id) if story_id else None,
                    "sprint_id": str(sprint_id) if sprint_id else None,
                },
            )
        )
        return
    await _deliver_expo_push_now(
        db, org_id, member_ids, title=title, body=body, event_type=event_type,
        reference_type=reference_type, reference_id=reference_id, context=context,
        muted_member_ids=muted_member_ids, project_id=project_id, story_id=story_id,
        sprint_id=sprint_id,
    )


async def _deliver_expo_push_now(
    db: AsyncSession,
    org_id: uuid.UUID,
    member_ids: list[uuid.UUID],
    *,
    title: str,
    body: str | None,
    event_type: str,
    reference_type: str | None = None,
    reference_id: uuid.UUID | None = None,
    context: dict | None = None,
    muted_member_ids: set[uuid.UUID] | None = None,
    project_id: uuid.UUID | None = None,
    story_id: uuid.UUID | None = None,
    sprint_id: uuid.UUID | None = None,
) -> None:
    """활성 push_devices 로 Expo push 실발송(웹훅과 나란한 별개 채널) —
    `delivery_dispatcher.py` 워커 전용(자기 세션으로 호출).

    - 대상 = enabled 멤버(설정 통과) − global mute(능동 push off). 웹훅 유무와 독립.
    - 디바이스당 1발(이중발송 0). 배치 ≤100·메시지 최소화(≤4096B).
    - best-effort: 어떤 실패도 알림 파이프라인으로 전파 안 함(발송 실패가 in-app/Event 안 되돌림).
    - DeviceNotRegistered ticket → 그 토큰 is_active=false(자동 만료). 재발송 대상서 제외됨.
    - story #1953(P1a-S3): project_id/story_id/sprint_id는 딥링크 매니페스트 Layer 2 계약
      보강 필드 — dispatch_notification()이 이미 아는 값을 그대로 흘려보낸다(신규 조회 없음).

    story #2460 PO 리뷰(2026-08-05, F1) — 예전엔 이 함수가 DB 조회 直後 같은 함수 안에서
    Expo 발송(청크별 네트워크 I/O)까지 돌아, 호출자(`_deliver_one`)의 세션이 그 내내
    idle-in-transaction으로 열려 있었다(webhook_dispatch.py `_fire_webhooks_now`와 동형
    결함). `_fetch_expo_push_targets`(세션)/`_send_expo_push_targets`(세션 불요, dead_tokens
    반환)/`_finalize_expo_push_dead_tokens`(세션, 발송 後 토큰 비활성화)로 3분할 — 이 함수는
    셋을 순차 호출 + best-effort try/except로 감싸는 얇은 래퍼로 남긴다(기존 호출부
    via_outbox=False 시그니처·거동 무변경). 워커는 이 함수를 안 부르고 세 조각을 직접
    호출해 fetch/finalize 사이(발송 구간)엔 세션을 안 쥔다."""
    try:
        targets = await _fetch_expo_push_targets(db, org_id, member_ids, muted_member_ids=muted_member_ids)
        dead_tokens = await _send_expo_push_targets(
            targets, title=title, body=body, event_type=event_type, org_id=org_id,
            reference_type=reference_type, reference_id=reference_id,
            project_id=project_id, story_id=story_id, sprint_id=sprint_id,
        )
        await _finalize_expo_push_dead_tokens(db, org_id, dead_tokens)
    except Exception:
        # best-effort — 발송 실패가 알림 파이프라인을 되돌리지 않는다(AC: 비중단).
        logger.warning(
            "deliver_expo_push failed (swallowed·best-effort) org=%s event=%s",
            org_id, event_type, exc_info=True,
        )


async def _fetch_expo_push_targets(
    db: AsyncSession,
    org_id: uuid.UUID,
    member_ids: list[uuid.UUID],
    *,
    muted_member_ids: set[uuid.UUID] | None = None,
) -> list[dict]:
    """활성 push_devices를 조회해 mute 필터까지 마친 순수 dict 리스트로 반환한다. 세션 I/O는
    이 함수에서 끝(story #2460 PO 리뷰 F1)."""
    if not member_ids:
        return []
    muted = muted_member_ids or set()
    targets = [m for m in member_ids if m not in muted]
    if not targets:
        return []

    rows = await db.execute(
        select(PushDevice).where(
            PushDevice.org_id == org_id,
            PushDevice.member_id.in_(targets),
            PushDevice.is_active.is_(True),
        )
    )
    return [{"expo_push_token": d.expo_push_token} for d in rows.scalars().all()]


async def _send_expo_push_targets(
    devices: list[dict],
    *,
    title: str,
    body: str | None,
    event_type: str,
    org_id: uuid.UUID,
    reference_type: str | None = None,
    reference_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    story_id: uuid.UUID | None = None,
    sprint_id: uuid.UUID | None = None,
) -> list[str]:
    """세션 없이 순수 Expo 발송만(story #2460 PO 리뷰 F1). 반환값 = dead_tokens(호출자가
    `_finalize_expo_push_dead_tokens`로 반영)."""
    if not devices:
        return []

    # 딥링크용 data(4096B 상한 고려 최소 필드만 — 탭→화면 착지에 필요한 것).
    data_payload = _build_push_data_payload(
        event_type=event_type, org_id=org_id, project_id=project_id,
        reference_type=reference_type, reference_id=reference_id,
        story_id=story_id, sprint_id=sprint_id,
    )

    messages = [
        {
            "to": d["expo_push_token"],
            "title": title,
            "body": body or "",
            "data": data_payload,
            "sound": "default",
            "priority": "high",
            # story 1934/1935 후속(2026-07-17): Android 8+는 notification channel의
            # importance가 실제 헤드업/소리 여부를 결정(priority:"high"는 FCM 배달
            # 우선순위일 뿐 UI 표시와 무관) — 민 앱이 HIGH importance로 등록하는 채널
            # ID와 정확히 일치해야 한다(Expo 관례 "default"). 앱측 채널 ID가 다르면
            # 여기도 맞춰야 함.
            "channelId": "default",
        }
        for d in devices
    ]

    dead_tokens: list[str] = []
    ok_count = 0
    error_count = 0
    error_reasons: dict[str, int] = {}
    for i in range(0, len(messages), _EXPO_MAX_BATCH):
        chunk = messages[i:i + _EXPO_MAX_BATCH]
        chunk_devices = devices[i:i + _EXPO_MAX_BATCH]
        tickets = await _expo_send_chunk(chunk)
        # ticket 은 메시지와 동순서. 개수 불일치(부분 응답) 시 zip 이 짧은 쪽 기준(안전).
        for dev, ticket in zip(chunk_devices, tickets):
            if isinstance(ticket, dict) and ticket.get("status") == "error":
                error_count += 1
                err = (ticket.get("details") or {}).get("error") or ticket.get("message") or "unknown"
                error_reasons[err] = error_reasons.get(err, 0) + 1
                if err == "DeviceNotRegistered":
                    dead_tokens.append(dev["expo_push_token"])
            elif isinstance(ticket, dict) and ticket.get("status") == "ok":
                ok_count += 1

    # 2026-07-28(#2289): 성공 티켓은 이전까지 어디에도 안 남아 "서버가 쐈는데 실패" vs
    # "서버가 아예 안 쐈다"를 로그만으로 못 갈랐다(둘 다 조용함) — 매 발송마다 요약을 남긴다.
    # error_reasons는 Expo의 고정 에러 코드(DeviceNotRegistered·InvalidCredentials 등)만
    # 담는다 — 토큰 값은 절대 안 남긴다(시크릿에 준하는 취급).
    logger.info(
        "expo push: sent org=%s event=%s devices=%d ok=%d error=%d reasons=%s",
        org_id, event_type, len(devices), ok_count, error_count, error_reasons or None,
    )
    return dead_tokens


async def _finalize_expo_push_dead_tokens(
    db: AsyncSession, org_id: uuid.UUID, dead_tokens: list[str],
) -> None:
    """발송 後 확인된 DeviceNotRegistered 토큰을 비활성화(story #2460 PO 리뷰 F1 — 발송
    구간과 분리된 별도 짧은 세션에서 호출하는 것을 전제)."""
    if not dead_tokens:
        return
    await db.execute(
        update(PushDevice)
        .where(
            PushDevice.org_id == org_id,
            PushDevice.expo_push_token.in_(dead_tokens),
        )
        .values(is_active=False)
    )
    await db.flush()
    logger.info("expo push: deactivated %d DeviceNotRegistered token(s)", len(dead_tokens))
