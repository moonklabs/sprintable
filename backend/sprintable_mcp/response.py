"""공통 응답 헬퍼 — TS ok()/err() 패턴 호환 TextContent 래퍼."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime

from mcp.types import TextContent

from .api_client import SprintableApiError, _split_code_message


def _default_serializer(obj: object) -> str:
    """datetime/UUID → JSON 직렬화 가능 타입으로 변환."""
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, uuid.UUID):
        return str(obj)
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def ok(data: object) -> list[TextContent]:
    """성공 응답 — data를 JSON 직렬화해 TextContent 리스트로 반환."""
    return [TextContent(type="text", text=json.dumps(data, indent=2, ensure_ascii=False, default=_default_serializer))]



# story #3933 — code→다음 행동 힌트. 낱말 발명 0(기존 문구·BE code 그대로) 원칙이라
# 대부분은 의도적으로 비워 둔다 — 없는 code는 hint 필드 자체를 생략(AC1 명시 허용). 다음에
# 실제로 자주 보이는 code가 생기면 그 code 자신의 기존 메시지/문서에서 문구를 그대로
# 가져와 여기 추가한다(새 낱말 짓지 않는다).
#
# circuit_breaker_open(AC3 우선 처리, conversations.py:2551) — 원래 문장이 저자 자신이
# em-dash로 나눠 뒀던 "무슨 일"(message)과 "다음 행동"(hint)을 그대로 옮김, 새 낱말 0.
_ERROR_HINTS: dict[str, str] = {
    "CIRCUIT_BREAKER_OPEN": "org owner/admin의 해제 또는 자동 해소를 기다려주세요",
}


def err(exc: str | BaseException) -> list[TextContent]:
    """오류 응답 — ok()와 동일한 list[TextContent] 반환.

    story #3933(2026-09-16, 페드루 PO 판정) — 이전엔 `err(str(exc))`로 123곳 호출부가
    이미 `str(exc)`로 code/detail을 문자열 하나에 뭉개 넘겼다. `SprintableApiError`가
    가진 `.code`/`.message`/`.detail`을 그대로 받게 시그니처를 넓혀서(str도 여전히
    받는다 — 기존 소수 직접-문자열 호출부 하위호환) 구조를 복원한다.

    출력은 두 겹: 1행은 기존 그대로 `Error: {code}: {message}`(fleet의 `startswith
    ("Error:")`류 파싱 무변 — 블라스트 반경 흡수) + 그 뒤 JSON 블록
    `{"code","message","hint"?,"detail"?}`(기계가 읽는 구조, hint/detail은 있을 때만).
    """
    if isinstance(exc, SprintableApiError):
        code = exc.code or "UNKNOWN"
        message = exc.message
        detail = exc.detail
    elif isinstance(exc, BaseException):
        code = "UNKNOWN"
        message = str(exc)
        detail = None
    else:
        code, message = _split_code_message(exc)
        code = code or "UNKNOWN"
        detail = None

    first_line = f"Error: {code}: {message}" if code != "UNKNOWN" else f"Error: {message}"

    payload: dict[str, object] = {"code": code, "message": message}
    hint = _ERROR_HINTS.get(code)
    if hint:
        payload["hint"] = hint
    if detail is not None:
        payload["detail"] = detail

    json_block = json.dumps(payload, indent=2, ensure_ascii=False, default=_default_serializer)
    return [TextContent(type="text", text=f"{first_line}\n{json_block}")]


def ok_paginated(
    items: list,
    *,
    has_more: bool,
    next_cursor: str | None,
    tool_name: str,
    cursor_param: str = "cursor",
) -> list[TextContent]:
    """story #2428 — docs.py list_docs/notifications.py check_notifications가 이미 쓰는
    「더 있으면 2차 텍스트 블록으로 안내」 관례의 공용화(그 두 곳은 각자 복제해 두고 있었다 —
    새로 만드는 이 계열 도구는 여기서부터 공유). 조용히 자르지 않는다는 것이 이 스토리의
    본체 — has_more=True인데 next_cursor가 없으면(호출부 실수) 안내 문구 없이 items만
    돌려주는 대신 명시로 알 수 있게 그 사실 자체를 문구에 남긴다."""
    blocks = ok(items)
    if has_more:
        cursor_hint = (
            f'{cursor_param}="{next_cursor}"' if next_cursor else f"{cursor_param}(서버가 next_cursor를 안 줌 — 호출부 확인 필요)"
        )
        blocks.append(TextContent(
            type="text",
            text=(
                f"※ 더 있음 — 이 응답은 {len(items)}건까지만 포함(전량 아님). "
                f"다음 페이지: {tool_name}를 {cursor_hint}로 다시 호출."
            ),
        ))
    return blocks
