"""story #2191 CI 후속(오르테가군, 2026-07-27) — parse_doc_cursor가 "값이 있는지"만 보고
"그 값이 문자열인지"는 안 봐서, FastAPI Query(...) 없이 직접 호출되며 cursor= 를 누락하면
파이썬 기본값(Query 센티넬 객체, truthy)이 그대로 통과해 .split()에서 터지던 것(#2540 CI
실패의 근본원인, test_2193_doc_summary_created_at_realdb.py에서 실제로 발생).

이 클래스(#2230 죽은 cursor·#2233 위조 total과 같은 가족 — "있어 보이면 통과시키는 검사")를
닫는다: 문자열이 아닌 것은 타입 단계에서 즉시 None(커서 없음) 취급.
"""
from __future__ import annotations

import uuid

from app.repositories.doc import parse_doc_cursor


def test_none_returns_none():
    assert parse_doc_cursor(None) is None


def test_empty_string_returns_none():
    assert parse_doc_cursor("") is None


def test_valid_cursor_parses():
    did = uuid.uuid4()
    assert parse_doc_cursor(f"3:{did}") == (3, did)


def test_malformed_string_raises_400():
    from fastapi import HTTPException
    import pytest as _pytest
    with _pytest.raises(HTTPException) as ei:
        parse_doc_cursor("not-a-valid-cursor")
    assert ei.value.status_code == 400


def test_non_string_truthy_object_treated_as_no_cursor_not_crash():
    """#2540 CI 재현 — FastAPI Query(...) 센티넬 객체(str이 아니지만 truthy)를 흉내낸다.
    예전 코드는 이 자리에서 AttributeError(→400으로 변질)로 터졌다. 이제는 '커서 없음'으로
    조용히 정규화되어 정상 요청처럼 처리된다."""
    class _FakeQuerySentinel:
        """FastAPI Query(...) 객체처럼 str이 아니면서 truthy인 것을 흉내내는 최소 더미."""
        default = None

    fake_sentinel = _FakeQuerySentinel()
    assert bool(fake_sentinel) is True  # 이 시나리오의 전제 — truthy임을 먼저 확인
    assert parse_doc_cursor(fake_sentinel) is None
