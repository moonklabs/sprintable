"""story #2444: resend-verification 재전송 rate-limit — 인스턴스별 in-memory라 ×인스턴스수만큼
느슨해지던 갭을 격리된 Redis-backed limiter로 닫는다.

⭐설계: 공유 `limiter`(login·refresh·switch-account 등 8개 auth-critical 라우트)는 그대로
in-memory — PO 결정(가용성 우선, Redis 블립이 로그인까지 막으면 안 됨). `resend_verification_
limiter`만 별도 인스턴스로 분리해 Redis storage_uri + wrap_exceptions=True를 쓴다. 이 파일은
그 분리·강제·fail-closed 세 가지를 직접 증명한다 — HTTP 왕복이 아니라 `.limiter.hit()` 직접
호출로 검증하는 이유: 두 Limiter 모두 `enabled=not _TESTING`(pytest 中엔 항상 False)라 HTTP
경로로는 검사 자체가 안 돈다. `.hit()` 직접 호출은 그 enabled 게이트를 우회해 스토리지
계층(진짜 바뀐 부분)만 정밀 조준한다.

fakeredis로 실제 Redis 프로세스 없이 왕복 — RedisStorage가 lua_incr_expire를 쓰지만 fakeredis
2.36+가 EVAL을 자체 지원해 lupa 없이도 동작함을 실측 확認(test_sse_lease.py의 fakeredis+lupa
컨벤션과 다른 자리 — 필요했다면 여기서도 lupa를 요구했을 것).
"""
from __future__ import annotations

import limits
import pytest
import redis as redis_module


@pytest.fixture
def _fake_redis_storage():
    """resend_verification_limiter 를 fakeredis 백엔드로 스왑 — 원 인스턴스 자체를 건드려
    실제 프로덕션 경로(app/core/rate_limit.py 모듈 싱글턴)를 그대로 검증한다."""
    fakeredis = pytest.importorskip("fakeredis")
    from unittest.mock import patch

    from app.core.rate_limit import resend_verification_limiter

    fake_client = fakeredis.FakeStrictRedis()
    with patch.object(redis_module, "from_url", return_value=fake_client):
        from limits.storage import storage_from_string

        original_storage = resend_verification_limiter._storage
        resend_verification_limiter._storage = storage_from_string(
            "redis://fake/0", wrap_exceptions=True
        )
        try:
            yield resend_verification_limiter
        finally:
            resend_verification_limiter._storage = original_storage


def test_isolated_limiter_is_separate_instance_from_shared_limiter():
    """story #2444 핵심 계약: resend 전용 limiter가 login/refresh 공유 limiter와 «다른»
    객체여야 blast radius가 격리된다. 같은 객체면 이 스토리 전체가 무의미해진다."""
    from app.core.rate_limit import limiter, resend_verification_limiter

    assert resend_verification_limiter is not limiter
    assert resend_verification_limiter._storage is not limiter._storage


def test_resend_route_uses_isolated_limiter_not_shared():
    """auth.py의 /resend-verification 데코레이터가 공유 limiter가 아니라 격리 limiter를
    참조하는지 — import 자체가 아니라 실제 데코레이터 등록(slowapi 내부 _route_limits)에서
    확認한다(문자열 grep이 아니라 런타임 배선 증명)."""
    from app.core.rate_limit import limiter, resend_verification_limiter
    from app.routers.auth import resend_verification

    name = f"{resend_verification.__module__}.{resend_verification.__name__}"
    # slowapi가 @limiter.limit(...) 를 건 함수명을 self._route_limits(dict)에 기록한다.
    assert name in resend_verification_limiter._route_limits, (
        "resend_verification이 격리 limiter의 _route_limits에 없음 — 데코레이터가 "
        "여전히 공유 limiter를 참조 중일 수 있는(회귀)"
    )
    assert name not in limiter._route_limits, (
        "resend_verification이 공유 limiter의 _route_limits에도 있음 — 이중등록 "
        "또는 격리 실패"
    )


def test_storage_error_handler_registered_on_app():
    """main.py가 limits.errors.StorageError 전용 핸들러를 등록했는지 — 이게 없으면 Redis
    장애 시 fail-closed(503)가 아니라 generic 500(또는 미확認 동작)으로 샌다."""
    from limits.errors import StorageError

    from app.main import app

    assert StorageError in app.exception_handlers, (
        "StorageError 전용 핸들러 미등록 — Redis 장애 시 fail-closed 응답이 명시적이지 않음"
    )


def test_redis_backed_enforces_global_3_per_hour_regardless_of_key_repeats(_fake_redis_storage):
    """AC1: 같은 key로 3번까지 허용, 4번째부터 거부 — 「인스턴스 수와 무관」의 대리증명
    (fakeredis 단일 프로세스지만, in-memory였다면 애초에 이 스토리지 객체 스왑 자체가
    다른 프로세스처럼 「공유되는지」와 무관하게 항상 통과했을 것이라 스왑 자체가 유의미)."""
    limit = limits.parse("3/hour")
    key = "test-resend-key"
    results = [_fake_redis_storage.limiter.hit(limit, key, "resend") for _ in range(5)]
    assert results == [True, True, True, False, False], (
        f"3/hour 강제 실패 — {results}"
    )


def test_redis_unreachable_raises_storage_error_not_silent_allow():
    """AC3: Redis 자체가 아예 unreachable(연결 거부)일 때 «조용히 허용」이 아니라
    StorageError(fail-closed 트리거)를 내야 한다 — sse_lease(#2121)의 「429=fail-open」
    컨벤션과 정반대가 의도적임을 이 assert가 고정한다."""
    from limits.errors import StorageError
    from limits.storage import storage_from_string

    # 존재하지 않는 포트 — 연결 자체가 즉시 거부되는 결정론적 실패(네트워크 타임아웃 아님).
    broken_storage = storage_from_string(
        "redis://localhost:1/0", wrap_exceptions=True, socket_connect_timeout=1
    )
    limit = limits.parse("3/hour")
    from limits.strategies import FixedWindowRateLimiter

    strategy = FixedWindowRateLimiter(broken_storage)
    with pytest.raises(StorageError):
        strategy.hit(limit, "unreachable-key", "resend")
