"""story #1994(E-KNOWLEDGE-LINK S2) — 백링크 API 순수 로직(unit, DB 무관) 검증.

app.services.backlinks의 순수 함수를 커버: `build_content_snippet`(read-time 절삭·정규화)과
`encode_cursor`/`decode_cursor`(B3 — opaque composite keyset cursor round-trip/오류 처리).
DB/인가 판정(accessible_project_ids_in_org·_can_read_conversation) 및 Phase 1/2 쿼리 자체는
realdb 통합 테스트(test_1994_backlink_api_realdb.py)가 커버 — 이 파일은 그 위의 순수 계층만.

산티아고 sabotage-probe 재구현으로 구 아키텍처의 `_merge_sort_limit`(Python 병합정렬 +
limit 슬라이스)는 삭제됐다 — Phase 2가 단일 SQL 쿼리로 정렬/limit/has_more를 모두 처리하므로
그 자리를 대체하는 Python 순수 함수가 더 이상 없다(대체 = SQL ORDER BY + LIMIT :limit+1,
realdb 테스트가 커버)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.services.backlinks import build_content_snippet, decode_cursor, encode_cursor


# ─── build_content_snippet ──────────────────────────────────────────────────


def test_snippet_short_text_unchanged():
    assert build_content_snippet("hello world") == "hello world"


def test_snippet_normalizes_whitespace_and_newlines():
    assert build_content_snippet("hello\n\n  world   again") == "hello world again"


def test_snippet_truncates_with_ellipsis():
    text = "a" * 200
    snippet = build_content_snippet(text, max_len=160)
    assert len(snippet) == 161  # 160 chars + ellipsis
    assert snippet.endswith("…")
    assert snippet[:160] == "a" * 160


def test_snippet_empty_text():
    assert build_content_snippet("") == ""
    assert build_content_snippet(None) == ""  # type: ignore[arg-type]


def test_snippet_exact_boundary_no_ellipsis():
    text = "a" * 160
    assert build_content_snippet(text, max_len=160) == text


# ─── encode_cursor/decode_cursor(B3: opaque composite keyset cursor) ───────


_T0 = datetime(2026, 7, 17, 12, 0, 0, tzinfo=timezone.utc)


def test_cursor_round_trip_preserves_created_at_and_id():
    created_at = _T0 + timedelta(minutes=5)
    id_ = uuid.uuid4()
    token = encode_cursor(created_at, id_)
    decoded_at, decoded_id = decode_cursor(token)
    assert decoded_at == created_at
    assert decoded_id == id_


def test_cursor_is_opaque_base64_not_raw_iso():
    """클라이언트가 파싱하지 못하게(불투명) — 최소한 base64 alphabet이어야 하고, 통상적인
    ISO 8601 문자열이 그대로 노출돼선 안 된다(round-trip 후 값만 동일해야, 표현은 불투명)."""
    created_at = _T0
    id_ = uuid.uuid4()
    token = encode_cursor(created_at, id_)
    assert created_at.isoformat() not in token
    assert str(id_) not in token
    # urlsafe base64 alphabet(+/ 없이 -/_ 사용)만 포함 — URL-safe 검증.
    assert "+" not in token and "/" not in token


def test_cursor_different_ids_same_timestamp_produce_different_tokens():
    """B3 핵심: 같은 created_at이라도 id가 다르면 다른 토큰이어야(tie-breaking이 cursor
    표현 레벨에서부터 보존됨)."""
    created_at = _T0
    token_a = encode_cursor(created_at, uuid.uuid4())
    token_b = encode_cursor(created_at, uuid.uuid4())
    assert token_a != token_b


def test_decode_cursor_malformed_token_raises_400_not_500():
    with pytest.raises(HTTPException) as exc_info:
        decode_cursor("not-a-valid-base64-json-token!!!")
    assert exc_info.value.status_code == 400


def test_decode_cursor_valid_base64_but_wrong_json_shape_raises_400():
    import base64
    import json

    bad_payload = base64.urlsafe_b64encode(json.dumps({"unexpected": "shape"}).encode()).decode()
    with pytest.raises(HTTPException) as exc_info:
        decode_cursor(bad_payload)
    assert exc_info.value.status_code == 400
