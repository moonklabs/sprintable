"""story #3598(BE·중형, PO 確定 2026-09-06) — `classify_graph_oauth_error`(공용
Graph API 190/OAuthException error_subcode → 연결 status/reason 매퍼) 순수 함수
단위테스트. DB 불요 — 실PG 없이도 항상 돈다(test_3411_text_preview_pure.py와 동형
관례).

subcode별 reason은 스토리 본문 確定①에 그대로 못박힌 목록(458 앱 권한 없음/460
비번 변경/463 만료/467 무효/490 등) 그대로 검증 — 지어낸 값 0."""
from __future__ import annotations

import pytest

from app.services.graph_api_errors import classify_graph_oauth_error


def test_subcode_463_expired_is_the_only_natural_expiry():
    assert classify_graph_oauth_error(error_code=190, error_subcode=463, error_type="OAuthException") == (
        "expired", "expired",
    )


@pytest.mark.parametrize("subcode", [458, 460, 467, 490])
def test_revoked_subcodes_from_story_body_confirmed_list(subcode: int):
    """458(앱 권한 없음)·460(비번 변경)·467(무효)·490(사용자가 앱 권한 취소) — 전부
    사용자/보안 행동으로 무효화된 세션이라 revoked(자동 갱신 불가, 463과 다른 부류)."""
    assert classify_graph_oauth_error(
        error_code=190, error_subcode=subcode, error_type="OAuthException",
    ) == ("revoked", "revoked")


def test_code_190_with_unknown_subcode_fails_closed_to_error_not_expired_or_revoked():
    """미지 subcode(예: Meta가 새로 추가한 값) — 만료·회수를 섣불리 단정하지 않고
    "인증 계열 실패인 건 확실하지만 사유는 모른다"로 error(AC6과 같은 fail-closed
    원칙 — 뮤테이션 표적①: 이 분기를 지우면 미지 subcode가 None이나 다른 값으로
    새 버그를 낸다)."""
    assert classify_graph_oauth_error(
        error_code=190, error_subcode=999, error_type="OAuthException",
    ) == ("error", "error")


def test_code_190_with_missing_subcode_also_falls_closed_to_error():
    """error_subcode 자체가 없는(None) 190/OAuthException — 여전히 error(만료·회수
    어느 쪽도 지어내지 않는다)."""
    assert classify_graph_oauth_error(
        error_code=190, error_subcode=None, error_type="OAuthException",
    ) == ("error", "error")


def test_non_oauth_error_returns_none_so_caller_falls_through_to_other_classification():
    """code!=190이고 type도 OAuthException이 아니면 이 함수의 관할 밖 — None(호출부가
    429/5xx 등 다른 분류로 넘어간다). 뮤테이션 표적②: 이 가드를 지우면 무관한 오류도
    강제로 (status, reason)을 반환해 429/5xx 분류를 밀어낸다."""
    assert classify_graph_oauth_error(error_code=100, error_subcode=None, error_type="GraphMethodException") is None


def test_oauth_exception_type_without_code_190_still_matches_by_type_alone():
    """일부 Graph 응답은 code가 다른 값(예: 200번대)이어도 type=="OAuthException"으로
    권한 계열임을 알린다 — code만 보고 판단하면 이런 경우를 놓친다(3595 표의 「페이지
    연결 해제」류가 이 경로로 잡힐 가능성)."""
    assert classify_graph_oauth_error(error_code=200, error_subcode=463, error_type="OAuthException") == (
        "expired", "expired",
    )
