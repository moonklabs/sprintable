"""story #3722(Trust·BE, 페드루 PO 確定 2026-09-09) — 에이전트 인증 API 요청 1건을
`agent_run_tool_calls` 1행으로 기록하는 ASGI 미들웨어.

`app/services/au_metering.py`(AUMeteringMiddleware)와 동형 사상 그대로 — `call_next()`
먼저 기다린 뒤 `request.state.au_actor`(이미 `get_current_user()`가 심어 둔 SSOT, 새
에이전트 판별 로직 0)를 읽어 에이전트 트래픽만 고르고, 실제 DB 왕복은 `fire_and_forget()`
으로 응답 반환 밖으로 던진다 — 기록 실패가 원 요청에 영향을 주면 안 된다(fail-open은
"기록"에만, 원 요청 흐름은 이 미들웨어가 죽어도 안 죽는다).

MCP 도구 이름표(`X-Sprintable-Tool`)는 PR2 몫 — 지금은 항상 None으로 기록되고, method+
path만으로도 "서버가 관측했다"는 사실 자체는 선다(그게 이 스토리의 핵심 — 에이전트 자기
보고가 아니라 서버 관측)."""
from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.types import ASGIApp

from app.models.agent_run_tool_call import AgentRunToolCall
from app.services.au_metering import STREAMING_PATHS
from app.services.pg_pubsub import fire_and_forget
from app.services.tool_call_attribution import (
    HEADER_NAME,
    attribute_tool_call,
    extract_story_id,
)
from app.services.tool_call_masking import build_input_summary

logger = logging.getLogger(__name__)

_MAX_BODY_BYTES = 64 * 1024  # 마스킹 前 원시 바디를 파싱 시도할 상한(폭주 방지·64KB)


async def _parse_json_body(request: Request) -> dict | None:
    try:
        raw = await request.body()
    except Exception:
        return None
    if not raw or len(raw) > _MAX_BODY_BYTES:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _route_path_template(request: Request) -> str:
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else request.url.path


async def _record_tool_call_safe(**kwargs) -> None:
    """`fire_and_forget()`로 던져지는 실제 DB 왕복 — 이 코루틴 자신이 예외를 전부
    삼켜야 한다(AUMeteringMiddleware의 `_record_au_usage_safe`와 동형 이유)."""
    try:
        from app.core.database import async_session_factory

        async with async_session_factory() as session, session.begin():
            await attribute_and_insert(session, **kwargs)
    except Exception:
        logger.error("tool-call recording failed agent_id=%s", kwargs.get("agent_id"), exc_info=True)


async def attribute_and_insert(session, *, org_id, agent_id, header_run_id, story_id,
                                tool, method, path, status_code, duration_ms, started_at,
                                input_summary, error) -> None:
    result = await attribute_tool_call(
        session, agent_id=agent_id, header_run_id=header_run_id, story_id=story_id,
    )
    session.add(AgentRunToolCall(
        id=uuid.uuid4(), org_id=org_id, agent_id=agent_id, run_id=result.run_id,
        tool=tool, method=method, path=path, status_code=status_code, duration_ms=duration_ms,
        started_at=started_at, input_summary=input_summary, error=error,
        attribution_reason=result.reason,
    ))


_RETENTION_DAYS = 30


async def sweep_old_tool_calls(session: AsyncSession, *, now: datetime | None = None) -> int:
    """cron.py `/publication-commands` tick 피기백(새 Cloud Scheduler 잡 0 — #3672
    sweep_old_unhandled_error_events와 동형 사상). 30일 지난 행을 지운다. `run_id`가
    NULL인(미귀속) 행도 이 스윕 대상 — cascade는 run이 삭제될 때만 걸리고, run이 안
    지워진 채 오래된 행은 이 스윕이 유일한 정리 경로다. 반환값=삭제 건수(tick 응답
    카운트용)."""
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=_RETENTION_DAYS)
    result = await session.execute(
        delete(AgentRunToolCall).where(AgentRunToolCall.created_at < cutoff)
    )
    await session.commit()
    return result.rowcount or 0


class ToolCallRecordingMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp) -> None:
        super().__init__(app)

    async def dispatch(self, request: Request, call_next):
        started_perf = time.monotonic()
        started_at = datetime.now(UTC)

        # story #3722 — SSE 스트림은 body가 없고(GET) 응답도 무한 스트림이라 이 계측 대상이
        # 아니다(AU 계측과 동일 denylist 재사용 — 두 축이 같은 예외를 따로 관리하면 드리프트
        # 재발 클래스, feedback_shared_primitive_move_test_sweep 동형).
        if request.url.path in STREAMING_PATHS:
            return await call_next(request)

        body = await _parse_json_body(request) if request.method in {"POST", "PUT", "PATCH"} else None

        response = await call_next(request)

        try:
            if getattr(request.state, "au_actor", None) != "agent":
                return response
            org_id_raw = getattr(request.state, "au_org_id", None)
            agent_id_raw = getattr(request.state, "au_user_id", None)
            if not org_id_raw or not agent_id_raw:
                return response

            duration_ms = int((time.monotonic() - started_perf) * 1000)
            route_path = _route_path_template(request)
            path_params = dict(request.path_params) if request.path_params else None
            query_params = dict(request.query_params) if request.query_params else None
            story_id = extract_story_id(
                route_path=route_path, path_params=path_params, query_params=query_params, body=body,
            )
            input_summary = build_input_summary(query_params=query_params or {}, body=body)
            error = None if response.status_code < 400 else f"HTTP {response.status_code}"

            fire_and_forget(_record_tool_call_safe(
                org_id=uuid.UUID(str(org_id_raw)), agent_id=uuid.UUID(str(agent_id_raw)),
                header_run_id=request.headers.get(HEADER_NAME), story_id=story_id,
                tool=request.headers.get("x-sprintable-tool"), method=request.method,
                path=route_path, status_code=response.status_code, duration_ms=duration_ms,
                started_at=started_at, input_summary=input_summary, error=error,
            ))
        except Exception:
            # story #3722 — 계측 "계획" 단계(요청 파싱·판별)의 예외도 원 응답을 절대
            # 막으면 안 된다(AUMeteringMiddleware.dispatch()와 동형 try/except 배치).
            logger.error("tool-call recording planning failed path=%s method=%s",
                         request.url.path, request.method, exc_info=True)
        return response
