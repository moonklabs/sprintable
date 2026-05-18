"""공통 응답 헬퍼 — TS ok()/err() 패턴 호환 TextContent 래퍼."""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime

from mcp.types import CallToolResult, TextContent


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


def err(msg: str) -> CallToolResult:
    """오류 응답 — isError=True CallToolResult 반환. 에이전트가 에러로 구분 가능."""
    return CallToolResult(
        content=[TextContent(type="text", text=f"Error: {msg}")],
        isError=True,
    )
