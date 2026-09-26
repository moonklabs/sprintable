"""story #4294(PO 05:01Z 판단 · 422) — 기간 질의의 일시 파라미터는 **시간대(오프셋)가 있어야** 받는다.

오프셋 없는(naive) 일시는 asyncpg가 **앱 프로세스의 로컬 시간대**로 바꿔 보낸다(로컬 맥 = KST에선 `09-18T00:00` → `09-17 15:00Z`,
Cloud Run = UTC에선 우연히 UTC). 모르는 시간대를 지어내지 않고 422 `DATETIME_OFFSET_REQUIRED`로 거절한다 — 에이전트가 읽고 바로
고치도록 본문에 `hint`(예시 값)와 `param`을 싣는다. 기간 파라미터를 받는 라우터는 모두 이 모듈만 쓴다(`test_4294…` 가드).
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any

from fastapi import HTTPException, Query, Request
from pydantic import AfterValidator, Field
from pydantic_core import PydanticCustomError

DATETIME_OFFSET_REQUIRED = "DATETIME_OFFSET_REQUIRED"
OFFSET_HINT = "Include a timezone offset, e.g. 2020-01-01T00:00:00Z or 2020-01-01T09:00:00+09:00."
OFFSET_REQUIRED_DESCRIPTION = (
    "ISO 8601 datetime **with a timezone offset** (e.g. 2020-01-01T00:00:00Z or 2020-01-01T09:00:00+09:00). "
    "Values without an offset are rejected with 422 DATETIME_OFFSET_REQUIRED."
)


def offset_required_detail(param: str, request: Request | None) -> dict[str, Any]:
    """422 본문 한 벌 — 쿼리(`require_aware`)와 본문(story #4330 `OffsetDatetime` → `main.py` 검증 오류 처리) 공용."""
    from app.services.agent_onboarding_config import resolve_locale_from_request
    from app.services.i18n_catalog import t

    locale = resolve_locale_from_request(None, request.headers.get("accept-language") if request is not None else None)
    return {
        "code": DATETIME_OFFSET_REQUIRED,
        "message": t("common.datetime_offset_required", locale, param=param),
        "hint": OFFSET_HINT,
        "param": param,
    }


def require_aware(value: datetime | None, *, param: str, request: Request | None) -> datetime | None:
    """오프셋 없는 일시면 422. None · 오프셋 있는 값은 그대로 돌려준다."""
    if value is None or value.tzinfo is not None:
        return value
    raise HTTPException(status_code=422, detail=offset_required_detail(param, request))


# ── story #4330 — 요청 본문의 일시 값도 같은 규칙 ──────────────────────────────────────────────────────
OFFSET_REQUIRED_ERROR_TYPE = "datetime_offset_required"


def _require_offset(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise PydanticCustomError(OFFSET_REQUIRED_ERROR_TYPE, OFFSET_HINT)
    return value


# 요청 본문의 일시 필드 타입(story #4330). 오프셋 없는 값은 검증 오류 `datetime_offset_required` → `main.py`가 쿼리와 같은
# 422 `DATETIME_OFFSET_REQUIRED`(`param` = 본문 경로)로 바꾼다. 본문 스키마의 일시 필드는 전부 이 타입이어야 한다
# (`tests/test_4330_body_datetimes_require_offset_realdb.py` 가드).
OffsetDatetime = Annotated[datetime, AfterValidator(_require_offset), Field(description=OFFSET_REQUIRED_DESCRIPTION)]


def aware_datetime_query(param: str, *, description: str | None = None) -> Callable[..., datetime | None]:
    """`Depends(aware_datetime_query("from"))` — 쿼리 `param`을 datetime으로 받아 오프셋을 확인한다. OpenAPI 설명에 «오프셋 필수»."""
    text = f"{description} — {OFFSET_REQUIRED_DESCRIPTION}" if description else OFFSET_REQUIRED_DESCRIPTION

    value_query = Query(default=None, alias=param, description=text)

    def _dependency(request: Request, value: datetime | None = value_query) -> datetime | None:
        return require_aware(value, param=param, request=request)

    return _dependency
