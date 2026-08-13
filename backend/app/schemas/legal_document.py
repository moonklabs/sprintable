from datetime import datetime

from pydantic import BaseModel


class LegalDocumentCurrentResponse(BaseModel):
    """story #2606: 공개 「현재 유효 버전」 응답 — v1은 get_current만 노출한다(PO 지시,
    2026-08-13). 이력/미래 예약본은 admin(internal-api) 전용, 공개 표면 최소."""

    doc_type: str
    locale: str
    content: str
    content_format: str
    effective_from: datetime
