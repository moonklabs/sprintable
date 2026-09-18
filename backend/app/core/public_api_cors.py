"""공개(무인증) API 라우트 전용 CORS — 전역 CORSMiddleware(main.py)의 allow_origins는 인증
API 표면 보호용 고정 allowlist라, 여기 등록된 공개 경로만 따로 완전 개방한다(쿠키 0·무인증
라우트뿐이라 allow_credentials 없이 origin "*"과 궁합 문제 없음). main.py에서 전역
CORSMiddleware보다 나중에 add_middleware해 바깥쪽(요청을 먼저 통과)에 둬야 preflight
OPTIONS가 전역 allowlist 판정에 걸리기 전에 여기서 가로채진다.

story #3354(PR#3728)가 `/pageview` 하나로 처음 만들었고, story #3360(페드루 확定 — "새
미들웨어 신설 금지, #3728 미들웨어 경로에 추가")이 `/site-posts` 계열을 여기로 얹었다. 새
공개 라우트가 CORS 개방이 필요하면 `_ROUTES`에 (path 판별, 허용 methods)만 추가."""
from __future__ import annotations

from collections.abc import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


def _is_pageview(path: str) -> bool:
    return path == "/api/v2/public/pageview"


def _is_site_posts(path: str) -> bool:
    return path == "/api/v2/public/site-posts" or path.startswith("/api/v2/public/site-posts/")


_ROUTES: list[tuple[Callable[[str], bool], str]] = [
    (_is_pageview, "POST, OPTIONS"),
    (_is_site_posts, "GET, OPTIONS"),
]


class PublicApiCorsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        allowed_methods = next((methods for matcher, methods in _ROUTES if matcher(path)), None)
        if allowed_methods is None:
            return await call_next(request)
        if request.method == "OPTIONS":
            return Response(status_code=204, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": allowed_methods,
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Max-Age": "86400",
            })
        response = await call_next(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response
