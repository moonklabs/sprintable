"""공개 문서 read (Part B b1574f5a) — **비인증** 라우트.

⚠️ 인증 Depends 를 의도적으로 생략한다(글로벌 auth 미들웨어 부재·per-route Depends 구조라
   생략=공개). opaque share token 만으로 단일 문서 read. 메타 누출 0·내부링크 비resolve 는
   FE 공개 뷰어가 담당. FE 프록시(`/api/public/docs/[token]`) + proxy.ts `PUBLIC_PREFIX` 등록은
   미르코군 FE 레인.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.schemas.doc import PublicDocResponse
from app.services import doc_share

router = APIRouter(prefix="/api/v2/public/docs", tags=["public-docs"])


@router.get("/{token}", response_model=PublicDocResponse)
async def get_public_doc(
    token: str,
    db: AsyncSession = Depends(get_db),
) -> PublicDocResponse:
    """active share token → 단일 문서 공개 read. unknown→404 / revoked·삭제→410."""
    # 토큰 길이 sanity (과도 입력 차단) — 형식 불일치는 unknown 취급(404)
    if not token or len(token) > 128:
        raise HTTPException(status_code=404, detail="유효하지 않은 링크")
    try:
        doc = await doc_share.resolve_public(db, token)
    except doc_share.ShareTokenError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    return PublicDocResponse(
        title=doc.title,
        content=doc.content,
        content_format=doc.content_format,
    )
