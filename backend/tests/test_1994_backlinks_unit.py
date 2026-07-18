"""story #1994(E-KNOWLEDGE-LINK S2) — 백링크 API 순수 로직(unit, DB 무관) 검증.

app.services.backlinks의 두 순수 함수를 커버: `build_content_snippet`(read-time 절삭·정규화)
과 `_merge_sort_limit`(authz 통과 집합의 병합정렬+limit 슬라이스+has_more 판정). DB/인가
판정(has_project_access·_can_read_conversation) 자체는 realdb 통합 테스트
(test_1994_backlink_api_realdb.py)가 커버 — 이 파일은 그 위의 순수 계층만.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.services.backlinks import _merge_sort_limit, build_content_snippet


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


# ─── _merge_sort_limit ───────────────────────────────────────────────────────


class _FakeMention:
    """Mention의 created_at만 참조하는 순수 함수 테스트용 최소 스텁."""

    def __init__(self, created_at: datetime, tag: str):
        self.created_at = created_at
        self.tag = tag  # 식별용(순서 검증)

    def __repr__(self):
        return f"<FakeMention {self.tag} {self.created_at}>"


_T0 = datetime(2026, 7, 17, 12, 0, 0, tzinfo=timezone.utc)


def _at(minutes: int, tag: str) -> _FakeMention:
    return _FakeMention(_T0 + timedelta(minutes=minutes), tag)


def test_merge_sort_limit_empty_input():
    page, has_more = _merge_sort_limit([], limit=10)
    assert page == []
    assert has_more is False


def test_merge_sort_limit_fewer_than_limit_no_more():
    items = [_at(3, "c"), _at(1, "a"), _at(2, "b")]  # 일부러 비정렬 입력
    page, has_more = _merge_sort_limit(items, limit=10)
    assert [i.tag for i in page] == ["c", "b", "a"]  # created_at DESC
    assert has_more is False


def test_merge_sort_limit_exact_limit_no_more():
    items = [_at(i, str(i)) for i in range(5)]
    page, has_more = _merge_sort_limit(items, limit=5)
    assert len(page) == 5
    assert has_more is False


def test_merge_sort_limit_more_than_limit_sets_has_more_and_slices():
    items = [_at(i, str(i)) for i in range(7)]  # 0..6분, desc면 6이 최신
    page, has_more = _merge_sort_limit(items, limit=5)
    assert has_more is True
    assert len(page) == 5
    # 최신 5개(가장 큰 minute)만 남아야 함: 6,5,4,3,2
    assert [i.tag for i in page] == ["6", "5", "4", "3", "2"]


def test_merge_sort_limit_is_pure_no_mutation_of_input_order_dependency():
    """입력 리스트 순서가 이미 뒤섞여 있어도(라운드 병합 가정) 결과는 항상 정렬됨을 보장."""
    items = [_at(2, "b"), _at(5, "e"), _at(0, "z"), _at(4, "d"), _at(1, "a")]
    page, has_more = _merge_sort_limit(items, limit=3)
    assert [i.tag for i in page] == ["e", "d", "b"]
    assert has_more is True
