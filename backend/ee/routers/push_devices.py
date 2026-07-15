"""EE Push Devices API — 모바일 푸시 디바이스 등록/조회/폐기 (E-MOBILE M0·S2).

이 라우터는 is_ee_enabled 환경에서만 main.py 에 등록됨(공식 앱=EE 전용·OSS=generic 웹훅 BYO).
OSS 빌드에서는 import 되지 않으나 _require_ee 로 이중 방어(billing 동형).

디바이스는 **멤버-소유** 리소스 — 조회/폐기는 본인 것만(IDOR). 등록 member_id 는 body 가 아니라
auth context 에서 산출(타 멤버 디바이스 등록 불가). webhook_configs 소유 스코프 패턴 동형.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.push_device import PushDeviceRepository
from app.schemas.push_device import PushDeviceResponse, RegisterPushDevice

router = APIRouter(tags=["push-devices-ee"])


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
    """디바이스 등록/재등록(upsert) — expo_push_token UNIQUE 멱등. member_id 는 caller 로 강제."""
    device = await repo.upsert(
        member_id=caller_member_id,
        expo_push_token=body.expo_push_token,
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
