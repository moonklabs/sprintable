"""EE APNs(macOS) 네이티브 푸시 발송기 (story #3064, E-MOBILE·macOS).

expo_push.py와 나란한 별개 채널 — macOS(Tauri) 앱은 Expo 런타임이 아니라 Expo push 토큰을
만들 수 없다(원인은 story #3064 본문). push_devices(platform='macos', apns_device_token)를
대상으로 Apple의 APNs provider API(HTTP/2, JWT provider token 인증)에 직접 발송한다.

계약(expo_push.py와 동형):
- via_outbox=True(기본)면 delivery_jobs(kind="apns_push")에 job row만 insert, 실 발송은
  delivery_dispatcher.py 워커가 담당(요청 트랜잭션 밖 외부 I/O).
- fetch(세션)→send(세션 없음, 순수 외부 I/O)→finalize(세션) 3분할 — story #2460 PO 리뷰의
  "배달 中 트랜잭션 안 잡는다" 규율을 그대로 따른다.
- best-effort — 어떤 실패도 알림 파이프라인으로 전파하지 않는다.
- 인증키(.p8)·Key ID·Team ID 미설정(settings.apns_configured=False)이면 fail-closed(로그만,
  크래시 없음) — gotenberg_service_url과 동일 시맨틱(준비물 도착 전 안전한 무동작).

JWT provider token: ES256, header={"alg":"ES256","kid":<Key ID>}, payload={"iss":<Team ID>,
"iat":<발급 시각>}. Apple 권고대로 토큰을 최대 1시간 재사용 가능하므로(매 요청 재서명은
불필요한 CPU) 55분 캐시 후 재발급.
"""
from __future__ import annotations

import logging
import time
import uuid

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.push_device import PushDevice
from app.services.dispatch_router import _WEBHOOK_BACKOFF_BASE, _WEBHOOK_MAX_RETRIES

logger = logging.getLogger(__name__)

_APNS_PROD_HOST = "https://api.push.apple.com"
_APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com"
_TOKEN_TTL_SECONDS = 55 * 60  # Apple 권고 상한(1h)보다 여유를 둔 재발급 주기.

# {kid: (token, issued_at_monotonic)} — 프로세스 전역 캐시(워커가 여러 job을 순차 처리).
_token_cache: dict[str, tuple[str, float]] = {}


def _apns_host() -> str:
    return _APNS_SANDBOX_HOST if settings.apns_use_sandbox else _APNS_PROD_HOST


def _build_provider_jwt() -> str:
    """ES256 provider token 서명(캐시 재사용). settings.apns_configured가 False면 호출 금지
    (호출부가 먼저 확認)."""
    cached = _token_cache.get(settings.apns_key_id)
    now = time.monotonic()
    if cached is not None and (now - cached[1]) < _TOKEN_TTL_SECONDS:
        return cached[0]

    from jose import jwt as jose_jwt

    token = jose_jwt.encode(
        {"iss": settings.apns_team_id, "iat": int(time.time())},
        settings.apns_auth_key_p8,
        algorithm="ES256",
        headers={"kid": settings.apns_key_id},
    )
    _token_cache[settings.apns_key_id] = (token, now)
    return token


async def _apns_send_one(client: httpx.AsyncClient, device_token: str, body: dict) -> httpx.Response:
    """단일 디바이스 발송. APNs는 배치 API가 없다(device별 개별 POST, expo_push.py의 청크
    배치와 다른 지점 — HTTP/2 멀티플렉싱이 배치 역할을 대신한다는 것이 Apple 설계)."""
    headers = {
        "authorization": f"bearer {_build_provider_jwt()}",
        "apns-topic": settings.apns_bundle_id,
        "apns-push-type": "alert",
        "apns-priority": "10",
    }
    last_exc: Exception | None = None
    for attempt in range(_WEBHOOK_MAX_RETRIES):
        try:
            return await client.post(f"/3/device/{device_token}", json=body, headers=headers)
        except Exception as exc:  # noqa: BLE001 — 네트워크 오류 재시도, 마지막엔 재던짐 대신 로깅+continue
            last_exc = exc
            logger.warning(
                "apns push attempt %d/%d failed", attempt + 1, _WEBHOOK_MAX_RETRIES, exc_info=True,
            )
        if attempt < _WEBHOOK_MAX_RETRIES - 1:
            import asyncio

            await asyncio.sleep(_WEBHOOK_BACKOFF_BASE * (2 ** attempt))
    raise last_exc if last_exc is not None else RuntimeError("apns push: all retries exhausted")


async def deliver_apns_push(
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
    via_outbox: bool = True,
) -> None:
    """expo_push.deliver_expo_push와 동형 진입점 — dispatch_notification의 EE 채널 확장점에서
    나란히 호출됨(대상은 push_devices(platform='macos')로 자연 분리, 이 함수 안 필터 불요 —
    fetch가 platform 필터를 건다)."""
    if not member_ids:
        return
    if via_outbox:
        from app.models.delivery_job import DeliveryJob

        db.add(
            DeliveryJob(
                org_id=org_id,
                kind="apns_push",
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
    await _deliver_apns_push_now(
        db, org_id, member_ids, title=title, body=body, event_type=event_type,
        reference_type=reference_type, reference_id=reference_id, context=context,
        muted_member_ids=muted_member_ids, project_id=project_id, story_id=story_id,
        sprint_id=sprint_id,
    )


async def _deliver_apns_push_now(
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
    """delivery_dispatcher.py 워커 전용(자기 세션으로 호출) — expo_push._deliver_expo_push_now와
    동형 얇은 래퍼(fetch→send→finalize 순차, best-effort try/except)."""
    if not settings.apns_configured:
        logger.debug("apns push skipped — settings.apns_configured is False (준비물 미도착)")
        return
    try:
        targets = await _fetch_apns_targets(db, org_id, member_ids, muted_member_ids=muted_member_ids)
        dead_tokens = await _send_apns_targets(
            targets, title=title, body=body, event_type=event_type, org_id=org_id,
            reference_type=reference_type, reference_id=reference_id,
            project_id=project_id, story_id=story_id, sprint_id=sprint_id,
        )
        await _finalize_apns_dead_tokens(db, org_id, dead_tokens)
    except Exception:
        logger.warning(
            "deliver_apns_push failed (swallowed·best-effort) org=%s event=%s",
            org_id, event_type, exc_info=True,
        )


async def _fetch_apns_targets(
    db: AsyncSession,
    org_id: uuid.UUID,
    member_ids: list[uuid.UUID],
    *,
    muted_member_ids: set[uuid.UUID] | None = None,
) -> list[dict]:
    """활성 macOS push_devices 조회(mute 필터 포함). expo_push._fetch_expo_push_targets와
    동형 — platform='macos' 필터만 추가(같은 테이블, 컬럼 분리라 apns_device_token IS NOT NULL
    행만 이 채널의 대상)."""
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
            PushDevice.platform == "macos",
            PushDevice.is_active.is_(True),
        )
    )
    return [{"apns_device_token": d.apns_device_token} for d in rows.scalars().all()]


async def _send_apns_targets(
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
    """세션 없이 순수 APNs 발송(story #2460 PO 리뷰 F1 패턴 재사용). 반환값 = dead_tokens.

    Apple 응답 코드: 200=성공. 410(Unregistered)·400(BadDeviceToken)은 그 토큰이 더 이상
    유효하지 않다는 뜻이라 dead 처리(Expo의 DeviceNotRegistered와 동형 의미) — 그 외 4xx/5xx는
    per-target 실패로만 로깅(재시도는 _apns_send_one이 이미 수행)."""
    if not devices:
        return []
    if not settings.apns_configured:
        logger.debug("apns push send skipped — settings.apns_configured is False")
        return []

    from ee.services.expo_push import _build_push_data_payload  # 딥링크 payload 빌더 재사용(순수 함수)

    data_payload = _build_push_data_payload(
        event_type=event_type, org_id=org_id, project_id=project_id,
        reference_type=reference_type, reference_id=reference_id,
        story_id=story_id, sprint_id=sprint_id,
    )
    aps_body = {
        "aps": {"alert": {"title": title, "body": body or ""}, "sound": "default"},
        **data_payload,
    }

    dead_tokens: list[str] = []
    ok_count = 0
    error_count = 0
    error_reasons: dict[str, int] = {}
    async with httpx.AsyncClient(base_url=_apns_host(), http2=True, timeout=10.0) as client:
        for dev in devices:
            token = dev["apns_device_token"]
            try:
                resp = await _apns_send_one(client, token, aps_body)
            except Exception:
                error_count += 1
                error_reasons["network_error"] = error_reasons.get("network_error", 0) + 1
                continue
            if resp.status_code == 200:
                ok_count += 1
                continue
            error_count += 1
            reason = "unknown"
            try:
                reason = resp.json().get("reason", reason)
            except Exception:  # noqa: BLE001 — 응답 파싱 실패는 reason=unknown으로만 남김
                pass
            error_reasons[reason] = error_reasons.get(reason, 0) + 1
            if resp.status_code == 410 or reason in ("Unregistered", "BadDeviceToken"):
                dead_tokens.append(token)

    # expo_push.py와 동일 원칙(2026-07-28 #2289) — 성공/실패를 매 발송마다 요약 로깅. 토큰 값은
    # 시크릿에 준해 절대 안 남긴다.
    logger.info(
        "apns push: sent org=%s event=%s devices=%d ok=%d error=%d reasons=%s",
        org_id, event_type, len(devices), ok_count, error_count, error_reasons or None,
    )
    return dead_tokens


async def _finalize_apns_dead_tokens(
    db: AsyncSession, org_id: uuid.UUID, dead_tokens: list[str],
) -> None:
    """발송 後 확인된 dead 토큰을 비활성화(expo_push._finalize_expo_push_dead_tokens와 동형,
    별도 짧은 세션에서 호출하는 것을 전제)."""
    if not dead_tokens:
        return
    await db.execute(
        update(PushDevice)
        .where(
            PushDevice.org_id == org_id,
            PushDevice.apns_device_token.in_(dead_tokens),
        )
        .values(is_active=False)
    )
    await db.flush()
    logger.info("apns push: deactivated %d dead token(s)", len(dead_tokens))
