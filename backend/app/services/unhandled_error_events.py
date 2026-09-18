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
import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.unhandled_error_event import UnhandledErrorEvent

logger = logging.getLogger(__name__)

_RETENTION_DAYS = 30

# 페드루 PO REQUIRED(#4025 리뷰, 2026-09-07) — `message=str(exc)[:2000]`는 debug 여부와
# 무관하게 이 테이블에 30일 남는다. 이 문자열은 요청 URL/헤더/바디를 그대로 인용하는
# 예외(예: httpx가 실패한 요청의 URL을 메시지에 그대로 넣는 경우)에서 access_token=…·
# client_secret=…·Authorization: Bearer … 가 새어 들어올 수 있어, 여기서 한 겹 마스킹한다
# — «비밀값 미저장»(AC2)이 path/헤더/바디를 안 담는 것만으로는 안 끝난다(예외 메시지라는
# 별도 경로가 있다). key=value류(쿼리스트링·form 인코딩 공통 표기)와 Bearer 토큰 두
# 형태만 잡는다(과설계 금지 — 이 표에 실제로 나타나는 값의 모양 두 가지).
_SECRET_KV_RE = re.compile(
    r"(?i)\b(access_token|refresh_token|client_secret|api_key|password|secret|token)"
    r"([=:])\s*[^\s&\"'<>]+"
)
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9\-_.~+/]+=*")


def _redact(message: str | None) -> str | None:
    if not message:
        return message
    redacted = _BEARER_RE.sub("Bearer [REDACTED]", message)
    redacted = _SECRET_KV_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", redacted)
    return redacted


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
    호출부 몫, 이중 절단 방지). 저장 直前 `_redact()`로 예외 문자열 안에 낀
    토큰류를 한 번 더 가린다(경로/헤더 자체를 안 담는 것과는 별개 방어선)."""
    from app.core.database import async_session_factory

    try:
        async with async_session_factory() as s:
            s.add(UnhandledErrorEvent(
                id=error_id, method=method, path=path, exception_class=exception_class,
                message=_redact(message), org_id=org_id, user_id=user_id, request_id=request_id,
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
