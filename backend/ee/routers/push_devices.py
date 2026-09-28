"""EE Push Devices API — 모바일 푸시 디바이스 등록/조회/폐기 (E-MOBILE M0·S2).

이 라우터는 is_ee_enabled 환경에서만 main.py 에 등록됨(공식 앱=EE 전용·OSS=generic 웹훅 BYO).
OSS 빌드에서는 import 되지 않으나 _require_ee 로 이중 방어(billing 동형).

디바이스는 **멤버-소유** 리소스 — 조회/폐기는 본인 것만(IDOR). 등록 member_id 는 body 가 아니라
auth context 에서 산출(타 멤버 디바이스 등록 불가). webhook_configs 소유 스코프 패턴 동형.
"""
from __future__ import annotations

import logging
import math
import time
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from limits import RateLimitItemPerHour
from limits.errors import StorageError
from limits.storage import storage_from_string
from limits.strategies import MovingWindowRateLimiter
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.push_device import PushDeviceRepository
from app.schemas.push_device import (
    PushDeviceResponse,
    PushDiagnosticsReport,
    RegisterPushDevice,
    UnregisterPushDevice,
)

router = APIRouter(tags=["push-devices-ee"])
_logger = logging.getLogger(__name__)

# story #4394 — per-member cap on diagnostics reports (the app sends one per launch, plus one from the web view after
# registering). Redis when configured (shared across instances), memory otherwise (single-instance dev).
DIAGNOSTICS_PER_HOUR = 30
_DIAGNOSTICS_WINDOW_SECONDS = 3600
_diagnostics_rate = RateLimitItemPerHour(DIAGNOSTICS_PER_HOUR)
_diagnostics_limiter = MovingWindowRateLimiter(
    storage_from_string(settings.redis_url or "memory://", wrap_exceptions=True),
)

# story #4397 — per-client-IP cap on the session-less unregister endpoint.
UNREGISTER_PER_HOUR = 30
_unregister_rate = RateLimitItemPerHour(UNREGISTER_PER_HOUR)
_unregister_limiter = MovingWindowRateLimiter(
    storage_from_string(settings.redis_url or "memory://", wrap_exceptions=True),
)


def client_ip(request: Request) -> str:
    """The caller's real IP behind Cloudflare → Cloud Run (and the web BFF, which forwards these headers): CF-Connecting-IP
    (set by Cloudflare), else the first X-Forwarded-For entry, else the socket peer. `request.client.host` alone is the front
    end's address there, which would put every caller in one bucket."""
    cf = (request.headers.get("cf-connecting-ip") or "").strip()
    if cf:
        return cf
    xff = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if xff:
        return xff
    return request.client.host if request.client else "unknown"


def _require_ee() -> None:
    """EE 비활성화 환경에서 호출 시 403 (방어적 guard)."""
    if not settings.is_ee_enabled:
        raise HTTPException(status_code=403, detail="Enterprise Edition not enabled")


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> PushDeviceRepository:
    return PushDeviceRepository(session, org_id)


async def _get_caller_member_id(
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    session: AsyncSession = Depends(get_db),
) -> uuid.UUID:
    """caller 의 canonical member_id(resolve_member) — 디바이스 소유 스코프.

    휴먼=org_member.id·에이전트=team_member.id. webhook-config 와 동일 축.
    ⚠️ canonicalize_member_id(auth.user_id) 금지(축 버그): 휴먼은 auth.user_id=users.id 라 no-op →
    잘못된 축으로 스코프됨. resolve_member 가 양쪽 정합 보장.
    """
    from app.services.member_resolver import resolve_member
    resolved = await resolve_member(auth, org_id, session)
    return resolved.id


async def _get_caller_user_id(
    auth: Annotated[AuthContext, Depends(get_current_user)],
    org_id: Annotated[uuid.UUID, Depends(get_verified_org_id)],
    session: Annotated[AsyncSession, Depends(get_db)],
) -> uuid.UUID | None:
    """story #4397 — the person behind the caller (users.id for a human · None for an agent), stored on the device row so
    sending by person reaches it from every org they belong to. Same resolution as _get_caller_member_id."""
    from app.services.member_resolver import resolve_member
    resolved = await resolve_member(auth, org_id, session)
    return resolved.user_id


@router.post("/devices", response_model=PushDeviceResponse, status_code=200)
async def register_push_device(
    body: RegisterPushDevice,
    caller_user_id: Annotated[uuid.UUID | None, Depends(_get_caller_user_id)],
    repo: PushDeviceRepository = Depends(_get_repo),
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
    _ee: None = Depends(_require_ee),
) -> PushDeviceResponse:
    """디바이스 등록/재등록(upsert) — 플랫폼별 토큰 UNIQUE 멱등. member_id 는 caller 로 강제.
    story #4397 — user_id(the person) too, so sending by person reaches this device from every org they belong to."""
    device = await repo.upsert(
        member_id=caller_member_id,
        user_id=caller_user_id,
        expo_push_token=body.expo_push_token,
        apns_device_token=body.apns_device_token,
        platform=body.platform,
        device_id=body.device_id,
        app_version=body.app_version,
    )
    return PushDeviceResponse.model_validate(device)


@router.get("/devices", response_model=list[PushDeviceResponse])
async def list_push_devices(
    repo: PushDeviceRepository = Depends(_get_repo),
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
    _ee: None = Depends(_require_ee),
) -> list[PushDeviceResponse]:
    # IDOR: caller member-scope — org_id 만이면 same-org 타 멤버 디바이스 토큰 leak.
    items = await repo.list(member_id=caller_member_id)
    return [PushDeviceResponse.model_validate(i) for i in items]


@router.delete("/devices/{id}", status_code=200)
async def revoke_push_device(
    id: uuid.UUID,
    repo: PushDeviceRepository = Depends(_get_repo),
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
    _ee: None = Depends(_require_ee),
) -> dict:
    # IDOR: 소유 검증 폐기 — 타 멤버/없는 id 면 0행 → 404. (id = push_devices.id 행 PK)
    ok = await repo.delete(id, caller_member_id)
    if not ok:
        raise HTTPException(status_code=404, detail="PushDevice not found")
    return {"ok": True}


@router.post("/diagnostics", status_code=204)
async def report_push_diagnostics(
    body: PushDiagnosticsReport,
    org_id: Annotated[uuid.UUID, Depends(get_verified_org_id)],
    caller_member_id: Annotated[uuid.UUID, Depends(_get_caller_member_id)],
    _ee: Annotated[None, Depends(_require_ee)],
) -> Response:
    """story #4394 — record where the app's push registration stopped (permission · native token · Expo token · register · ok).

    No table: one structured log line per report (Cloud Logging jsonPayload, event="push_diagnostics", member_id, org_id and
    the reported fields). The member comes from the session, never from the body. Over the per-member hourly cap → 429.
    """
    key = f"push-diagnostics:{caller_member_id}"
    try:
        allowed = _diagnostics_limiter.hit(_diagnostics_rate, key)
    except StorageError:
        # Best-effort channel: a limiter storage blip must not turn a diagnostics report into an error for the app.
        _logger.warning("push diagnostics rate-limit storage unavailable — accepting the report")
        allowed = True
    if not allowed:
        # Retry-After rounds up: rounding down tells the app to retry up to a second early, into another 429. If the window
        # lookup fails (storage dropped right after the over-cap hit), it is still a 429, never a 500, with the whole window.
        try:
            reset_at, _remaining = _diagnostics_limiter.get_window_stats(_diagnostics_rate, key)
            retry_after = max(1, math.ceil(reset_at - time.time()))
        except StorageError:
            _logger.warning("push diagnostics rate-limit storage unavailable after an over-cap hit — Retry-After = one window")
            retry_after = _DIAGNOSTICS_WINDOW_SECONDS
        raise HTTPException(
            status_code=429,
            detail="Too many push diagnostics reports",
            headers={"Retry-After": str(retry_after)},
        )
    _logger.info(
        "push diagnostics",
        extra={"structured": {
            "event": "push_diagnostics",
            "member_id": str(caller_member_id),
            "org_id": str(org_id),
            **body.model_dump(),
        }},
    )
    return Response(status_code=204)


@router.post("/devices/unregister", status_code=204)
async def unregister_push_device(
    body: UnregisterPushDevice,
    request: Request,
    session: Annotated[AsyncSession, Depends(get_db)],
    _ee: Annotated[None, Depends(_require_ee)],
) -> Response:
    """story #4397 — switch a device off by its token, **without a session** (the app calls it on /login · after logout ·
    when it starts with an expired session; an authenticated DELETE is impossible then).

    Only off — never on, never read. Always 204, whether the token exists, is already off, or is unknown, so the endpoint
    does not reveal which tokens exist. Per-client-IP hourly cap → 429. Registering again after the next login turns the
    device back on (upsert).
    """
    key = f"push-unregister:{client_ip(request)}"
    try:
        allowed = _unregister_limiter.hit(_unregister_rate, key)
    except StorageError:
        _logger.warning("push unregister rate-limit storage unavailable — accepting the request")
        allowed = True
    if not allowed:
        raise HTTPException(status_code=429, detail="Too many unregister requests", headers={"Retry-After": "3600"})
    from sqlalchemy import update

    from app.models.push_device import PushDevice

    await session.execute(
        update(PushDevice).where(PushDevice.expo_push_token == body.expo_push_token).values(is_active=False)
    )
    return Response(status_code=204)

