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
) -> None:
    """활성 push_devices 로 Expo push 발송(웹훅과 나란한 별개 채널).

    - 대상 = enabled 멤버(설정 통과) − global mute(능동 push off). 웹훅 유무와 독립.
    - 디바이스당 1발(이중발송 0). 배치 ≤100·메시지 최소화(≤4096B).
    - best-effort: 어떤 실패도 알림 파이프라인으로 전파 안 함(발송 실패가 in-app/Event 안 되돌림).
    - DeviceNotRegistered ticket → 그 토큰 is_active=false(자동 만료). 재발송 대상서 제외됨.
    """
    try:
        if not member_ids:
            return
        muted = muted_member_ids or set()
        targets = [m for m in member_ids if m not in muted]
        if not targets:
            return

        rows = await db.execute(
            select(PushDevice).where(
                PushDevice.org_id == org_id,
                PushDevice.member_id.in_(targets),
                PushDevice.is_active.is_(True),
            )
        )
        devices = list(rows.scalars().all())
        if not devices:
            return

        # 딥링크용 data(4096B 상한 고려 최소 필드만 — 탭→화면 착지에 필요한 것).
        data_payload: dict = {"event_type": event_type}
        if reference_type:
            data_payload["reference_type"] = reference_type
        if reference_id:
            data_payload["reference_id"] = str(reference_id)

        messages = [
            {
                "to": d.expo_push_token,
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
        for i in range(0, len(messages), _EXPO_MAX_BATCH):
            chunk = messages[i : i + _EXPO_MAX_BATCH]
            chunk_devices = devices[i : i + _EXPO_MAX_BATCH]
            tickets = await _expo_send_chunk(chunk)
            # ticket 은 메시지와 동순서. 개수 불일치(부분 응답) 시 zip 이 짧은 쪽 기준(안전).
            for dev, ticket in zip(chunk_devices, tickets):
                if isinstance(ticket, dict) and ticket.get("status") == "error":
                    err = (ticket.get("details") or {}).get("error")
                    if err == "DeviceNotRegistered":
                        dead_tokens.append(dev.expo_push_token)

        if dead_tokens:
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
    except Exception:
        # best-effort — 발송 실패가 알림 파이프라인을 되돌리지 않는다(AC: 비중단).
        logger.warning(
            "deliver_expo_push failed (swallowed·best-effort) org=%s event=%s",
            org_id, event_type, exc_info=True,
        )
