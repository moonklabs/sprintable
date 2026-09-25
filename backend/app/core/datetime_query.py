"""story #4294(PO 05:01Z 판단 · 422) — 기간 질의의 일시 파라미터는 **시간대(오프셋)가 있어야** 받는다.

오프셋 없는(naive) 일시는 asyncpg가 **앱 프로세스의 로컬 시간대**로 바꿔 보낸다(로컬 맥 = KST에선 `09-18T00:00` → `09-17 15:00Z`,
Cloud Run = UTC에선 우연히 UTC). 모르는 시간대를 지어내지 않고 422 `DATETIME_OFFSET_REQUIRED`로 거절한다 — 에이전트가 읽고 바로
고치도록 본문에 `hint`(예시 값)와 `param`을 싣는다. 기간 파라미터를 받는 라우터는 모두 이 모듈만 쓴다(`test_4294…` 가드).
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from fastapi import HTTPException, Query, Request

DATETIME_OFFSET_REQUIRED = "DATETIME_OFFSET_REQUIRED"
OFFSET_HINT = "Include a timezone offset, e.g. 2020-01-01T00:00:00Z or 2020-01-01T09:00:00+09:00."
OFFSET_REQUIRED_DESCRIPTION = (
    "ISO 8601 datetime **with a timezone offset** (e.g. 2020-01-01T00:00:00Z or 2020-01-01T09:00:00+09:00). "
    "Values without an offset are rejected with 422 DATETIME_OFFSET_REQUIRED."
)


def require_aware(value: datetime | None, *, param: str, request: Request | None) -> datetime | None:
    """오프셋 없는 일시면 422. None · 오프셋 있는 값은 그대로 돌려준다."""
    if value is None or value.tzinfo is not None:
        return value
    from app.services.agent_onboarding_config import resolve_locale_from_request
    from app.services.i18n_catalog import t

    locale = resolve_locale_from_request(None, request.headers.get("accept-language") if request is not None else None)
    raise HTTPException(status_code=422, detail={
        "code": DATETIME_OFFSET_REQUIRED,
        "message": t("common.datetime_offset_required", locale, param=param),
        "hint": OFFSET_HINT,
        "param": param,
    })


def aware_datetime_query(param: str, *, description: str | None = None) -> Callable[..., datetime | None]:
    """`Depends(aware_datetime_query("from"))` — 쿼리 `param`을 datetime으로 받아 오프셋을 확인한다. OpenAPI 설명에 «오프셋 필수»."""
    text = f"{description} — {OFFSET_REQUIRED_DESCRIPTION}" if description else OFFSET_REQUIRED_DESCRIPTION

    value_query = Query(default=None, alias=param, description=text)

    def _dependency(request: Request, value: datetime | None = value_query) -> datetime | None:
        return require_aware(value, param=param, request=request)

    return _dependency
