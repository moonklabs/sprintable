"""AUTH-09: OAuth state 검증 + 로그인 lockout 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.security import (
    JWTError,
    apple_client_secret_jwt,
    create_oauth_state_token,
    decode_oauth_state_token,
)


# ─── OAuth state token ────────────────────────────────────────────────────────

def test_oauth_state_roundtrip():
    token = create_oauth_state_token("google")
    decode_oauth_state_token(token, "google")  # 예외 없으면 PASS


def test_oauth_state_provider_mismatch_rejected():
    token = create_oauth_state_token("google")
    with pytest.raises(JWTError):
        decode_oauth_state_token(token, "github")


def test_oauth_state_wrong_type_rejected():
    from app.core.security import _get_secret
    from jose import jwt
    from datetime import datetime, timezone, timedelta
    payload = {"type": "access", "provider": "google", "exp": int((datetime.now(timezone.utc) + timedelta(minutes=10)).timestamp())}
    token = jwt.encode(payload, _get_secret(), algorithm="HS256")
    with pytest.raises(JWTError):
        decode_oauth_state_token(token, "google")


# ─── Sign in with Apple client_secret JWT (story #3118) ───────────────────────
# Apple client_secret은 Google처럼 고정 문자열이 아니라 매 요청 서명하는 ES256 JWT다
# (Team ID=iss·Services ID=sub·Key ID=kid). 여기서는 진짜 EC 키쌍을 생성해 서명→검증까지
# 왕복시켜, jose.jwt.encode(algorithm="ES256")가 Apple이 기대하는 정확한 클레임/헤더
# shape을 실제로 만드는지 확認한다(모킹으로 감추면 이 부분의 crypto 실수를 못 잡는다).

def test_apple_client_secret_jwt_roundtrip():
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization
    from jose import jwt as jose_jwt

    priv = ec.generate_private_key(ec.SECP256R1())
    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    pub_pem = priv.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    token = apple_client_secret_jwt(
        team_id="TEAM123", services_id="com.sprintable.web",
        key_id="KEY456", private_key_pem=priv_pem,
    )

    header = jose_jwt.get_unverified_header(token)
    assert header["alg"] == "ES256"
    assert header["kid"] == "KEY456"

    claims = jose_jwt.decode(token, pub_pem, algorithms=["ES256"], audience="https://appleid.apple.com")
    assert claims["iss"] == "TEAM123"
    assert claims["sub"] == "com.sprintable.web"
    assert claims["aud"] == "https://appleid.apple.com"
    assert claims["exp"] > claims["iat"]


def test_apple_client_secret_jwt_wrong_key_rejected():
    """다른 키로 서명 검증하면 거부된다(위조 방지 회귀가드)."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization
    from jose import jwt as jose_jwt
    from jose.exceptions import JWTError as JoseJWTError

    priv = ec.generate_private_key(ec.SECP256R1())
    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    other_pub_pem = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    token = apple_client_secret_jwt(
        team_id="TEAM123", services_id="com.sprintable.web",
        key_id="KEY456", private_key_pem=priv_pem,
    )
    with pytest.raises(JoseJWTError):
        jose_jwt.decode(token, other_pub_pem, algorithms=["ES256"], audience="https://appleid.apple.com")


# ─── Sign in with Apple id_token JWKS 검증 (story #3118) ──────────────────────
# Apple은 userinfo 엔드포인트가 없어 id_token(JWT) 클레임이 유일한 신원 출처다 — 실
# RSA 키쌍으로 Apple JWKS 형식을 시뮬레이션해 서명 검증(_verify_apple_id_token)이 진짜로
# 동작하는지, 그리고 위조 토큰(다른 키로 서명·kid 불일치)을 실제로 거부하는지 고정한다.

def _make_rsa_jwk_and_signer():
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
    import base64

    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    numbers = priv.public_key().public_numbers()

    def b64url_uint(n: int) -> str:
        b = n.to_bytes((n.bit_length() + 7) // 8, "big")
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

    jwk = {
        "kty": "RSA", "kid": "AIDOPK1", "use": "sig", "alg": "RS256",
        "n": b64url_uint(numbers.n), "e": b64url_uint(numbers.e),
    }
    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    return jwk, priv_pem


class _FakeJwksResp:
    def __init__(self, jwk: dict, status_code: int = 200):
        self._jwk = jwk
        self.status_code = status_code

    def json(self):
        return {"keys": [self._jwk]}


@pytest.mark.anyio
async def test_verify_apple_id_token_accepts_validly_signed_token():
    from jose import jwt as jose_jwt
    from app.routers.auth import _verify_apple_id_token

    jwk, priv_pem = _make_rsa_jwk_and_signer()
    id_token = jose_jwt.encode(
        {"iss": "https://appleid.apple.com", "aud": "com.sprintable.web", "sub": "apple-user-1", "email": "a@example.com"},
        priv_pem, algorithm="RS256", headers={"kid": "AIDOPK1"},
    )

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=_FakeJwksResp(jwk))

    claims = await _verify_apple_id_token(fake_client, id_token, expected_audience="com.sprintable.web")
    assert claims["sub"] == "apple-user-1"
    assert claims["email"] == "a@example.com"


@pytest.mark.anyio
async def test_verify_apple_id_token_rejects_token_signed_by_different_key():
    """위조 토큰(다른 개인키로 서명) — JWKS의 진짜 공개키로는 검증 실패해야 한다."""
    from jose import jwt as jose_jwt
    from app.routers.auth import _verify_apple_id_token

    jwk, _real_priv_pem = _make_rsa_jwk_and_signer()
    _forged_jwk, forged_priv_pem = _make_rsa_jwk_and_signer()
    # 위조 토큰의 kid는 "진짜" 키의 kid를 사칭 — 서명은 별개 개인키로.
    forged_token = jose_jwt.encode(
        {"iss": "https://appleid.apple.com", "aud": "com.sprintable.web", "sub": "attacker"},
        forged_priv_pem, algorithm="RS256", headers={"kid": jwk["kid"]},
    )

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=_FakeJwksResp(jwk))

    with pytest.raises(JWTError):
        await _verify_apple_id_token(fake_client, forged_token, expected_audience="com.sprintable.web")


@pytest.mark.anyio
async def test_verify_apple_id_token_rejects_unknown_kid():
    """JWKS에 없는 kid — 키를 못 찾으면 즉시 거부(무증빙 통과 금지)."""
    from jose import jwt as jose_jwt
    from app.routers.auth import _verify_apple_id_token

    jwk, priv_pem = _make_rsa_jwk_and_signer()
    id_token = jose_jwt.encode(
        {"iss": "https://appleid.apple.com", "aud": "com.sprintable.web", "sub": "u1"},
        priv_pem, algorithm="RS256", headers={"kid": "some-other-kid"},
    )

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=_FakeJwksResp(jwk))

    with pytest.raises(JWTError):
        await _verify_apple_id_token(fake_client, id_token, expected_audience="com.sprintable.web")


@pytest.mark.anyio
async def test_verify_apple_id_token_rejects_wrong_audience():
    """aud(client_id) 불일치 — 다른 앱 앞으로 발급된 토큰을 재사용 못 하게."""
    from jose import jwt as jose_jwt
    from app.routers.auth import _verify_apple_id_token

    jwk, priv_pem = _make_rsa_jwk_and_signer()
    id_token = jose_jwt.encode(
        {"iss": "https://appleid.apple.com", "aud": "com.some-other-app", "sub": "u1"},
        priv_pem, algorithm="RS256", headers={"kid": "AIDOPK1"},
    )

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=_FakeJwksResp(jwk))

    with pytest.raises(JWTError):
        await _verify_apple_id_token(fake_client, id_token, expected_audience="com.sprintable.web")


@pytest.mark.anyio
async def test_verify_apple_id_token_jwks_fetch_failure_rejected():
    """Apple JWKS 엔드포인트 장애(non-200) — 검증 불가면 통과가 아니라 거부."""
    from jose import jwt as jose_jwt
    from app.routers.auth import _verify_apple_id_token

    jwk, priv_pem = _make_rsa_jwk_and_signer()
    id_token = jose_jwt.encode(
        {"iss": "https://appleid.apple.com", "aud": "com.sprintable.web", "sub": "u1"},
        priv_pem, algorithm="RS256", headers={"kid": "AIDOPK1"},
    )

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=_FakeJwksResp(jwk, status_code=500))

    with pytest.raises(JWTError):
        await _verify_apple_id_token(fake_client, id_token, expected_audience="com.sprintable.web")


# ─── Login lockout ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_login_locked_account_429():
    """잠긴 계정 로그인 시도 → 429."""
    from app.main import app
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient
    from datetime import datetime, timezone, timedelta

    mock_user = MagicMock()
    mock_user.id = uuid.uuid4()
    mock_user.email = "locked@example.com"
    mock_user.hashed_password = "hash"
    mock_user.is_active = True
    mock_user.login_fail_count = 5
    mock_user.login_locked_until = datetime.now(timezone.utc) + timedelta(minutes=4)
    mock_user.totp_enabled = False

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = mock_user
    mock_session.execute = AsyncMock(return_value=mock_result)

    async def override_db():
        yield mock_session

    app.dependency_overrides[get_db] = override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/auth/token", json={
                "email": "locked@example.com",
                "password": "wrong",
            })
        assert resp.status_code == 429
        assert resp.json()["error"]["code"] == "ACCOUNT_LOCKED"
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def anyio_backend():
    return "asyncio"
