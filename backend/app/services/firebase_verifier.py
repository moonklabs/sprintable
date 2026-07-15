"""story 455e528d(E-AUTH-REBUILD M2 Phase1-S2·doc firebase-auth-identity-platform-migration-poc
§4.2): Firebase 세션쿠키 정확 검증 — python-jose 재사용(신규 의존성 0, FE의 jose와 동형 설계).

Firebase 세션쿠키 공개키는 JWKS 표준이 아닌 kid→X.509 PEM 맵이라(FE firebase-session.ts와
동일 이유) cryptography로 인증서를 직접 파싱해 공개키를 뽑는다.

⛔순차 fallback 금지 — alg/iss/aud/kid 전부 정확 매칭만 통과. 실패 시 None(호출부가 legacy로
다운그레이드하면 안 됨, doc §4.1).
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import httpx
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from cryptography.x509 import load_pem_x509_certificate
from jose import jwt as jose_jwt
from jose.exceptions import JWTError
from jose.utils import long_to_base64

# Firebase 공식 문서(doc §14): 세션쿠키 검증용 공개키 — ID token용 URL과 다르다(혼동 시 issuer
# confusion — doc §4.2 명시 위험).
FIREBASE_SESSION_PUBLIC_KEYS_URL = "https://www.googleapis.com/identitytoolkit/v3/relyingparty/publicKeys"
_DEFAULT_KEY_CACHE_SECONDS = 60 * 60  # 1시간(Cache-Control 헤더 없을 때 폴백)
_MAX_KEY_CACHE_SECONDS = 24 * 60 * 60

_key_cache: dict[str, str] = {}
_key_cache_expires_at: float = 0.0


def _reset_key_cache_for_tests() -> None:
    """테스트 전용 — 모듈 레벨 키 캐시가 테스트 간 상태를 누출하지 않도록 초기화."""
    global _key_cache, _key_cache_expires_at
    _key_cache = {}
    _key_cache_expires_at = 0.0


async def _fetch_public_keys() -> dict[str, str]:
    global _key_cache, _key_cache_expires_at
    now = time.time()
    if _key_cache and _key_cache_expires_at > now:
        return _key_cache

    async with httpx.AsyncClient() as client:
        res = await client.get(FIREBASE_SESSION_PUBLIC_KEYS_URL)
    if res.status_code != 200:
        raise RuntimeError("firebase_public_keys_fetch_failed")
    keys: dict[str, str] = res.json()

    cache_control = res.headers.get("cache-control", "")
    max_age = _DEFAULT_KEY_CACHE_SECONDS
    for part in cache_control.split(","):
        part = part.strip()
        if part.startswith("max-age="):
            try:
                max_age = min(int(part.split("=", 1)[1]), _MAX_KEY_CACHE_SECONDS)
            except ValueError:
                pass

    _key_cache = keys
    _key_cache_expires_at = now + max_age
    return keys


def _rsa_public_key_to_jwk(pem_cert: str, kid: str) -> dict:
    """X.509 CERTIFICATE PEM → RSA 공개키 → python-jose가 받는 JWK dict로 변환."""
    cert = load_pem_x509_certificate(pem_cert.encode())
    public_key = cert.public_key()
    if not isinstance(public_key, RSAPublicKey):
        raise ValueError("non_rsa_key")
    numbers = public_key.public_numbers()
    return {
        "kty": "RSA",
        "kid": kid,
        "use": "sig",
        "alg": "RS256",
        "n": long_to_base64(numbers.n).decode(),
        "e": long_to_base64(numbers.e).decode(),
    }


def looks_like_rs256(token: str) -> bool:
    """서명 검증 前 헤더만 peek — get_current_user가 legacy(HS256) vs Firebase(RS256)를
    정확 alg 기준으로 분기하기 위한 저비용 판정(순차 fallback 아님, doc §4.2)."""
    try:
        header = jose_jwt.get_unverified_header(token)
    except JWTError:
        return False
    return header.get("alg") == "RS256"


@dataclass
class VerifiedFirebaseSession:
    issuer: str
    firebase_uid: str
    email: str | None
    auth_time: int


async def verify_firebase_session(session_cookie: str, project_id: str) -> VerifiedFirebaseSession | None:
    """doc §4.2 정확 검증: alg=RS256·kid∈Google 공개키셋·iss=정확히 session issuer·
    aud=정확히 projectId·sub 비어있지 않음·auth_time/iat/exp 유효. 순차 fallback 없음."""
    try:
        header = jose_jwt.get_unverified_header(session_cookie)
    except JWTError:
        return None

    kid = header.get("kid")
    if not kid:
        return None

    try:
        keys = await _fetch_public_keys()
    except RuntimeError:
        return None

    pem_cert = keys.get(kid)
    if pem_cert is None:
        return None

    try:
        jwk = _rsa_public_key_to_jwk(pem_cert, kid)
    except ValueError:
        return None

    expected_issuer = f"https://session.firebase.google.com/{project_id}"
    try:
        payload = jose_jwt.decode(
            session_cookie,
            jwk,
            algorithms=["RS256"],
            audience=project_id,
            issuer=expected_issuer,
        )
    except JWTError:
        return None

    sub = payload.get("sub")
    if not sub:
        return None
    auth_time = payload.get("auth_time")
    if not isinstance(auth_time, int):
        return None

    return VerifiedFirebaseSession(
        issuer=str(payload.get("iss")),
        firebase_uid=sub,
        email=payload.get("email"),
        auth_time=auth_time,
    )
