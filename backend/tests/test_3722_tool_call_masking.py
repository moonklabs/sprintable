"""story #3722 — `tool_call_masking.py` denylist·절단·상한 규칙(스토리 確定 설계)."""
from __future__ import annotations

from app.services.tool_call_masking import (
    _SUMMARY_MAX_BYTES,
    _VALUE_MAX_LEN,
    build_input_summary,
    mask_mapping,
)


def test_denylisted_keys_redacted_case_insensitive():
    masked = mask_mapping({
        "token": "abc", "Authorization": "Bearer xyz", "api_key": "sk_live_x",
        "password": "hunter2", "SECRET_VALUE": "s", "cookie": "c", "normal": "kept",
    })
    assert masked["token"] == "[REDACTED]"
    assert masked["Authorization"] == "[REDACTED]"
    assert masked["api_key"] == "[REDACTED]"
    assert masked["password"] == "[REDACTED]"
    assert masked["SECRET_VALUE"] == "[REDACTED]"
    assert masked["cookie"] == "[REDACTED]"
    assert masked["normal"] == "kept"


def test_denylist_substring_match_catches_prefixed_suffixed_keys():
    """부분일치 — "user_token"·"x_api_key" 같은 접두/접미 변형도 잡아야 한다(정확한 키
    이름만 대조하면 놓치는 자리가 실무에 흔하다)."""
    masked = mask_mapping({"user_token": "t", "x_api_key": "k", "session_secret": "s"})
    assert masked["user_token"] == "[REDACTED]"
    assert masked["x_api_key"] == "[REDACTED]"
    assert masked["session_secret"] == "[REDACTED]"


def test_nested_dict_masked_recursively():
    masked = mask_mapping({"outer": {"token": "abc", "safe": "ok"}})
    assert masked["outer"]["token"] == "[REDACTED]"
    assert masked["outer"]["safe"] == "ok"


def test_list_of_dicts_masked_per_element():
    masked = mask_mapping({"items": [{"token": "a"}, {"safe": "b"}]})
    assert masked["items"][0]["token"] == "[REDACTED]"
    assert masked["items"][1]["safe"] == "b"


def test_list_in_dict_secret_masked():
    """카디르 QA②(2026-09-09) 양성대조 1 — dict 안 list 안 dict."""
    masked = mask_mapping({"items": [[{"password": "hunter2"}]]})
    assert masked["items"][0][0]["password"] == "[REDACTED]"


def test_list_in_list_in_dict_secret_masked():
    """카디르 QA②(2026-09-09) 양성대조 2 — list 안 list 안 dict(옛 구현이 못 잡던
    바로 그 모양: 리스트 원소가 dict인지만 봐서 이 자리를 그대로 통과시켰다)."""
    masked = mask_mapping({"outer": [[{"secret": "leak-me"}]]})
    assert masked["outer"][0][0]["secret"] == "[REDACTED]"
    assert "leak-me" not in str(masked)


def test_dict_in_list_in_dict_secret_masked():
    """카디르 QA②(2026-09-09) 양성대조 3 — dict 안 list 안 dict(중첩 순서 반대)."""
    masked = mask_mapping({"a": {"b": [{"api_key": "leak-me-too"}]}})
    assert masked["a"]["b"][0]["api_key"] == "[REDACTED]"
    assert "leak-me-too" not in str(masked)


def test_masking_never_recursion_errors_on_pathological_depth():
    """카디르 QA②(2026-09-09) — 마스킹 함수 자신이 RecursionError를 내면 이 스토리가
    방금 고친 것과 같은 클래스가 재발한다. 깊이 상한 너머는 truncated로 끊긴다."""
    nested = "leaf"
    for _ in range(500):
        nested = [nested]
    masked = mask_mapping({"deep": nested})
    assert masked  # RecursionError 없이 반환됨 자체가 이 테스트의 핵심 단언


def test_long_string_value_truncated_at_120_chars():
    long_value = "x" * 500
    masked = mask_mapping({"note": long_value})
    assert len(masked["note"]) == _VALUE_MAX_LEN + 1  # +1 for the "…" marker
    assert masked["note"].endswith("…")


def test_short_string_value_not_truncated():
    masked = mask_mapping({"note": "short"})
    assert masked["note"] == "short"


def test_build_input_summary_combines_query_and_body():
    summary = build_input_summary(query_params={"status": "failed"}, body={"title": "t", "token": "x"})
    assert summary == {"query": {"status": "failed"}, "body": {"title": "t", "token": "[REDACTED]"}}


def test_build_input_summary_includes_masked_path_params():
    """story #3722 — 페드루 PO 追加(2026-09-09): route 템플릿만으로는 «어느 스토리/태스크를
    건드렸나»가 안 남는다. path_params도 같은 마스킹 규칙으로 실린다."""
    summary = build_input_summary(
        path_params={"id": "story-123", "token": "leak"}, query_params={}, body=None,
    )
    assert summary == {"path": {"id": "story-123", "token": "[REDACTED]"}}


def test_build_input_summary_returns_none_when_nothing_to_record():
    assert build_input_summary(query_params={}, body=None) is None
    assert build_input_summary(path_params={}, query_params={}, body={}) is None


def test_build_input_summary_truncates_whole_payload_over_2kb():
    huge_body = {f"field_{i}": "y" * 100 for i in range(50)}
    summary = build_input_summary(query_params={}, body=huge_body)
    assert summary == {"_truncated": True}
    import json
    assert len(json.dumps(summary).encode("utf-8")) < _SUMMARY_MAX_BYTES
