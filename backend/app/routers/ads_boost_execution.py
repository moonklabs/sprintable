"""story #3806(Phase3·3-2 PR3, 페드루 PO 確定 2026-09-11) — 승인된 ads_boost 게이트
실행·중지·재개 API. `_require_human`은 PR 2 router(app/routers/ads_boost.py)와
동형(호출부마다 로컬 복제 관례) — 휴먼 전용(그라운딩 AC4). i18n_catalog 스레딩
패턴도 PR 2 router와 동형(Header() DI는 라우트 진입점에서만)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.agent_onboarding_config import resolve_locale_from_request
from app.services.ads_boost_execution import (
    AdsBoostAlreadyInStateError,
    AdsBoostGateNotApprovedError,
    AdsBoostGateNotFoundError,
    AdsBoostNotPausedError,
    AdsBoostNotStartedError,
    request_ads_boost_pause,
    request_ads_boost_resume,
    request_ads_boost_start,
)
from app.services.i18n_catalog import t
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/organizations", tags=["ads-boost-execution"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID, resolved_locale: str):
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "ADS_BOOST_EXECUTE_HUMAN_ONLY",
                "message": t("ads_boost.execute_human_only", resolved_locale),
            },
        )
    return resolved


class CommandResponse(BaseModel):
    command_id: uuid.UUID
    operation: str
    toggle_seq: int
    status: str


def _to_response(command) -> CommandResponse:
    return CommandResponse(
        command_id=command.id, operation=command.operation, toggle_seq=command.toggle_seq,
        status=command.status,
    )


def _raise_common_error(exc: Exception, resolved_locale: str) -> None:
    if isinstance(exc, AdsBoostGateNotFoundError):
        raise HTTPException(
            status_code=404,
            detail={"code": "ADS_BOOST_GATE_NOT_FOUND", "message": t("ads_boost.gate_not_found", resolved_locale)},
        ) from exc
    if isinstance(exc, AdsBoostGateNotApprovedError):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "ADS_BOOST_GATE_NOT_APPROVED",
                "message": t("ads_boost.gate_not_approved", resolved_locale),
            },
        ) from exc
    raise exc


@router.post("/{org_id}/ads-boosts/{gate_id}/start", response_model=CommandResponse, status_code=201)
async def start_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> CommandResponse:
    """story #3806 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다. 직접-호출
    (realdb·유닛) 테스트는 `_start_ads_boost_endpoint`를 불러야 한다."""
    return await _start_ads_boost_endpoint(
        org_id, gate_id, db=db, verified_org_id=verified_org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _start_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID, *, db: AsyncSession, verified_org_id: uuid.UUID,
    auth: AuthContext, resolved_locale: str,
) -> CommandResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)
    try:
        command = await request_ads_boost_start(
            db, org_id=org_id, gate_id=gate_id, requester_member_id=resolved.id,
        )
    except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError) as exc:
        _raise_common_error(exc, resolved_locale)
    return _to_response(command)


@router.post("/{org_id}/ads-boosts/{gate_id}/pause", response_model=CommandResponse, status_code=201)
async def pause_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> CommandResponse:
    return await _pause_ads_boost_endpoint(
        org_id, gate_id, db=db, verified_org_id=verified_org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _pause_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID, *, db: AsyncSession, verified_org_id: uuid.UUID,
    auth: AuthContext, resolved_locale: str,
) -> CommandResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)
    try:
        command = await request_ads_boost_pause(
            db, org_id=org_id, gate_id=gate_id, requester_member_id=resolved.id,
        )
    except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError) as exc:
        _raise_common_error(exc, resolved_locale)
    except AdsBoostNotStartedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_NOT_STARTED", "message": t("ads_boost.not_started", resolved_locale)},
        ) from exc
    except AdsBoostAlreadyInStateError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_ALREADY_PAUSED", "message": t("ads_boost.already_paused", resolved_locale)},
        ) from exc
    return _to_response(command)


@router.post("/{org_id}/ads-boosts/{gate_id}/resume", response_model=CommandResponse, status_code=201)
async def resume_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID,
    db: AsyncSession = Depends(get_db), verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> CommandResponse:
    return await _resume_ads_boost_endpoint(
        org_id, gate_id, db=db, verified_org_id=verified_org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _resume_ads_boost_endpoint(
    org_id: uuid.UUID, gate_id: uuid.UUID, *, db: AsyncSession, verified_org_id: uuid.UUID,
    auth: AuthContext, resolved_locale: str,
) -> CommandResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)
    try:
        command = await request_ads_boost_resume(
            db, org_id=org_id, gate_id=gate_id, requester_member_id=resolved.id,
        )
    except (AdsBoostGateNotFoundError, AdsBoostGateNotApprovedError) as exc:
        _raise_common_error(exc, resolved_locale)
    except AdsBoostNotPausedError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_NOT_PAUSED", "message": t("ads_boost.not_paused", resolved_locale)},
        ) from exc
    except AdsBoostAlreadyInStateError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ADS_BOOST_ALREADY_RUNNING", "message": t("ads_boost.already_running", resolved_locale)},
        ) from exc
    return _to_response(command)
