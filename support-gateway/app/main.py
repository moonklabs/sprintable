from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.config import settings
from app.rate_limit import limiter
from app.routers.sessions import router as sessions_router

app = FastAPI(title="Sprintable Support Gateway", version="0.1.0")

app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request, exc):  # noqa: ANN001 — slowapi 시그니처 그대로
    from starlette.responses import JSONResponse

    return JSONResponse(status_code=429, content={"detail": "rate limit exceeded"})


if settings.cors_allow_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allow_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

app.include_router(sessions_router)


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}
