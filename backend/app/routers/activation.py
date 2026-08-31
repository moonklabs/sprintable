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


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


# ⚠️P1 실사고(2026-08-27, dev 전 authenticated 페이지 크래시·페드루 발견) — 아래 두 성공 경로는
# 반드시 raw dict를 그대로 반환한다(`_ok()`류 자체 {data,error,meta} 래핑 금지). Next.js
# 프록시(apps/web `api/activation/*/route.ts`)가 `apiSuccess(await _r.json())`로 **이미**
# {data,error,meta} 봉투를 씌운다 — 여기서 한 번 더 씌우면 FE가 받는 게 {data:{data:{...
# 실 payload...},error,meta},error,meta}로 이중 래핑되고, FE는 `json.data`를 실 payload로
# 기대하므로 `state.steps`가 undefined가 돼 렌더 전체가 크래시한다(cron.py류 서버-서버
# 전용 엔드포인트의 `_ok()` 관례를 그대로 옮겨오다 생긴 실수 — cron 응답은 FE가 `.data.x`로
# 안 읽어 지금까지 안 드러났을 뿐, 구조는 동일 결함). me.py/assets.py(예: storage-usage)처럼
# FE가 실제로 소비하는 엔드포인트는 raw payload를 그대로 반환하는 게 이 레포의 정공이다.
@router.get("/checklist")
async def get_checklist(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    user = await db.get(User, uuid.UUID(auth.user_id))
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return await get_activation_state(db, user)


# unsubscribe는 이메일 링크 클릭이라 pre-auth(브라우저에 세션 없을 수 있음) — 토큰 자체가 인가.
# 에러 경로만 {data,error,meta} 명시 래핑 유지 — Next.js 프록시가 `!_r.ok`면 apiSuccess를
# 안 타고 이 응답을 그대로 통과시키므로(이중래핑 없음), FE(app/unsubscribe/page.tsx)가 기대하는
# `json.error?.code` 분기가 성공 경로와 달리 여기선 안전하다.
@router.get("/unsubscribe", response_model=None)
async def get_unsubscribe(
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict | JSONResponse:
    try:
        payload = decode_email_unsubscribe_token(token)
    except JWTError:
        return _err("INVALID_TOKEN", "Invalid or expired unsubscribe link", 400)
    user_id = uuid.UUID(payload["sub"])
    found = await unsubscribe_user(db, user_id)
    if not found:
        return _err("NOT_FOUND", "Account not found", 404)
    return {"unsubscribed": True}
