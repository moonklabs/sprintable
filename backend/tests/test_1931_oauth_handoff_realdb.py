"""story 1931(계약 doc `e-mobile-oauth-native-handoff-contract` §4/§7.5(b)·산티아고 §10 MUST
2026-07-16 조건부 GREEN, 이후 미르코 실측 정정+산티아고 재확認): 경량 OAuth-handoff
issue/consume — attested native-bootstrap(§7.5, C4)과 물리적으로 분리된 PKCE 기반 단회코드
발급/소비. 실 라이브 web OAuth(`app/routers/auth.py:990 oauth_callback()`)는 Firebase
무접촉·레거시 self-issued JWT만 발급하므로, issue는 BFF가 이미 해소한 user_id를 그대로
신뢰(내부시크릿=신뢰근거)하고 consume은 레거시 access/refresh 토큰 쌍을 mint한다
(`create_tokens()`+`_store_refresh_token()` 재사용).

§10.6 필수 음성 테스트 7종 중 이 파일이 커버하는 것: 1(assertion류 필드 주입 거부)·
3(잘못된 verifier 거부)·4(동시 소비 정확히 1회)·7(위조 필드 schema 거부, 무시 아님) —
2(구 attested consume이 신규 코드를 소비 못 함)는 물리적 테이블 분리 자체가 증명.

story #3121 AC1(계약 §2/§10.7) 추가: callback_mode/return_uri issue-time 고정 + consume-time
대조 — `test_issue_rejected_return_uri_mismatch_for_mode`·
`test_consume_rejected_when_callback_mode_mismatches_issued`·
`test_consume_rejected_when_return_uri_mismatches_issued`."""
from __future__ import annotations

import asyncio
import os
import secrets
import uuid

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_after():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _setup_common(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_oauth_handoff_enabled", True)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "")
    monkeypatch.setattr(settings, "app_env", "development")
    monkeypatch.setattr(settings, "jwt_secret", "test-jwt-secret", raising=False)


async def _seed_eligible_user(session):
    from app.core.security import hash_password
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"oauth-handoff-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    return user_id


def _pkce_pair():
    from app.services.oauth_handoff import pkce_challenge_from_verifier
    verifier = secrets.token_urlsafe(32)
    return verifier, pkce_challenge_from_verifier(verifier)


# story #3121 AC1 — 대부분의 기존 테스트는 mode/URI 매칭 자체가 관심사가 아니므로(verifier
# 오류·replay·동시성·cutover 등 다른 축을 검증), 일관된 https 기본값을 재사용한다.
def _https_return_uri() -> str:
    from app.core.config import settings
    return f"{settings.app_url}/native/oauth-return"


_CUSTOM_SCHEME_RETURN_URI = "ai.sprintable:/oauth-return"


# story #3121 AC2/AC3 — issue/consume가 이제 Request를 받는다(rate limit IP 키·감사기록
# ip/user-agent). 직접함수호출 스타일 테스트라 ASGI 스택 없이 최소 shape만 흉내낸다(기존
# test_cbd578d4_c4_bootstrap_flow_realdb.py의 _FakeRequest 관행과 동형).
class _FakeRequest:
    def __init__(self, ip: str = "127.0.0.1"):
        self.client = type("_FakeClient", (), {"host": ip})()
        self.headers: dict[str, str] = {}


def _issue_req(user_id, challenge, *, callback_mode="https", return_uri=None):
    from app.routers.auth_firebase_internal import OAuthHandoffIssueRequest
    return OAuthHandoffIssueRequest(
        user_id=str(user_id), code_challenge=challenge,
        callback_mode=callback_mode, return_uri=return_uri if return_uri is not None else _https_return_uri(),
    )


def _consume_req(code, verifier, *, callback_mode="https", return_uri=None):
    from app.routers.auth_firebase_internal import OAuthHandoffConsumeRequest
    return OAuthHandoffConsumeRequest(
        code=code, code_verifier=verifier,
        callback_mode=callback_mode, return_uri=return_uri if return_uri is not None else _https_return_uri(),
    )


@pytest.mark.anyio
async def test_issue_and_consume_round_trip_success(monkeypatch):
    from app.routers.auth_firebase_internal import consume_oauth_handoff, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)
        assert issued.code

        async with Session() as s:
            consumed = await consume_oauth_handoff(_FakeRequest(), 
                _consume_req(issued.code, verifier), authorization=None, db=s,
            )
        assert consumed.access_token
        assert consumed.refresh_token
        assert consumed.token_type == "bearer"
        assert consumed.expires_in > 0

        from app.core.security import decode_jwt
        claims = decode_jwt(consumed.access_token)
        assert claims["sub"] == str(user_id)
        assert claims["auth_source"] == "oauth_handoff"
        assert claims["device_attested"] is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_wrong_verifier_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import consume_oauth_handoff, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)

        wrong_verifier, _ = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(_FakeRequest(), 
                    _consume_req(issued.code, wrong_verifier), authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_wrong_verifier_burns_code_no_retry(monkeypatch):
    """§10.4 MUST("실패 mint가 재사용 상태로 되돌리지 않음"): code_hash 조건만으로 먼저
    원자 소비하고 그 다음 constant-time PKCE 비교를 하므로, 틀린 verifier로 한 번 시도하면
    코드가 이미 소모돼 그 뒤 올바른 verifier로도 재시도가 불가해야 한다(무제한 verifier
    추측 방지)."""
    from app.routers.auth_firebase_internal import consume_oauth_handoff, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)

        wrong_verifier, _ = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException):
                await consume_oauth_handoff(_FakeRequest(), 
                    _consume_req(issued.code, wrong_verifier), authorization=None, db=s,
                )

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(_FakeRequest(), 
                    _consume_req(issued.code, verifier), authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_replay_after_success_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import consume_oauth_handoff, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)

        req = _consume_req(issued.code, verifier)
        async with Session() as s:
            first = await consume_oauth_handoff(_FakeRequest(), req, authorization=None, db=s)
        assert first.access_token

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(_FakeRequest(), req, authorization=None, db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_concurrent_consume_exactly_one_succeeds(monkeypatch):
    """산티아고 §9/§10 native consume 게이트와 동형 요구 — 병렬 N-way 동시성에도 정확히 1회만 mint."""
    from app.routers.auth_firebase_internal import consume_oauth_handoff, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)

        req = _consume_req(issued.code, verifier)

        async def _attempt():
            async with Session() as s:
                try:
                    return await consume_oauth_handoff(_FakeRequest(), req, authorization=None, db=s)
                except HTTPException:
                    return None

        results = await asyncio.gather(*[_attempt() for _ in range(5)])
        successes = [r for r in results if r is not None]
        assert len(successes) == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_rejected_when_feature_disabled(monkeypatch):
    from app.routers.auth_firebase_internal import issue_oauth_handoff
    from app.core.config import settings

    _setup_common(monkeypatch)
    monkeypatch.setattr(settings, "firebase_oauth_handoff_enabled", False)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)
        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)
            assert exc_info.value.status_code == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_rejected_unknown_user(monkeypatch):
    from app.routers.auth_firebase_internal import issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(_FakeRequest(), _issue_req(uuid.uuid4(), challenge), authorization=None, db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_rejected_inactive_user(monkeypatch):
    from app.routers.auth_firebase_internal import issue_oauth_handoff
    from app.core.security import hash_password
    from app.models.user import User

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        user_id = uuid.uuid4()
        async with Session() as s:
            s.add(User(
                id=user_id, email=f"inactive-{user_id.hex[:8]}@test.com",
                hashed_password=hash_password("x"), is_active=False, email_verified=True,
            ))
            await s.commit()

        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_rejected_short_code_challenge(monkeypatch):
    from app.routers.auth_firebase_internal import issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(_FakeRequest(), 
                    _issue_req(user_id, "too-short"), authorization=None, db=s,
                )
            assert exc_info.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_orphan_finding_revoke_between_issue_and_consume_rejected(monkeypatch):
    """Story A(bea25062)/C4 orphan-finding 회귀와 동형 — issue 이후(120초 내 미만료) revoke가
    발생하면 consume이 cutover 재검증에서 거부돼야 한다(레거시 세션도 동일 §17d 메커니즘)."""
    from app.routers.auth_firebase_internal import consume_oauth_handoff, issue_oauth_handoff
    from app.services.auth_cutover import revoke_user_sessions

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)

        async with Session() as s:
            await revoke_user_sessions(s, user_id, firebase_uid=None)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(_FakeRequest(), 
                    _consume_req(issued.code, verifier), authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


# ─── story #3121 AC1 — callback_mode/return_uri issue-time 고정 + consume-time 대조 ───────

@pytest.mark.anyio
async def test_issue_rejected_return_uri_mismatch_for_mode(monkeypatch):
    """계약 §2/§10.9 exact-origin — https 모드인데 custom-scheme URI를 선언(혹은 그 반대)하면
    issue 자체가 거부돼야 한다. 클라 선언을 그대로 저장하지 않고 서버 고정값과 대조한다는
    것의 직접 증거."""
    from app.routers.auth_firebase_internal import issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(_FakeRequest(), 
                    _issue_req(user_id, challenge, callback_mode="https", return_uri=_CUSTOM_SCHEME_RETURN_URI),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_rejected_when_callback_mode_mismatches_issued(monkeypatch):
    """코드가 https 모드로 발급됐는데 custom_scheme 모드(+그 모드의 정당한 URI)로 소비를
    시도하면 원자 UPDATE의 WHERE절에서 매치되는 행이 없어 거부돼야 한다 — 올바른 code+verifier를
    가진 공격자가 모드만 바꿔 다른 채널로 세션을 mint하는 시나리오의 직접 방어."""
    from app.routers.auth_firebase_internal import consume_oauth_handoff, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), 
                _issue_req(user_id, challenge, callback_mode="https"), authorization=None, db=s,
            )

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(_FakeRequest(), 
                    _consume_req(
                        issued.code, verifier,
                        callback_mode="custom_scheme", return_uri=_CUSTOM_SCHEME_RETURN_URI,
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_rejected_when_return_uri_mismatches_issued(monkeypatch):
    """같은 https 모드라도 issue 시점과 다른 return_uri(예: 다른 오리진)로 consume을 시도하면
    거부돼야 한다 — mode만이 아니라 exact URI도 독립적으로 대조축임을 증명."""
    from app.routers.auth_firebase_internal import consume_oauth_handoff, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), 
                _issue_req(user_id, challenge, callback_mode="https"), authorization=None, db=s,
            )

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(_FakeRequest(), 
                    _consume_req(
                        issued.code, verifier,
                        callback_mode="https", return_uri="https://evil.example.com/native/oauth-return",
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


# ─── story #3121 AC1 Phase 1 delta(PR #3538 PO 리뷰) — expand-contract 하위호환 ──────────

@pytest.mark.anyio
async def test_issue_and_consume_omitted_mode_fields_defaults_to_https_round_trip(monkeypatch):
    """민군 BFF 절반 착지 전 레거시 payload({user_id, code_challenge}만·{code, code_verifier}만)
    재현 — callback_mode/return_uri를 아예 안 보내도 서버가 https로 유도해 이슈+consume
    왕복이 여전히 성공해야 한다(머지 즉시 422 전멸 방지가 이 delta의 목적)."""
    from app.routers.auth_firebase_internal import (
        OAuthHandoffConsumeRequest, OAuthHandoffIssueRequest, consume_oauth_handoff, issue_oauth_handoff,
    )

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), 
                OAuthHandoffIssueRequest(user_id=str(user_id), code_challenge=challenge),
                authorization=None, db=s,
            )
        assert issued.code

        async with Session() as s:
            consumed = await consume_oauth_handoff(_FakeRequest(), 
                OAuthHandoffConsumeRequest(code=issued.code, code_verifier=verifier),
                authorization=None, db=s,
            )
        assert consumed.access_token
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_rejects_half_declared_mode_fields(monkeypatch):
    """callback_mode만 있고 return_uri가 없는(혹은 그 반대) 반쪽 선언은 레거시 유도 대상이
    아니다 — 오배선 신호로 보고 명시 거부한다(조용히 한쪽만 기본값으로 채우지 않음)."""
    from app.routers.auth_firebase_internal import OAuthHandoffIssueRequest, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(_FakeRequest(), 
                    OAuthHandoffIssueRequest(
                        user_id=str(user_id), code_challenge=challenge, callback_mode="https",
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 400
    finally:
        await engine.dispose()


# ─── story #3121 AC2 — custom_scheme 전용 rate limit ────────────────────────────────────

def _reset_rate_limiter(monkeypatch):
    """전역 싱글턴(`get_rate_limiter()`)이 프로세스 전체에서 재사용되므로, 테스트 간 카운터
    누적을 막기 위해 매 rate-limit 테스트 시작 시 강제로 새 인스턴스로 교체한다."""
    from app.services import rate_limiter as rate_limiter_module
    monkeypatch.setattr(rate_limiter_module, "_limiter", None)


@pytest.mark.anyio
async def test_issue_custom_scheme_rate_limited_after_limit(monkeypatch):
    """계약 §9 잔여위험(custom scheme = client impersonation 가능) — custom_scheme 발급은
    별도(공용 로그인 limiter와 무관) 버킷으로 제한돼야 한다."""
    from app.routers.auth_firebase_internal import (
        _OAUTH_HANDOFF_CUSTOM_SCHEME_ISSUE_LIMIT, issue_oauth_handoff,
    )

    _reset_rate_limiter(monkeypatch)
    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        for _ in range(_OAUTH_HANDOFF_CUSTOM_SCHEME_ISSUE_LIMIT):
            _verifier, challenge = _pkce_pair()
            async with Session() as s:
                issued = await issue_oauth_handoff(
                    _FakeRequest(),
                    _issue_req(user_id, challenge, callback_mode="custom_scheme", return_uri=_CUSTOM_SCHEME_RETURN_URI),
                    authorization=None, db=s,
                )
            assert issued.code

        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(
                    _FakeRequest(),
                    _issue_req(user_id, challenge, callback_mode="custom_scheme", return_uri=_CUSTOM_SCHEME_RETURN_URI),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 429
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_https_mode_unaffected_by_custom_scheme_rate_limit(monkeypatch):
    """«별도» 버킷임의 증거 — custom_scheme 한도를 초과하는 횟수만큼 https 발급을 반복해도
    막히지 않아야 한다(같은 IP·같은 유저라도 축이 다름)."""
    from app.routers.auth_firebase_internal import (
        _OAUTH_HANDOFF_CUSTOM_SCHEME_ISSUE_LIMIT, issue_oauth_handoff,
    )

    _reset_rate_limiter(monkeypatch)
    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        for _ in range(_OAUTH_HANDOFF_CUSTOM_SCHEME_ISSUE_LIMIT + 3):
            _verifier, challenge = _pkce_pair()
            async with Session() as s:
                issued = await issue_oauth_handoff(
                    _FakeRequest(), _issue_req(user_id, challenge, callback_mode="https"),
                    authorization=None, db=s,
                )
            assert issued.code
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_custom_scheme_rate_limited_after_limit(monkeypatch):
    """rate limit 검사가 code 유효성 검증보다 먼저 걸린다 — 매번 무효한 code라도(401) 한도
    소진 후엔 429로 바뀐다."""
    from app.routers.auth_firebase_internal import (
        _OAUTH_HANDOFF_CUSTOM_SCHEME_CONSUME_LIMIT, consume_oauth_handoff,
    )

    _reset_rate_limiter(monkeypatch)
    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        for _ in range(_OAUTH_HANDOFF_CUSTOM_SCHEME_CONSUME_LIMIT):
            async with Session() as s:
                with pytest.raises(HTTPException) as exc_info:
                    await consume_oauth_handoff(
                        _FakeRequest(),
                        _consume_req(
                            "bogus-code", "bogus-verifier",
                            callback_mode="custom_scheme", return_uri=_CUSTOM_SCHEME_RETURN_URI,
                        ),
                        authorization=None, db=s,
                    )
                assert exc_info.value.status_code == 401

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(
                    _FakeRequest(),
                    _consume_req(
                        "bogus-code", "bogus-verifier",
                        callback_mode="custom_scheme", return_uri=_CUSTOM_SCHEME_RETURN_URI,
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 429
    finally:
        await engine.dispose()


# ─── story #3121 AC3 — callback_mode별 start/consume 감사 기록 ──────────────────────────

async def _last_audit_row(session, event_type: str):
    from sqlalchemy import select
    from app.models.login_audit_log import LoginAuditLog

    result = await session.execute(
        select(LoginAuditLog).where(LoginAuditLog.event_type == event_type).order_by(LoginAuditLog.created_at.desc())
    )
    return result.scalars().first()


@pytest.mark.anyio
async def test_issue_success_writes_mode_tagged_audit_log(monkeypatch):
    from app.routers.auth_firebase_internal import issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            await issue_oauth_handoff(
                _FakeRequest(), _issue_req(user_id, challenge, callback_mode="custom_scheme", return_uri=_CUSTOM_SCHEME_RETURN_URI),
                authorization=None, db=s,
            )

        async with Session() as s:
            row = await _last_audit_row(s, "oauth_handoff_issued")
        assert row is not None
        assert row.user_id == user_id
        assert row.detail == "callback_mode=custom_scheme"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_success_writes_mode_tagged_audit_log(monkeypatch):
    from app.routers.auth_firebase_internal import consume_oauth_handoff, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)

        async with Session() as s:
            await consume_oauth_handoff(_FakeRequest(), _consume_req(issued.code, verifier), authorization=None, db=s)

        async with Session() as s:
            row = await _last_audit_row(s, "oauth_handoff_consumed")
        assert row is not None
        assert row.user_id == user_id
        assert row.detail == "callback_mode=https"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_failure_writes_mode_tagged_audit_log(monkeypatch):
    from app.routers.auth_firebase_internal import consume_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException):
                await consume_oauth_handoff(
                    _FakeRequest(), _consume_req("bogus-code", "bogus-verifier"), authorization=None, db=s,
                )

        async with Session() as s:
            row = await _last_audit_row(s, "oauth_handoff_consume_failed")
        assert row is not None
        assert row.user_id is None
        assert row.detail == "callback_mode=https"
    finally:
        await engine.dispose()


# ─── §10.6 음성 테스트 — schema-level 거부(extra="forbid") ─────────────────────

def test_consume_schema_rejects_unknown_fields():
    """§10.6 voice test 7: user ID 등 위조 필드는 조용히 무시되면 안 되고 스키마 자체가
    거부해야 한다."""
    from app.routers.auth_firebase_internal import OAuthHandoffConsumeRequest

    with pytest.raises(ValidationError):
        OAuthHandoffConsumeRequest(
            code="c", code_verifier="v", callback_mode="https", return_uri="x",
            existing_session_user_id="attacker-uid",
        )


def test_consume_schema_rejects_attestation_shaped_fields():
    """§10.6 voice test 1: Firebase/install assertion류 필드(installation_id/assertion_b64/
    signature_b64/challenge_id)를 이 스키마에 주입하면 거부돼야 한다 — attested 흐름과 섞일
    여지 자체를 스키마 레벨에서 차단."""
    from app.routers.auth_firebase_internal import OAuthHandoffConsumeRequest

    for bad_field in ("installation_id", "assertion_b64", "signature_b64", "challenge_id", "key_version"):
        with pytest.raises(ValidationError):
            OAuthHandoffConsumeRequest(
                code="c", code_verifier="v", callback_mode="https", return_uri="x", **{bad_field: "x"},
            )


def test_issue_schema_rejects_unknown_fields():
    from app.routers.auth_firebase_internal import OAuthHandoffIssueRequest

    with pytest.raises(ValidationError):
        OAuthHandoffIssueRequest(
            user_id=str(uuid.uuid4()), code_challenge="c" * 43,
            callback_mode="https", return_uri="x", installation_id="x",
        )


def test_issue_schema_rejects_unknown_callback_mode():
    """story #3121 AC1 — callback_mode는 Literal["https","custom_scheme"] 고정. 임의 문자열
    (예: 향후 오추가될 제3의 모드나 오타)은 schema 레벨에서 거부돼야 한다."""
    from app.routers.auth_firebase_internal import OAuthHandoffIssueRequest

    with pytest.raises(ValidationError):
        OAuthHandoffIssueRequest(
            user_id=str(uuid.uuid4()), code_challenge="c" * 43,
            callback_mode="ftp", return_uri="x",
        )


# ─── §10.6 voice test 2 — 물리적 테이블 분리(구 attested consume이 신규 코드 소비 불가) ──

@pytest.mark.anyio
async def test_oauth_handoff_code_not_consumable_via_attested_native_consume(monkeypatch):
    """§10.6 voice test 2: native-handoff 코드로 #14 attested consume을 태우면 거부돼야
    한다 — oauth_handoff_codes와 auth_native_bootstrap_codes는 물리적으로 다른 테이블이라
    거기서 조회 자체가 안 되고(0 rows), attested 스키마가 요구하는 installation_id/
    challenge_id도 애초에 없어 값 자체를 구성할 수 없다(구성 시도만으로도 무의미함을 실증)."""
    from app.routers.auth_firebase_internal import (
        NativeBootstrapConsumeRequest, consume_native_bootstrap, issue_oauth_handoff,
    )
    from app.core.config import settings

    _setup_common(monkeypatch)
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", True)  # attested consume 501-off 게이트 우회
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_eligible_user(s)

        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(_FakeRequest(), _issue_req(user_id, challenge), authorization=None, db=s)

        # oauth-handoff 코드에는 대응하는 installation/challenge가 애초에 존재하지 않는다 —
        # 임의(존재하지 않는) installation_id/challenge_id로 시도해도 attested 테이블에서
        # 코드 자체가 조회조차 안 된다(별도 테이블).
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(
                        code=issued.code, installation_id=str(uuid.uuid4()),
                        challenge_id=str(uuid.uuid4()), client_data_b64url="x", key_version=1,
                        assertion_b64="eA==",
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code in (401, 400)
    finally:
        await engine.dispose()
