"""story #4294 AC3 — 기간 파라미터의 «시간대(오프셋) 필수» 규칙을 MCP 도구 설명(에이전트가 실제로 보는 도구 목록)에 싣는 한 문장.

서버 쪽 규칙은 `app/core/datetime_query.py`(오프셋 없는 일시 → 422 `DATETIME_OFFSET_REQUIRED`)가 정본이다. MCP 서버는 백엔드
`app.*`를 import 하지 않는 별도 프로세스라(api_client.py 참조) 코드 · 설명 문구 · 힌트를 여기 손으로 맞춘다 — 셋 다 BE 상수와
글자 그대로 같은지 `tests/test_4294_mcp_tool_list_datetime_params.py`가 BE 모듈을 직접 import해 고정한다(BE 문구가 바뀌면 RED). 파이썬 docstring · 필드 주석은 도구 목록에 안 닿으므로
(`_flat()`이 입력 모델 필드를 설명 없이 시그니처로 옮긴다) 규칙은 반드시 `_TOOL_DEFS`의 설명 문자열에 있어야 한다.
"""
from __future__ import annotations

DATETIME_OFFSET_REQUIRED = "DATETIME_OFFSET_REQUIRED"
# BE `app.core.datetime_query`의 같은 이름 상수 사본(글자 그대로 · 테스트가 대조).
OFFSET_HINT = "Include a timezone offset, e.g. 2020-01-01T00:00:00Z or 2020-01-01T09:00:00+09:00."
OFFSET_REQUIRED_DESCRIPTION = (
    "ISO 8601 datetime **with a timezone offset** (e.g. 2020-01-01T00:00:00Z or 2020-01-01T09:00:00+09:00). "
    "Values without an offset are rejected with 422 DATETIME_OFFSET_REQUIRED."
)


def offset_required_note(*params: str) -> str:
    """도구 설명 끝에 붙이는 한 줄 — 어떤 파라미터가 오프셋을 요구하는지 이름으로 적는다."""
    names = " · ".join(f"`{p}`" for p in params)
    return f" ⭐{names}: {OFFSET_REQUIRED_DESCRIPTION} (422 body hint: «{OFFSET_HINT}»)"
