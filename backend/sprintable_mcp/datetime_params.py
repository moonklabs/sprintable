"""story #4294 AC3 — 기간 파라미터의 «시간대(오프셋) 필수» 규칙을 MCP 도구 설명(에이전트가 실제로 보는 도구 목록)에 싣는 한 문장.

서버 쪽 규칙은 `app/core/datetime_query.py`(오프셋 없는 일시 → 422 `DATETIME_OFFSET_REQUIRED`)가 정본이다. MCP 서버는 백엔드
`app.*`를 import 하지 않는 별도 프로세스라(api_client.py 참조) 코드 문자열만 여기 손으로 맞춘다 — 둘의 동일성은
`tests/test_4294_mcp_tool_list_datetime_params.py`가 고정한다. 파이썬 docstring · 필드 주석은 도구 목록에 안 닿으므로
(`_flat()`이 입력 모델 필드를 설명 없이 시그니처로 옮긴다) 규칙은 반드시 `_TOOL_DEFS`의 설명 문자열에 있어야 한다.
"""
from __future__ import annotations

DATETIME_OFFSET_REQUIRED = "DATETIME_OFFSET_REQUIRED"


def offset_required_note(*params: str) -> str:
    """도구 설명 끝에 붙이는 한 줄 — 어떤 파라미터가 오프셋을 요구하는지 이름으로 적는다."""
    names = " · ".join(f"`{p}`" for p in params)
    return (
        f" ⭐{names}는 시간대(오프셋)가 있는 ISO 8601 일시만 받는다 — 예 `2026-07-29T14:00:00Z` · `2026-07-29T23:00:00+09:00`."
        f" 오프셋 없이(`2026-07-29T14:00:00`) 보내면 422 `{DATETIME_OFFSET_REQUIRED}`(본문 hint에 예시 값)."
    )
