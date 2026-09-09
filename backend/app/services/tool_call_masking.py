"""story #3722(Trust·BE, 페드루 PO 確定 2026-09-09) — `agent_run_tool_calls.input_summary`에
싣기 前에 요청 바디/쿼리를 마스킹·절단한다. #2836(agent_auth_failure.py) 규율 계승 —
「원장·로그·이후 모든 신호 payload엔 raw 값이 절대 안 나간다」.

규칙(스토리 確定 설계 그대로): 키 denylist(대소문자 무관 부분일치)면 값을 `[REDACTED]`로
통째 대체 · 나머지 문자열 값은 120자에서 절단 · 최종 JSON 직렬화 결과가 2KB를 넘으면
통째로 `{"_truncated": true}`로 대체(부분 잘린 JSON을 만들지 않는다 — 파싱 불가 JSON
조각보다 "잘렸다"는 정직한 신호가 낫다)."""
from __future__ import annotations

import json
from typing import Any

_DENYLIST_SUBSTRINGS = ("token", "key", "secret", "password", "authorization", "cookie")
_VALUE_MAX_LEN = 120
_SUMMARY_MAX_BYTES = 2048
_REDACTED = "[REDACTED]"


def _is_denylisted_key(key: str) -> bool:
    lowered = key.lower()
    return any(sub in lowered for sub in _DENYLIST_SUBSTRINGS)


def _mask_value(key: str, value: Any) -> Any:
    if _is_denylisted_key(key):
        return _REDACTED
    if isinstance(value, str):
        return value if len(value) <= _VALUE_MAX_LEN else value[:_VALUE_MAX_LEN] + "…"
    if isinstance(value, dict):
        return mask_mapping(value)
    if isinstance(value, list):
        # story #3722 — 리스트는 top-level 키 마스킹 규칙이 안 미친다(키가 없다). 원소가
        # dict면 재귀 마스킹, 아니면(문자열/숫자 등) 그대로 — 리스트 자체를 통째로
        # [REDACTED]하지 않는다(입력 형태를 과하게 지우면 디버깅 가치가 없어진다).
        return [mask_mapping(v) if isinstance(v, dict) else v for v in value]
    return value


def mask_mapping(data: dict[str, Any]) -> dict[str, Any]:
    """dict 하나를 얕게(재귀 포함) 마스킹 — 최상위·중첩 dict 키 전부 denylist 대조."""
    return {k: _mask_value(k, v) for k, v in data.items()}


def build_input_summary(*, query_params: dict[str, Any], body: dict[str, Any] | None) -> dict[str, Any] | None:
    """쿼리+바디를 마스킹해 하나의 요약으로 합친다. 요청에 실을 게 아예 없으면(둘 다
    빈 경우) None — 「빈 dict를 저장」과 「실을 게 없었다」를 가른다(지어내지 않는다)."""
    summary: dict[str, Any] = {}
    if query_params:
        summary["query"] = mask_mapping(query_params)
    if body:
        summary["body"] = mask_mapping(body)
    if not summary:
        return None

    serialized = json.dumps(summary, ensure_ascii=False, default=str)
    if len(serialized.encode("utf-8")) > _SUMMARY_MAX_BYTES:
        return {"_truncated": True}
    return summary
