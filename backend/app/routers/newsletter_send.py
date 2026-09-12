"""story #3813(Phase3·3-4 PR2, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송
요청 API. `ads_boost.py`(story #3806 PR2)와 동형 — 휴먼 전용(에이전트는 초안
작성까지, 발송 승인은 사람 몫 — 그라운딩 주어 가르기)."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.agent_onboarding_config import resolve_locale_from_request
from app.services.i18n_catalog import t
from app.services.member_resolver import resolve_member
from app.services.newsletter_send import (
    NewsletterApproverRoleMissingError,
    NewsletterPublicationChannelError,
    NewsletterPublicationNotFoundError,
    NewsletterPublicationNotPublishedError,
    request_newsletter_send,
)

router = APIRouter(prefix="/api/v2/organizations", tags=["newsletter-send"])


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID, resolved_locale: str):
    """ads_boost.py::_require_human과 동형(호출부마다 로컬 복제 관례)."""
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "code": "NEWSLETTER_SEND_CREATE_HUMAN_ONLY",
                "message": t("newsletter_send.create_human_only", resolved_locale),
            },
        )
    return resolved


class CreateNewsletterSendRequest(BaseModel):
    segment_name: str
    scheduled_at: datetime


class NewsletterSendResponse(BaseModel):
    gate_id: uuid.UUID
    status: str
    reapproval_required: bool
    sealed_newsletter_segment_name: str
    sealed_newsletter_scheduled_at: str


@router.post(
    "/{org_id}/publications/{publication_id}/newsletter-sends",
    response_model=NewsletterSendResponse, status_code=201,
)
async def create_newsletter_send_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    body: CreateNewsletterSendRequest,
    db: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> NewsletterSendResponse:
    """`Header()` DI 마커는 라우트 경계에서만(까심 QA CI FAILURE 원칙, i18n_catalog.py
    모듈 docstring 참조). 직접-호출(realdb·유닛) 테스트는 `_create_newsletter_send_
    endpoint`를 불러야 한다."""
    return await _create_newsletter_send_endpoint(
        org_id, publication_id, body, db=db, verified_org_id=verified_org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _create_newsletter_send_endpoint(
    org_id: uuid.UUID,
    publication_id: uuid.UUID,
    body: CreateNewsletterSendRequest,
    *,
    db: AsyncSession,
    verified_org_id: uuid.UUID,
    auth: AuthContext,
    resolved_locale: str,
) -> NewsletterSendResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    resolved = await _require_human(db, auth, org_id, resolved_locale)

    try:
        gate = await request_newsletter_send(
            db, org_id=org_id, publication_id=publication_id, segment_name=body.segment_name,
            scheduled_at=body.scheduled_at, requester_member_id=resolved.id,
        )
    except NewsletterPublicationNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "NEWSLETTER_SEND_PUBLICATION_NOT_FOUND",
                "message": t("newsletter_send.publication_not_found", resolved_locale),
            },
        ) from exc
    except NewsletterPublicationChannelError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "NEWSLETTER_SEND_INVALID_CHANNEL",
                "message": t("newsletter_send.invalid_channel", resolved_locale),
            },
        ) from exc
    except NewsletterPublicationNotPublishedError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "NEWSLETTER_SEND_NOT_PUBLISHED",
                "message": t("newsletter_send.not_published", resolved_locale),
            },
        ) from exc
    except NewsletterApproverRoleMissingError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "NEWSLETTER_SEND_APPROVER_ROLE_MISSING",
                "message": t("newsletter_send.approver_role_missing", resolved_locale),
            },
        ) from exc

    # story #3806 관례 그대로 — 명시 commit 0(get_db가 자동 commit/rollback).
    return NewsletterSendResponse(
        gate_id=gate.id, status=gate.status, reapproval_required=gate.reapproval_required,
        sealed_newsletter_segment_name=gate.sealed_newsletter_segment_name,
        sealed_newsletter_scheduled_at=gate.sealed_newsletter_scheduled_at.isoformat(),
    )
