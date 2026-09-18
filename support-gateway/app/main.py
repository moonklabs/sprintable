from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import settings
from app.rate_limit import limiter
from app.routers.admin import router as admin_router
from app.routers.escalation_resolution import router as escalation_resolution_router
from app.routers.operator_replies import router as operator_replies_router
from app.routers.sessions import router as sessions_router

app = FastAPI(title="Sprintable Support Gateway", version="0.1.0")

app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request, exc):  # noqa: ANN001 — slowapi 시그니처 그대로
    from starlette.responses import JSONResponse

    return JSONResponse(status_code=429, content={"detail": "rate limit exceeded"})


# story #3260 — backend/app/main.py의 CORSMiddleware 배선과 동형(항상 마운트, 빈
# origins면 실질적으로 전부 거부 — "설정 자체가 없다"와 "빈 배열"을 다르게 다루려던 옛
# 분기(`if settings.cors_allow_origins:`)를 걷어낸다, 이 서비스는 브라우저 직접 호출이라
# CORSMiddleware가 실제로 매 요청 경로에 있다).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(sessions_router)
app.include_router(admin_router)
app.include_router(operator_replies_router)
app.include_router(escalation_resolution_router)


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}
