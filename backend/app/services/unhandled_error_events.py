"""story #3672(BE·BFF·FE·관측, 페드루 PO 確定 2026-09-07) — 미처리 500의 서버측
지속 흔적. `main.py::unhandled_exception_handler`가 이 모듈 하나로 «error_id를
로그·응답과 같은 값으로 DB에도 남긴다»를 전담한다.

`record_unhandled_error_event`는 best-effort — `_persist_first_auth_seen`
(app/dependencies/auth.py)과 동형 관례로 전용 세션을 새로 열어 커밋하고, 어떤
예외로도 원래의 500 응답 흐름을 막지 않는다(fail-silent, 로그 경고 한 줄만).
이 함수 자체가 두 번째 미처리 예외의 근원이 되면 안 되므로, 여기서 실패해도
main.py의 원래 500 응답은 그대로 나간다."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.unhandled_error_event import UnhandledErrorEvent

logger = logging.getLogger(__name__)

_RETENTION_DAYS = 30


async def record_unhandled_error_event(
    *,
    error_id: uuid.UUID,
    method: str,
    path: str,
    exception_class: str,
    message: str | None,
    org_id: uuid.UUID | None,
    user_id: uuid.UUID | None,
    request_id: str | None,
) -> None:
    """AC2 — 비밀값(헤더·바디·쿼리스트링) 미저장, message는 호출부가 이미
    [:2000]으로 자른 값을 그대로 받는다(이 함수는 자르지 않는다 — 계약은
    호출부 몫, 이중 절단 방지)."""
    from app.core.database import async_session_factory

    try:
        async with async_session_factory() as s:
            s.add(UnhandledErrorEvent(
                id=error_id, method=method, path=path, exception_class=exception_class,
                message=message, org_id=org_id, user_id=user_id, request_id=request_id,
            ))
            await s.commit()
    except Exception:
        logger.warning("unhandled_error_event persist failed error_id=%s", error_id, exc_info=True)


async def sweep_old_unhandled_error_events(session: AsyncSession, *, now: datetime | None = None) -> int:
    """cron.py `/publication-commands` tick 피기백(새 Cloud Scheduler 잡 0, 3497/3527/3547과
    동형 사상) — 30일 지난 행을 지운다. 반환값=삭제 건수(tick 응답 카운트용)."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=_RETENTION_DAYS)
    result = await session.execute(
        delete(UnhandledErrorEvent).where(UnhandledErrorEvent.occurred_at < cutoff)
    )
    await session.commit()
    return result.rowcount or 0


async def get_unhandled_error_event(session: AsyncSession, *, error_id: uuid.UUID) -> UnhandledErrorEvent | None:
    """AC3 조회 경로 전용 — 존재하지 않는 error_id는 None(라우터가 404로 지어내지
    않고 그대로 응답)."""
    return (await session.execute(
        select(UnhandledErrorEvent).where(UnhandledErrorEvent.id == error_id)
    )).scalar_one_or_none()
