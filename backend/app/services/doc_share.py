"""문서 공유 공개 토큰 서비스 (Part B b1574f5a).

opaque token(슬러그 무관)·문서당 1 active. enable=발급 / disable=revoke /
regenerate=구 토큰 즉사+신규. 공개 resolve 는 404(unknown/malformed) / 410(revoked·doc 삭제).

⚠️ audit 는 **app 로그**(logger.info)로 남긴다. `permission_audit_logs`(AuditLog)는 action 에
   CHECK 제약(member_added|member_removed|role_changed 만 허용)이 있어 doc.share.* 를 INSERT 하면
   commit 시 전체 트랜잭션이 롤백돼 토큰이 persist 되지 않는다(P0 — verify-first 적발). 구조화 DB
   audit 은 적합 테이블/CHECK 확장으로 후속.
"""
from __future__ import annotations

import logging
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.doc import Doc, DocShareToken

logger = logging.getLogger(__name__)

_TOKEN_BYTES = 32  # secrets.token_urlsafe(32) → ~43 chars opaque


class ShareTokenError(Exception):
    """공개 토큰 해소 실패. status_code: 404(unknown/malformed) / 410(revoked·gone)."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def _new_token() -> str:
    return secrets.token_urlsafe(_TOKEN_BYTES)


async def _active_token(db: AsyncSession, org_id: uuid.UUID, doc_id: uuid.UUID) -> DocShareToken | None:
    return (await db.execute(
        select(DocShareToken).where(
            DocShareToken.org_id == org_id,
            DocShareToken.doc_id == doc_id,
            DocShareToken.status == "active",
        ).limit(1)
    )).scalar_one_or_none()


def _audit(org_id: uuid.UUID, actor_id: uuid.UUID, action: str,
           doc_id: uuid.UUID, token_id: uuid.UUID | None = None) -> None:
    """app 로그 audit 트레일(non-fatal·트랜잭션 무관). DB audit 은 후속(적합 테이블 필요)."""
    logger.info(
        "%s org=%s actor=%s doc=%s token=%s",
        action, org_id, actor_id, doc_id, token_id,
    )


async def get_status(db: AsyncSession, org_id: uuid.UUID, doc_id: uuid.UUID) -> DocShareToken | None:
    return await _active_token(db, org_id, doc_id)


async def enable(db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID,
                 doc_id: uuid.UUID, actor_id: uuid.UUID) -> DocShareToken:
    """opt-in 활성. 이미 active 면 그대로 반환(멱등)."""
    existing = await _active_token(db, org_id, doc_id)
    if existing is not None:
        return existing
    tok = DocShareToken(
        org_id=org_id, doc_id=doc_id, project_id=project_id,
        token=_new_token(), status="active", created_by=actor_id,
    )
    db.add(tok)
    await db.flush()
    _audit(org_id, actor_id, "doc.share.enabled", doc_id, tok.id)
    return tok


async def regenerate(db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID,
                     doc_id: uuid.UUID, actor_id: uuid.UUID) -> DocShareToken:
    """구 active 토큰 즉시 revoke + 신규 발급(유출 방어)."""
    existing = await _active_token(db, org_id, doc_id)
    if existing is not None:
        existing.status = "revoked"
        existing.revoked_at = datetime.now(timezone.utc)
        await db.flush()  # partial-unique(active) 해제 후 신규 active insert
    tok = DocShareToken(
        org_id=org_id, doc_id=doc_id, project_id=project_id,
        token=_new_token(), status="active", created_by=actor_id,
    )
    db.add(tok)
    await db.flush()
    _audit(org_id, actor_id, "doc.share.regenerated", doc_id, tok.id)
    return tok


async def revoke(db: AsyncSession, org_id: uuid.UUID, doc_id: uuid.UUID, actor_id: uuid.UUID) -> bool:
    """공개 중단 — active 토큰을 revoked 로. 토큰 즉시 무효(이후 410)."""
    existing = await _active_token(db, org_id, doc_id)
    if existing is None:
        return False
    existing.status = "revoked"
    existing.revoked_at = datetime.now(timezone.utc)
    await db.flush()
    _audit(org_id, actor_id, "doc.share.disabled", doc_id, existing.id)
    return True


async def resolve_public(db: AsyncSession, token: str) -> Doc:
    """공개 토큰 → Doc. unknown→404 / revoked·doc삭제→410. 문서 존재는 어느 쪽도 비노출."""
    tok = (await db.execute(
        select(DocShareToken).where(DocShareToken.token == token).limit(1)
    )).scalar_one_or_none()
    if tok is None:
        raise ShareTokenError(404, "유효하지 않은 링크")
    if tok.status != "active":
        raise ShareTokenError(410, "더 이상 유효하지 않은 링크")
    doc = (await db.execute(
        select(Doc).where(Doc.id == tok.doc_id, Doc.deleted_at.is_(None)).limit(1)
    )).scalar_one_or_none()
    if doc is None:
        raise ShareTokenError(410, "더 이상 유효하지 않은 링크")
    return doc
