"""story #3816(Phase3·3-6 PR2, 페드루 PO §낱말 정정 2, 2026-09-12) —
`site_posts.py::_blog_publish_error_code`의 Ghost 분기 단위 테스트. DB 불요(순수
함수, 예외 인스턴스만 넣어 본다)."""
from __future__ import annotations

from app.services.ghost_publish import GhostPublishError
from app.services.site_posts import _blog_publish_error_code
from app.services.wordpress_publish import WordPressPublishError


def test_ghost_401_maps_to_ghost_auth_failed():
    assert _blog_publish_error_code(GhostPublishError(status_code=401, body="x")) == "GHOST_AUTH_FAILED"


def test_ghost_5xx_maps_to_generic_provider_error_not_auth_failed():
    """뮤테이션 대상(스토리 본문 明示) — GhostPublishError 판정을 status_code
    무관하게 적용하도록 되돌리면 이 테스트가 RED여야 한다(5xx까지 GHOST_AUTH_
    FAILED로 잘못 승격돼 연결이 불필요하게 「다시 연결 필요」로 뜬다)."""
    assert _blog_publish_error_code(GhostPublishError(status_code=500, body="x")) == "CHANNEL_PUBLISH_PROVIDER_ERROR"


def test_wordpress_401_still_maps_to_channel_publish_auth_rejected_unaffected():
    """회귀 0 — Ghost 전용 분기 추가가 wordpress/webhook의 기존 401/403 분류를
    안 건드린다."""
    assert _blog_publish_error_code(WordPressPublishError(status_code=401, body="x")) == "CHANNEL_PUBLISH_AUTH_REJECTED"
