"""story #3159(retention·최소층) — activation 체크리스트 조회 + 리마인드 메일 수신거부.

발송 자체(cron 스윕)는 app/routers/cron.py — 이 파일은 사용자 대면 GET 2종만.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from jose import JWTError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_email_unsubscribe_token
from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.user import User
from app.services.onboarding_activation import get_activation_state, unsubscribe_user

router = APIRouter(prefix="/api/v2/activation", tags=["activation", "Organization"])


def _ok(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None}, status_code=status)


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


@router.get("/checklist")
async def get_checklist(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    user = await db.get(User, uuid.UUID(auth.user_id))
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    state = await get_activation_state(db, user)
    return _ok(state)


# unsubscribe는 이메일 링크 클릭이라 pre-auth(브라우저에 세션 없을 수 있음) — 토큰 자체가 인가.
@router.get("/unsubscribe")
async def get_unsubscribe(
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    try:
        payload = decode_email_unsubscribe_token(token)
    except JWTError:
        return _err("INVALID_TOKEN", "Invalid or expired unsubscribe link", 400)
    user_id = uuid.UUID(payload["sub"])
    found = await unsubscribe_user(db, user_id)
    if not found:
        return _err("NOT_FOUND", "Account not found", 404)
    return _ok({"unsubscribed": True})
