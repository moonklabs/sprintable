"""story #3605(BE·소형·신뢰, PO 確定 2026-09-07) — 3598 AC6 일반화. Graph API
권한/인증 계열 오류 family를 190/OAuthException 밖으로 넓힌다(code==10·200~299)
— 사람이 재연결해야 풀리는 원인만 CONNECTION kind로 fail-closed 승격. 순수 함수
단위테스트, DB 불요(test_3598_graph_oauth_error_parser.py와 동형 관례)."""
from __future__ import annotations

import pytest

from app.services.graph_api_errors import (
    classify_graph_error_code,
    classify_graph_oauth_error,
    connection_status_for_error_code,
)


class TestPermissionFamilyExtension:
    def test_code_10_falls_closed_to_error(self):
        """code==10("Application does not have permission") — subcode 체계가 190
        처럼 표준화돼 있지 않아 expired/revoked를 못 가른다, fail-closed로 error."""
        assert classify_graph_oauth_error(error_code=10, error_subcode=None, error_type=None) == (
            "error", "error",
        )

    @pytest.mark.parametrize("code", [200, 250, 299])
    def test_permission_error_range_200_to_299_falls_closed_to_error(self, code: int):
        assert classify_graph_oauth_error(error_code=code, error_subcode=None, error_type=None) == (
            "error", "error",
        )

    def test_code_300_is_outside_the_permission_range_boundary(self):
        """뮤테이션 표적 — range(200,300) 상한이 300을 포함하면 이 assert가 깨진다."""
        assert classify_graph_oauth_error(error_code=300, error_subcode=None, error_type=None) is None

    def test_code_199_is_outside_the_permission_range_boundary(self):
        """뮤테이션 표적 — range(200,300) 하한이 199를 포함하면 이 assert가 깨진다."""
        assert classify_graph_oauth_error(error_code=199, error_subcode=None, error_type=None) is None

    def test_code_9_is_not_code_10(self):
        assert classify_graph_oauth_error(error_code=9, error_subcode=None, error_type=None) is None

    def test_code_11_is_not_code_10(self):
        assert classify_graph_oauth_error(error_code=11, error_subcode=None, error_type=None) is None


class TestRateLimitCodesNeverEnterThisFamily:
    """⛔story #3605 핵심 요구 — 「연결 상태 승격은 사람이 고칠 수 있는 원인에만」
    (한 방향 문). rate-limit 코드가 우연히라도 이 family에 안 걸리는지 직접 검증
    (200~299 범위 밖이라는 사실을 구조적으로 고정, 문서 주장만 두지 않는다)."""

    @pytest.mark.parametrize("code", [4, 17, 32, 613])
    def test_known_rate_limit_codes_are_never_classified_as_oauth_family(self, code: int):
        assert classify_graph_oauth_error(error_code=code, error_subcode=None, error_type=None) is None


class TestClassifyGraphErrorCode:
    """classify_graph_error_code — error_code 문자열 하나로 옮기는 공유 지점.
    발행(_classify_threads_error)·댓글 수집(channel_post_comments.py) 둘 다 이
    함수를 쓴다(3605에서 통합)."""

    def test_code_190_expired_subcode_maps_to_channel_token_expired(self):
        assert classify_graph_error_code(
            status_code=401, provider_error_code=190, provider_error_subcode=463,
            provider_error_type="OAuthException",
        ) == "CHANNEL_TOKEN_EXPIRED"

    def test_code_190_revoked_subcode_maps_to_channel_connection_revoked(self):
        assert classify_graph_error_code(
            status_code=401, provider_error_code=190, provider_error_subcode=490,
            provider_error_type="OAuthException",
        ) == "CHANNEL_CONNECTION_REVOKED"

    def test_code_10_maps_to_channel_connection_auth_error(self):
        """AC1 핵심 — code 10 → CONNECTION kind(구체적으로는 CHANNEL_CONNECTION_
        AUTH_ERROR, publication_command.py::_CONNECTION_BLOCKED_CODES 등재 확認은
        test_3605_connection_promotion_paths_consistent.py)."""
        assert classify_graph_error_code(
            status_code=401, provider_error_code=10, provider_error_subcode=None, provider_error_type=None,
        ) == "CHANNEL_CONNECTION_AUTH_ERROR"

    def test_code_200_maps_to_channel_connection_auth_error(self):
        """AC1 핵심 — code 200 → CONNECTION kind."""
        assert classify_graph_error_code(
            status_code=401, provider_error_code=200, provider_error_subcode=None, provider_error_type=None,
        ) == "CHANNEL_CONNECTION_AUTH_ERROR"

    def test_rate_limit_code_4_falls_through_to_status_code_heuristic_not_connection(self):
        """AC1 핵심 — code 4(Application request limit reached)는 이 family 밖이라
        status_code(429)만으로 판정 → CHANNEL_RATE_LIMITED(TRANSIENT), CONNECTION
        이 아니다. 뮤테이션 표적 — family 범위가 code 4까지 잘못 넓어지면 이 assert가
        CHANNEL_CONNECTION_AUTH_ERROR로 깨져야 한다."""
        assert classify_graph_error_code(
            status_code=429, provider_error_code=4, provider_error_subcode=None, provider_error_type=None,
        ) == "CHANNEL_RATE_LIMITED"

    def test_unclassified_error_falls_through_to_status_code_401_heuristic(self):
        assert classify_graph_error_code(
            status_code=401, provider_error_code=None, provider_error_subcode=None, provider_error_type=None,
        ) == "CHANNEL_TOKEN_EXPIRED"

    def test_unclassified_error_falls_through_to_status_code_429_heuristic(self):
        assert classify_graph_error_code(
            status_code=429, provider_error_code=None, provider_error_subcode=None, provider_error_type=None,
        ) == "CHANNEL_RATE_LIMITED"

    def test_unclassified_error_falls_through_to_provider_error_fallback(self):
        assert classify_graph_error_code(
            status_code=502, provider_error_code=None, provider_error_subcode=None, provider_error_type=None,
        ) == "CHANNEL_PUBLISH_PROVIDER_ERROR"


class TestConnectionStatusForErrorCode:
    """connection_status_for_error_code — 4개 승격 지점이 공유하는 status 선택.
    이전엔 4곳 전부 error_code 무관하게 항상 "expired"였다(3605 실측 정정)."""

    def test_revoked_error_code_maps_to_revoked_status(self):
        assert connection_status_for_error_code("CHANNEL_CONNECTION_REVOKED", current_status="active") == "revoked"

    def test_auth_error_code_maps_to_error_status(self):
        assert connection_status_for_error_code("CHANNEL_CONNECTION_AUTH_ERROR", current_status="active") == "error"

    def test_token_expired_code_maps_to_expired_status_unchanged(self):
        assert connection_status_for_error_code("CHANNEL_TOKEN_EXPIRED", current_status="active") == "expired"

    def test_unmapped_code_defaults_to_expired_for_backward_compat(self):
        assert connection_status_for_error_code("CHANNEL_CONNECTION_NOT_ACTIVE", current_status="active") == "expired"

    def test_none_error_code_defaults_to_expired(self):
        assert connection_status_for_error_code(None, current_status="active") == "expired"

    def test_auth_error_does_not_downgrade_existing_revoked(self):
        """뮤테이션 표적 — 이 가드를 지우면 이미 알려진 「revoked」가 새로 들어온
        사유불명 「error」로 조용히 덮여 정밀도를 잃는다."""
        assert connection_status_for_error_code(
            "CHANNEL_CONNECTION_AUTH_ERROR", current_status="revoked",
        ) == "revoked"

    def test_auth_error_does_not_downgrade_existing_expired(self):
        assert connection_status_for_error_code(
            "CHANNEL_CONNECTION_AUTH_ERROR", current_status="expired",
        ) == "expired"

    def test_revoked_error_code_does_upgrade_existing_unspecified_error(self):
        """error(사유불명) → revoked(더 구체적)는 업그레이드라 허용된다 — "error"만
        다운그레이드 방지 대상이지 revoked/expired는 새 정보로 계속 갱신된다."""
        assert connection_status_for_error_code("CHANNEL_CONNECTION_REVOKED", current_status="error") == "revoked"
