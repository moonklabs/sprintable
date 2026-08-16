"""공통 응답 헬퍼 — TS ok()/err() 패턴 호환 TextContent 래퍼."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime

from mcp.types import TextContent


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


def err(msg: str) -> list[TextContent]:
    """오류 응답 — ok()와 동일한 list[TextContent] 반환. 에러 prefix로 에이전트 구분."""
    return [TextContent(type="text", text=f"Error: {msg}")]


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
