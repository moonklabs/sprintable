"""story #3287([도메인탈고정·축1 Phase1]) — org별 엔티티/상태 "표시 라벨" 오버라이드 API.

GET    /api/v2/organizations/{org_id}/domain-labels  — 오버라이드 조회(org 멤버 read).
PUT    /api/v2/organizations/{org_id}/domain-labels   — 오버라이드 설정(org owner/admin write).
DELETE /api/v2/organizations/{org_id}/domain-labels   — 오버라이드 해제(org owner/admin write).

권한 모델은 gate_config.py(S-GATE-4 org 레이어)와 동형 근거: 라벨은 그 org의 전 멤버가
보는 표시 텍스트라 read는 멤버 전원, 변경(write)만 owner/admin(정책 §2와 동일 축)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.domain_label import (
    delete_org_domain_label,
    list_org_domain_labels,
    set_org_domain_label,
)
from app.services.project_auth import is_org_owner_or_admin

router = APIRouter(prefix="/api/v2/organizations", tags=["domain-labels"])


class DomainLabelEntry(BaseModel):
    domain: str
    canonical_slug: str
    label_ko: str | None
    label_en: str | None


class SetDomainLabelRequest(BaseModel):
    domain: str
    canonical_slug: str
    label_ko: str | None = None
    label_en: str | None = None


@router.get("/{org_id}/domain-labels", response_model=list[DomainLabelEntry])
async def get_domain_labels(
    org_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[DomainLabelEntry]:
    """org가 설정한 오버라이드만 반환한다(미설정 canonical_slug는 목록에 안 나옴 — 호출부가
    자기 하드코딩 기본 라벨을 그대로 쓰면 됨, "미설정=시스템 기본값" 원칙 그대로)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    rows = await list_org_domain_labels(session, org_id=org_id)
    return [
        DomainLabelEntry(
            domain=r.domain, canonical_slug=r.canonical_slug, label_ko=r.label_ko, label_en=r.label_en
        )
        for r in rows
    ]


@router.put("/{org_id}/domain-labels", response_model=DomainLabelEntry)
async def put_domain_label(
    org_id: uuid.UUID,
    body: SetDomainLabelRequest,
    session: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> DomainLabelEntry:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org owner/admin required to set domain label")

    try:
        row = await set_org_domain_label(
            session,
            org_id=org_id,
            domain=body.domain,
            canonical_slug=body.canonical_slug,
            label_ko=body.label_ko,
            label_en=body.label_en,
            created_by=uuid.UUID(auth.user_id),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await session.commit()
    return DomainLabelEntry(
        domain=row.domain, canonical_slug=row.canonical_slug, label_ko=row.label_ko, label_en=row.label_en
    )


@router.delete("/{org_id}/domain-labels", status_code=204)
async def delete_domain_label(
    org_id: uuid.UUID,
    domain: str = Query(...),
    canonical_slug: str = Query(...),
    session: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> None:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org owner/admin required to remove domain label")

    await delete_org_domain_label(session, org_id=org_id, domain=domain, canonical_slug=canonical_slug)
    await session.commit()
