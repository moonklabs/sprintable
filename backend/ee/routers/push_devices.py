"""EE Push Devices API — 모바일 푸시 디바이스 등록/조회/폐기 (E-MOBILE M0·S2).

이 라우터는 is_ee_enabled 환경에서만 main.py 에 등록됨(공식 앱=EE 전용·OSS=generic 웹훅 BYO).
OSS 빌드에서는 import 되지 않으나 _require_ee 로 이중 방어(billing 동형).

디바이스는 **멤버-소유** 리소스 — 조회/폐기는 본인 것만(IDOR). 등록 member_id 는 body 가 아니라
auth context 에서 산출(타 멤버 디바이스 등록 불가). webhook_configs 소유 스코프 패턴 동형.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
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
)

router = APIRouter(tags=["push-devices-ee"])
_logger = logging.getLogger(__name__)

# story #4394 — per-member cap on diagnostics reports (the app sends one per launch, plus one from the web view after
# registering). Redis when configured (shared across instances), memory otherwise (single-instance dev).
DIAGNOSTICS_PER_HOUR = 30
_diagnostics_rate = RateLimitItemPerHour(DIAGNOSTICS_PER_HOUR)
_diagnostics_limiter = MovingWindowRateLimiter(
    storage_from_string(settings.redis_url or "memory://", wrap_exceptions=True),
)


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


@router.post("/devices", response_model=PushDeviceResponse, status_code=200)
async def register_push_device(
    body: RegisterPushDevice,
    repo: PushDeviceRepository = Depends(_get_repo),
    caller_member_id: uuid.UUID = Depends(_get_caller_member_id),
    _ee: None = Depends(_require_ee),
) -> PushDeviceResponse:
    """디바이스 등록/재등록(upsert) — 플랫폼별 토큰 UNIQUE 멱등. member_id 는 caller 로 강제."""
    device = await repo.upsert(
        member_id=caller_member_id,
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
        reset_at, _remaining = _diagnostics_limiter.get_window_stats(_diagnostics_rate, key)
        raise HTTPException(
            status_code=429,
            detail="Too many push diagnostics reports",
            headers={"Retry-After": str(max(1, int(reset_at - time.time())))},
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

