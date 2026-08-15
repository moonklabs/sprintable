"""story #2606: 약관/개인정보처리방침/환불정책 — 공개(무인증) 「현재 유효 버전」 읽기.

쓰기(admin CRUD·버전 관리)는 sprintable-admin/internal-api 몫(pricing_versions와 동일
두-레포 배선 — legal_document_versions.py 모델 docstring 참조). 이 라우터는 v1 범위를
get_current 하나로 고정한다(PO 지시, 2026-08-13) — 이력/미래 예약본은 admin 전용, 가입 전
방문자에게 노출하는 공개 표면은 "지금 유효한 한 벌"뿐이어야 한다.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import limiter
from app.dependencies.database import get_db
from app.models.legal_document import LegalDocumentVersion
from app.schemas.legal_document import LegalDocumentCurrentResponse

router = APIRouter(prefix="/api/v2/legal", tags=["legal"])

_DOC_TYPES = frozenset({"terms", "privacy", "refund_policy"})
_LOCALES = frozenset({"ko", "en"})


@router.get("/{doc_type}", response_model=LegalDocumentCurrentResponse)
@limiter.limit("60/minute")
async def get_current_legal_document(
    request: Request,
    doc_type: str,
    locale: str = Query("ko", description="ko | en"),
    db: AsyncSession = Depends(get_db),
) -> LegalDocumentCurrentResponse:
    if doc_type not in _DOC_TYPES:
        raise HTTPException(status_code=404, detail="unknown doc_type")
    if locale not in _LOCALES:
        raise HTTPException(status_code=404, detail="unknown locale")

    now = datetime.now(timezone.utc)
    row = (await db.execute(
        select(LegalDocumentVersion)
        .where(
            LegalDocumentVersion.doc_type == doc_type,
            LegalDocumentVersion.locale == locale,
            LegalDocumentVersion.effective_from <= now,
        )
        .order_by(LegalDocumentVersion.effective_from.desc())
        .limit(1)
    )).scalar_one_or_none()
    if row is None:
        # story #2606: 선생님 문안 도착 전엔 정직하게 404 — placeholder를 서버가 만들어내지
        # 않는다(placeholder 자체가 이 스토리의 출발점이던 결함). FE가 "coming soon" 렌더.
        raise HTTPException(status_code=404, detail="not published yet")

    return LegalDocumentCurrentResponse(
        doc_type=row.doc_type,
        locale=row.locale,
        content=row.content,
        content_format=row.content_format,
        effective_from=row.effective_from,
    )
