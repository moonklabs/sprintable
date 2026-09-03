"""story #3354(마케팅자동화·측정, 페드루 PO 확定 2026-09-03) — 공개 글 페이지 beacon.

**비인증** 라우트(public_docs.py와 동형 — 인증 Depends 의도적 생략). 개인정보 0(PO AC): UA는
해시해 레이트리밋 키로만 쓰고 어디에도 영속 저장 안 함, IP·쿠키 저장 0. org 식별은 body의
`public_key`(비밀 아닌 공개 식별자, org_metering_keys 참고) — 모르는 키는 침묵 204(존재
유출 안 함, public_docs.py의 unknown→에러 노출과 달리 이쪽은 beacon이라 클라이언트가 응답을
안 읽으므로 오히려 구분 없는 204가 더 안전한 선택).
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware

from app.dependencies.database import get_db
from app.services.pageview_counter import record_pageview, resolve_org_by_public_key
from app.services.rate_limiter import get_rate_limiter

router = APIRouter(prefix="/api/v2/public", tags=["public-pageview"])

# 최소 봇 필터(처방 3항) — UA 문자열 규칙만, 정교한 탐지는 스코프 밖(PO 확定 "최소").
_BOT_UA_RE = re.compile(r"bot|spider|crawl|slurp|headless", re.IGNORECASE)

_DEDUP_WINDOW_LIMIT = 1  # 레이트리밋 윈도우(rate_limiter.WINDOW_SECS=60s)당 같은 (org,path,ua) 1회만 — AC "1분 내 재요청 억제"


class PageviewBeaconRequest(BaseModel):
    public_key: str = Field(..., min_length=1, max_length=128)
    path: str = Field(..., min_length=1, max_length=512)
    referrer: str | None = Field(default=None, max_length=1024)


@router.post("/pageview", status_code=204)
async def post_pageview(
    body: PageviewBeaconRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Response:
    # referrer는 받되 저장하지 않는다 — 페이지 querystring에 개인식별 정보가 실릴 수 있어
    # (개인정보 0 원칙) 집계 축(org, path, day)에 없는 차원은 지금 스코프에서 버린다(PO
    # 처방 1항이 body 필드로만 나열했지, 영속 컬럼으로 못박지 않았다 — 향후 "유입경로별"
    # 분석이 필요해지면 별도 스토리로 컬럼을 연다).
    _ = body.referrer

    org_id = await resolve_org_by_public_key(db, body.public_key)
    if org_id is None:
        return Response(status_code=204)

    ua = request.headers.get("user-agent", "")
    if not ua or _BOT_UA_RE.search(ua):
        return Response(status_code=204)
    ua_hash = hashlib.sha256(ua.encode()).hexdigest()

    limiter = get_rate_limiter()
    allowed, _remaining, _retry_after = await limiter.check(
        f"pv:{org_id}:{body.path}:{ua_hash}", _DEDUP_WINDOW_LIMIT,
    )
    if not allowed:
        return Response(status_code=204)  # 1분 내 같은 UA 재요청 — 중복으로 간주, 집계 안 늘림

    today = datetime.now(timezone.utc).date()
    await record_pageview(db, org_id=org_id, path=body.path, day=today)
    return Response(status_code=204)


_PUBLIC_PAGEVIEW_PATH = "/api/v2/public/pageview"


class PublicPageviewCorsMiddleware(BaseHTTPMiddleware):
    """beacon은 blog 정적 사이트(app 도메인과 다른 origin)에서 호출된다. 전역 CORSMiddleware
    (main.py)의 allow_origins는 인증 API 표면 보호용 고정 allowlist라 이 경로만 완전 개방
    (PO "CORS는 이 라우트만" 확定) — 쿠키 0·무인증이라 allow_credentials 없이 origin "*"과
    궁합 문제 없음. main.py에서 전역 CORSMiddleware보다 나중에 add_middleware해 바깥쪽(요청
    먼저 통과)에 두면, preflight OPTIONS를 전역 CORSMiddleware의 allowlist 판정 전에 여기서
    가로챈다."""

    async def dispatch(self, request: Request, call_next):
        if request.url.path != _PUBLIC_PAGEVIEW_PATH:
            return await call_next(request)
        if request.method == "OPTIONS":
            return Response(status_code=204, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Max-Age": "86400",
            })
        response = await call_next(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response
