"""story 455e528d(E-AUTH-REBUILD M2 Phase1-S2·doc firebase-auth-identity-platform-migration-poc
§4.2): Firebase 세션쿠키 정확 검증 — python-jose 재사용(신규 의존성 0, FE의 jose와 동형 설계).

Firebase 세션쿠키 공개키는 JWKS 표준이 아닌 kid→X.509 PEM 맵이라(FE firebase-session.ts와
동일 이유) cryptography로 인증서를 직접 파싱해 공개키를 뽑는다.

⛔순차 fallback 금지 — alg/iss/aud/kid 전부 정확 매칭만 통과. 실패 시 None(호출부가 legacy로
다운그레이드하면 안 됨, doc §4.1).
"""
from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
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
# ID token(issuer=securetoken.google.com) 검증용 공개키 — 세션쿠키와 별개 엔드포인트/키셋
# (story 132e7204·doc §4.2/§9.1: ID token을 세션쿠키 키로 검증하거나 그 반대는 issuer confusion).
FIREBASE_ID_TOKEN_PUBLIC_KEYS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
_DEFAULT_KEY_CACHE_SECONDS = 60 * 60  # 1시간(Cache-Control 헤더 없을 때 폴백)
_MAX_KEY_CACHE_SECONDS = 24 * 60 * 60

_key_cache: dict[str, str] = {}
_key_cache_expires_at: float = 0.0

_id_token_key_cache: dict[str, str] = {}
_id_token_key_cache_expires_at: float = 0.0


def _reset_key_cache_for_tests() -> None:
    """테스트 전용 — 모듈 레벨 키 캐시가 테스트 간 상태를 누출하지 않도록 초기화."""
    global _key_cache, _key_cache_expires_at
    _key_cache = {}
    _key_cache_expires_at = 0.0


def _reset_id_token_key_cache_for_tests() -> None:
    """테스트 전용 — ID token 검증용 키 캐시(세션쿠키 캐시와 별도) 초기화."""
    global _id_token_key_cache, _id_token_key_cache_expires_at
    _id_token_key_cache = {}
    _id_token_key_cache_expires_at = 0.0


async def _fetch_keys_from(url: str, cache: dict[str, str], expires_at: float) -> tuple[dict[str, str], float]:
    now = time.time()
    if cache and expires_at > now:
        return cache, expires_at

    async with httpx.AsyncClient() as client:
        res = await client.get(url)
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

    return keys, now + max_age


async def _fetch_public_keys() -> dict[str, str]:
    global _key_cache, _key_cache_expires_at
    _key_cache, _key_cache_expires_at = await _fetch_keys_from(
        FIREBASE_SESSION_PUBLIC_KEYS_URL, _key_cache, _key_cache_expires_at
    )
    return _key_cache


async def _fetch_id_token_public_keys() -> dict[str, str]:
    global _id_token_key_cache, _id_token_key_cache_expires_at
    _id_token_key_cache, _id_token_key_cache_expires_at = await _fetch_keys_from(
        FIREBASE_ID_TOKEN_PUBLIC_KEYS_URL, _id_token_key_cache, _id_token_key_cache_expires_at
    )
    return _id_token_key_cache


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


@dataclass
class VerifiedFirebaseIdToken:
    issuer: str
    firebase_uid: str
    email: str | None
    auth_time: int


async def _verify_exact(
    token: str,
    *,
    expected_issuer: str,
    project_id: str,
    fetch_keys: Callable[[], Awaitable[dict[str, str]]],
) -> dict | None:
    """§4.2 공통 정확검증 골격 — alg=RS256·kid∈공개키셋·iss 정확매칭·aud=projectId·
    sub 비어있지 않음·auth_time 유효. 세션쿠키/ID token 둘 다 이 골격을 쓰되 issuer와
    공개키 소스만 다르다(혼동 시 issuer confusion — doc §4.2/§9.1 명시 위험)."""
    try:
        header = jose_jwt.get_unverified_header(token)
    except JWTError:
        return None

    kid = header.get("kid")
    if not kid:
        return None

    try:
        keys = await fetch_keys()
    except RuntimeError:
        return None

    pem_cert = keys.get(kid)
    if pem_cert is None:
        return None

    try:
        jwk = _rsa_public_key_to_jwk(pem_cert, kid)
    except ValueError:
        return None

    try:
        payload = jose_jwt.decode(
            token,
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

    return payload


async def verify_firebase_session(session_cookie: str, project_id: str) -> VerifiedFirebaseSession | None:
    """doc §4.2 정확 검증: alg=RS256·kid∈Google 공개키셋·iss=정확히 session issuer·
    aud=정확히 projectId·sub 비어있지 않음·auth_time/iat/exp 유효. 순차 fallback 없음."""
    payload = await _verify_exact(
        session_cookie,
        expected_issuer=f"https://session.firebase.google.com/{project_id}",
        project_id=project_id,
        fetch_keys=_fetch_public_keys,
    )
    if payload is None:
        return None
    return VerifiedFirebaseSession(
        issuer=str(payload.get("iss")),
        firebase_uid=str(payload.get("sub")),
        email=payload.get("email"),
        auth_time=payload.get("auth_time"),
    )


async def verify_firebase_id_token(id_token: str, project_id: str) -> VerifiedFirebaseIdToken | None:
    """story 132e7204(doc §4.2 issuer 표·§9.1 native-bootstrap 선행): Firebase ID token
    정확 검증. issuer=`securetoken.google.com`(세션 issuer `session.firebase.google.com`과
    반드시 구분 — 이걸 헷갈리면 세션쿠키 자리에 ID token이 수락되는 issuer confusion).
    별도 공개키 엔드포인트(`FIREBASE_ID_TOKEN_PUBLIC_KEYS_URL`) 사용 — 세션쿠키 키셋과 다름.
    ⚠️`auth_time` 최근성(doc §4.4 "now - auth_time <= 5분") 검사는 호출부(발급 엔드포인트)
    책임 — 이 함수는 다른 검증기들과 동일하게 alg/iss/aud/kid/서명만 정확 검증한다."""
    payload = await _verify_exact(
        id_token,
        expected_issuer=f"https://securetoken.google.com/{project_id}",
        project_id=project_id,
        fetch_keys=_fetch_id_token_public_keys,
    )
    if payload is None:
        return None
    return VerifiedFirebaseIdToken(
        issuer=str(payload.get("iss")),
        firebase_uid=str(payload.get("sub")),
        email=payload.get("email"),
        auth_time=payload.get("auth_time"),
    )


# story 4dee942b(Phase1-S5·산티아고 §9): App Check 토큰 검증 — device binding의 "App Check
# 앱 무결성 증명" 부분만 커버한다. ⚠️App Check 토큰 자체엔 설치별(per-installation) 고유
# challenge가 없다(sub=Firebase App ID, 앱 전체에 공통 — 특정 기기 인스턴스를 구분 못 함).
# 산티아고가 요구한 "설치별 key/challenge" 수준의 완전한 device binding은 모바일 클라이언트가
# 별도 challenge-response 메커니즘을 구현해야 하는 별개 스코프(모바일 스토리 필요) — 이
# 함수는 그 전제조건인 "요청이 진짜 앱에서 왔다"만 정확 검증한다(App Check 표준 용도).
FIREBASE_APP_CHECK_JWKS_URL = "https://firebaseappcheck.googleapis.com/v1/jwks"

_app_check_key_cache: dict[str, dict] = {}
_app_check_key_cache_expires_at: float = 0.0


def _reset_app_check_key_cache_for_tests() -> None:
    global _app_check_key_cache, _app_check_key_cache_expires_at
    _app_check_key_cache = {}
    _app_check_key_cache_expires_at = 0.0


async def _fetch_app_check_jwks() -> dict[str, dict]:
    """표준 JWKS 포맷(kid→JWK dict) — 세션쿠키/ID token의 kid→X.509 PEM 포맷과 다르다.
    PEM 파싱 불요, jose가 JWK dict를 직접 받는다."""
    global _app_check_key_cache, _app_check_key_cache_expires_at
    now = time.time()
    if _app_check_key_cache and _app_check_key_cache_expires_at > now:
        return _app_check_key_cache

    async with httpx.AsyncClient() as client:
        res = await client.get(FIREBASE_APP_CHECK_JWKS_URL)
    if res.status_code != 200:
        raise RuntimeError("app_check_jwks_fetch_failed")
    body = res.json()
    keys_by_kid = {jwk["kid"]: jwk for jwk in body.get("keys", []) if "kid" in jwk}

    cache_control = res.headers.get("cache-control", "")
    max_age = _DEFAULT_KEY_CACHE_SECONDS
    for part in cache_control.split(","):
        part = part.strip()
        if part.startswith("max-age="):
            try:
                max_age = min(int(part.split("=", 1)[1]), _MAX_KEY_CACHE_SECONDS)
            except ValueError:
                pass

    _app_check_key_cache = keys_by_kid
    _app_check_key_cache_expires_at = now + max_age
    return keys_by_kid


@dataclass
class VerifiedAppCheck:
    issuer: str
    app_id: str  # App Check 토큰의 sub — Firebase App ID(설치별 고유값 아님, 위 경고 참조)


async def verify_app_check_token(token: str, project_number: str) -> VerifiedAppCheck | None:
    """App Check 토큰 정확 검증(doc §9.3 "App Check is defense-in-depth"). issuer=
    `https://firebaseappcheck.googleapis.com/<project_number>` — ⚠️여기의 project_number는
    다른 검증기들이 쓰는 project_id와 다른 값(Firebase 프로젝트 번호, 문자열 ID 아님)."""
    try:
        header = jose_jwt.get_unverified_header(token)
    except JWTError:
        return None

    kid = header.get("kid")
    if not kid:
        return None

    try:
        keys = await _fetch_app_check_jwks()
    except RuntimeError:
        return None

    jwk = keys.get(kid)
    if jwk is None:
        return None

    expected_issuer = f"https://firebaseappcheck.googleapis.com/{project_number}"
    try:
        payload = jose_jwt.decode(
            token,
            jwk,
            algorithms=["RS256"],
            issuer=expected_issuer,
            options={"verify_aud": False},  # aud=projects/<num>/apps/<app_id> 배열 — 호출부가 app_id 매칭.
        )
    except JWTError:
        return None

    sub = payload.get("sub")
    if not sub:
        return None

    return VerifiedAppCheck(issuer=str(payload.get("iss")), app_id=str(sub))
