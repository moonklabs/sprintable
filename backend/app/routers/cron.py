"""
Internal cron endpoints — called by Next.js /api/cron/* routes.
All endpoints require CRON_SECRET via Authorization: Bearer header.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.models.agent_run import AgentRun
from app.models.agent_session import AgentSession
from app.models.hitl import HitlRequest

router = APIRouter(prefix="/api/v2/internal/cron", tags=["cron"])

CRON_SECRET = os.environ.get("CRON_SECRET")


def _ok(data: object) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None})


def _err(code: str, message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


def verify_cron(request: Request) -> None:
    if not CRON_SECRET:
        return  # CRON_SECRET 미설정 시 로컬 개발 허용
    auth = request.headers.get("authorization", "")
    if auth != f"Bearer {CRON_SECRET}":
        raise HTTPException(status_code=401, detail="Unauthorized")


# ─── GET /api/v2/internal/cron/agent-session-recovery ─────────────────────────

@router.get("/agent-session-recovery")
async def agent_session_recovery(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        now = datetime.now(timezone.utc)
        stale_cutoff = now - timedelta(minutes=30)

        # 30분 이상 running 상태인 세션을 stale로 전환
        result = await session.execute(
            select(AgentSession).where(
                AgentSession.status == "active",
                AgentSession.last_activity_at < stale_cutoff,
                AgentSession.ended_at.is_(None),
                AgentSession.terminated_at.is_(None),
            )
        )
        stale_sessions = list(result.scalars().all())

        recovered_count = 0
        for s in stale_sessions:
            s.status = "idle"
            s.idle_at = now
            recovered_count += 1

        await session.commit()

        return _ok({
            "recovered_count": recovered_count,
            "retry_scheduled_count": 0,
            "terminated_count": 0,
            "resumed_count": 0,
        })
    except Exception as exc:
        return _err("INTERNAL_ERROR", str(exc), 500)


# ─── POST /api/v2/internal/cron/anonymize ─────────────────────────────────────

@router.post("/anonymize")
async def anonymize(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    # OSS 모드에서는 Supabase auth 삭제가 없음 — no-op 반환
    return _ok({"anonymized": [], "deleted": []})


# ─── GET /api/v2/internal/cron/hitl-timeouts ──────────────────────────────────

@router.get("/hitl-timeouts")
async def hitl_timeouts(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        now = datetime.now(timezone.utc)

        # 만료된 pending HITL 요청을 expired 상태로 전환
        result = await session.execute(
            select(HitlRequest).where(
                HitlRequest.status == "pending",
                HitlRequest.expires_at.is_not(None),
                HitlRequest.expires_at < now,
            )
        )
        expired = list(result.scalars().all())

        expired_count = 0
        for req in expired:
            req.status = "expired"
            expired_count += 1

        await session.commit()

        return _ok({"expired_count": expired_count, "notified_count": 0})
    except Exception as exc:
        return _err("INTERNAL_ERROR", str(exc), 500)


# ─── GET /api/v2/internal/cron/inbox-outbox ────────────────────────────────────

@router.get("/inbox-outbox")
async def inbox_outbox(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    # inbox-outbox 처리 — 현재 SQLAlchemy 기반 구현에서는 no-op (Supabase pg_cron 대체)
    return _ok({"processed": 0, "dispatched": 0})


# ─── GET /api/v2/internal/cron/retry-agent-runs ────────────────────────────────

@router.get("/retry-agent-runs")
async def retry_agent_runs(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    verify_cron(request)
    try:
        now = datetime.now(timezone.utc)

        # next_retry_at이 도래한 failed run 조회
        result = await session.execute(
            select(AgentRun).where(
                AgentRun.status == "failed",
                AgentRun.next_retry_at.is_not(None),
                AgentRun.next_retry_at <= now,
                AgentRun.retry_count < AgentRun.max_retries,
            )
        )
        pending = list(result.scalars().all())

        retried: list[dict] = []
        final_failures: list[dict] = []

        for run in pending:
            if run.retry_count >= run.max_retries:
                run.failure_disposition = "final"
                final_failures.append({"run_id": str(run.id), "status": "final_failure"})
            else:
                run.status = "queued"
                run.next_retry_at = None
                retried.append({"run_id": str(run.id), "status": "retried"})

        await session.commit()

        return _ok({
            "retried": retried,
            "final_failures": final_failures,
            "total": len(retried) + len(final_failures),
        })
    except Exception as exc:
        return _err("INTERNAL_ERROR", str(exc), 500)
