"""story #3806(Phase3·3-2 PR2, 페드루 PO 確定 2026-09-11) — Meta Ads boost 요청 API.
`insights_board.py::_require_human`과 동형 — 휴먼 전용(에이전트는 구조·소재·진단
제안만, 실행·예산 API 접근 0이 그라운딩 AC4)."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.agent_onboarding_config import resolve_locale_from_request
from app.services.ads_boost import (
    AdsBoostApproverRoleMissingError,
    AdsBoostPublicationNotFoundError,
    AdsBudgetExceedsSealError,
    request_ads_boost,
)
from app.services.i18n_catalog import t
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/organizations", tags=["ads-boost"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID, resolved_locale: str):
    """insights_board.py::_require_human과 동형(호출부마다 로컬 복제 관례 — 이
    레포 전역에서 이미 그렇게 돼 있다, 공용 유틸화는 이 PR 범위 밖)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "ADS_BOOST_CREATE_HUMAN_ONLY",
                "message": t("ads_boost.create_human_only", resolved_locale),
            },
        )
    return resolved


class CreateBoostRequest(BaseModel):
    budget_minor: int = Field(gt=0)
    currency: str
    starts_at: datetime
    ends_at: datetime
    objective: str


class BoostResponse(BaseModel):
    gate_id: uuid.UUID
    status: str
    reapproval_required: bool
    sealed_ads_budget_minor: int
    sealed_ads_currency: str
    sealed_ads_starts_at: str
    sealed_ads_ends_at: str
    sealed_ads_objective: str


@router.post(
    "/{org_id}/publications/{publication_id}/boosts", response_model=BoostResponse, status_code=201,
)
async def create_ads_boost_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    body: CreateBoostRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> BoostResponse:
    """story #3806 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI
    FAILURE 원칙, i18n_catalog.py 모듈 docstring 참조). 직접-호출(realdb·유닛) 테스트는
    `_create_ads_boost_endpoint`를 불러야 한다."""
    return await _create_ads_boost_endpoint(
        org_id, publication_id, body, db=db, verified_org_id=verified_org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _create_ads_boost_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    body: CreateBoostRequest,
    *,
    db: AsyncSession,
    verified_org_id: uuid.UUID,
    auth: AuthContext,
    resolved_locale: str,
) -> BoostResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)

    if body.starts_at >= body.ends_at:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ADS_BOOST_INVALID_SCHEDULE",
                "message": t("ads_boost.invalid_schedule", resolved_locale),
            },
        )

    try:
        gate = await request_ads_boost(
            db, org_id=org_id, publication_id=publication_id, budget_minor=body.budget_minor,
            currency=body.currency, starts_at=body.starts_at, ends_at=body.ends_at,
            objective=body.objective, requester_member_id=resolved.id,
        )
    except AdsBoostPublicationNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "ADS_BOOST_PUBLICATION_NOT_FOUND",
                "message": t("ads_boost.publication_not_found", resolved_locale),
            },
        ) from exc
    except AdsBoostApproverRoleMissingError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "ADS_BOOST_APPROVER_ROLE_MISSING",
                "message": t("ads_boost.approver_role_missing", resolved_locale),
            },
        ) from exc
    except AdsBudgetExceedsSealError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "ADS_BUDGET_EXCEEDS_SEAL",
                "message": t(
                    "ads_boost.budget_exceeds_seal", resolved_locale,
                    sealed_budget_minor=exc.sealed_budget_minor,
                ),
                "sealed_budget_minor": exc.sealed_budget_minor,
                "requested_budget_minor": exc.requested_budget_minor,
            },
        ) from exc

    # story #3806 — 명시 commit 0(get_db 의존성이 정상 반환 시 자동 commit·예외 시
    # 자동 rollback, app/core/database.py::get_db 관례 — 이 라우터군 다른 엔드포인트
    # 전부와 동형, 이중 커밋 방지).
    return BoostResponse(
        gate_id=gate.id, status=gate.status, reapproval_required=gate.reapproval_required,
        sealed_ads_budget_minor=gate.sealed_ads_budget_minor, sealed_ads_currency=gate.sealed_ads_currency,
        sealed_ads_starts_at=gate.sealed_ads_starts_at.isoformat(), sealed_ads_ends_at=gate.sealed_ads_ends_at.isoformat(),
        sealed_ads_objective=gate.sealed_ads_objective,
    )
