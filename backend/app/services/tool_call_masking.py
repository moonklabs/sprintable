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
# 카디르 QA②(2026-09-09) — list→list→dict처럼 리스트 원소 안에서 다시 리스트가
# 나오면 옛 구현(리스트 원소가 dict인지만 봄)은 그 안쪽을 그대로 통과시켜 비밀값이
# 평문으로 DB에 남았다. 임의 깊이 재귀로 고치되, 그 재귀 자체가 이 스토리가 방금
# 고친 것과 같은 클래스(RecursionError, `_parse_json_body`)를 마스킹 함수 자신
# 안에서 되풀이하지 않도록 깊이 상한을 둔다 — 넘으면 그 아래는 통째 truncated.
_MAX_DEPTH = 20
_TRUNCATED = "[truncated]"


def _is_denylisted_key(key: str) -> bool:
    lowered = key.lower()
    return any(sub in lowered for sub in _DENYLIST_SUBSTRINGS)


def _mask_recursive(value: Any, depth: int) -> Any:
    if depth > _MAX_DEPTH:
        return _TRUNCATED
    if isinstance(value, str):
        return value if len(value) <= _VALUE_MAX_LEN else value[:_VALUE_MAX_LEN] + "…"
    if isinstance(value, dict):
        return {
            k: (_REDACTED if _is_denylisted_key(k) else _mask_recursive(v, depth + 1))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        # story #3722 — 리스트/튜플 원소는 키가 없다(denylist 판정 대상이 아니다).
        # dict·list·tuple 어느 형태든 depth+1로 계속 내려간다(카디르 QA② 처방 —
        # "지정 경로만"이 아니라 형태 클래스 전체를 잡는다).
        return [_mask_recursive(v, depth + 1) for v in value]
    return value


def mask_mapping(data: dict[str, Any]) -> dict[str, Any]:
    """dict 하나를 임의 깊이로 마스킹 — 최상위·중첩 dict 키 전부 denylist 대조,
    list/tuple 안에 몇 겹이 있든 재귀한다(깊이 상한은 `_MAX_DEPTH` 참고)."""
    return _mask_recursive(data, depth=0)


def build_input_summary(
    *,
    path_params: dict[str, Any] | None = None,
    query_params: dict[str, Any],
    body: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """경로+쿼리+바디를 마스킹해 하나의 요약으로 합친다. 요청에 실을 게 아예 없으면(셋
    다 빈 경우) None — 「빈 dict를 저장」과 「실을 게 없었다」를 가른다(지어내지 않는다).

    path_params(페드루 PO 追加 2026-09-09) — route 템플릿(`/stories/{id}/...`)만으로는
    «어느 스토리/태스크를 건드렸나»가 안 남는다. story_id 추출에 이미 읽는 값이라
    비용 0 — denylist·절단 규칙 동일 적용(id류는 보통 denylist에 안 걸림)."""
    summary: dict[str, Any] = {}
    if path_params:
        summary["path"] = mask_mapping(path_params)
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
