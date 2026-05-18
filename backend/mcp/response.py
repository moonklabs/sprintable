"""공통 응답 헬퍼 — TS ok()/err() 패턴 호환 TextContent 래퍼."""
from __future__ import annotations

import json

from mcp.types import TextContent


def ok(data: object) -> list[TextContent]:
    """성공 응답 — data를 JSON 직렬화해 TextContent 리스트로 반환."""
    return [TextContent(type="text", text=json.dumps(data, indent=2, ensure_ascii=False))]


def err(msg: str) -> list[TextContent]:
    """오류 응답 — 'Error: {msg}' 형식의 TextContent 리스트로 반환."""
    return [TextContent(type="text", text=f"Error: {msg}")]
