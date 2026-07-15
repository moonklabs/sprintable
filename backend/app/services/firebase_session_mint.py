"""story 132e7204(E-AUTH-REBUILD M2 Phase1-S4·doc §4.4/§9.1): 이미 정확검증된 Firebase ID
token을 실제 Firebase 세션쿠키로 교환(Google Identity Toolkit `createSessionCookie`).

⚠️여기 도달하기 전에 `firebase_verifier.verify_firebase_id_token()`으로 이미 정확검증(alg/
iss/aud/kid)됐어야 한다 — 이 모듈은 검증된 id_token을 그대로 Google에 전달만 하고 자체
재검증은 안 한다(Google 측이 최종 권위 검증).

⛔id_token/세션쿠키 값은 로그에 절대 남기지 않는다(doc §6.4 acceptance test 9).

non-prod Firebase 프로젝트 준비 전까지는 `_get_access_token`/`_call_create_session_cookie`를
모킹해 mint_session_cookie()의 구조(호출 순서·실패 처리·응답 파싱)만 계약테스트로 검증한다
(오르테가군 승인 2026-07-15 — S2와 동일 mock-first 패턴). 실 Google 왕복은 PO 인프라 lane의
non-prod 프로젝트 프로비저닝 완료 후 별도로 붙인다.
"""
from __future__ import annotations

import base64
import json
import logging
import time

import google.auth
import google.auth.transport.requests
import httpx

logger = logging.getLogger(__name__)

_IDENTITY_TOOLKIT_SCOPE = "https://www.googleapis.com/auth/identitytoolkit"
_CREATE_SESSION_COOKIE_URL_TEMPLATE = (
    "https://identitytoolkit.googleapis.com/v1/projects/{project_id}:createSessionCookie"
)
_SIGN_IN_WITH_CUSTOM_TOKEN_URL_TEMPLATE = (
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={api_key}"
)
_CUSTOM_TOKEN_AUDIENCE = (
    "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit"
)


def _get_access_token() -> str:
    """ADC(Application Default Credentials)로 Identity Toolkit 스코프 액세스 토큰 획득.
    테스트에서 모킹하는 지점 — 실 GCP 자격증명 없이 mint_session_cookie() 구조를 검증한다."""
    credentials, _project = google.auth.default(scopes=[_IDENTITY_TOOLKIT_SCOPE])
    request = google.auth.transport.requests.Request()
    credentials.refresh(request)
    return credentials.token


async def _call_create_session_cookie(
    access_token: str, id_token: str, project_id: str, valid_duration_seconds: int
) -> httpx.Response:
    """실 Google REST 호출 지점 — 테스트에서 모킹해 mint_session_cookie()의 성공/실패 분기를
    검증한다. id_token은 요청 바디에만 실려 전송되고 어디에도 로그되지 않는다."""
    url = _CREATE_SESSION_COOKIE_URL_TEMPLATE.format(project_id=project_id)
    async with httpx.AsyncClient() as client:
        return await client.post(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
            json={"idToken": id_token, "validDuration": str(valid_duration_seconds)},
        )


async def mint_session_cookie(
    id_token: str, project_id: str, valid_duration_seconds: int = 5 * 24 * 60 * 60
) -> str | None:
    """이미 검증된 Firebase ID token → 실 세션쿠키 값. 실패 시 None(호출부가 절대 쿠키를
    발급/반환하면 안 됨 — doc §4.4 6단계). 기본 TTL=5일(doc §1.1 POC 기본값, 최대 14일)."""
    try:
        access_token = _get_access_token()
    except Exception:
        logger.warning("auth.firebase.session_mint failed reason=adc_token_unavailable")
        return None

    try:
        response = await _call_create_session_cookie(
            access_token, id_token, project_id, valid_duration_seconds
        )
    except httpx.HTTPError:
        logger.warning("auth.firebase.session_mint failed reason=network_error")
        return None

    if response.status_code != 200:
        logger.warning(
            "auth.firebase.session_mint failed reason=google_rejected status=%d", response.status_code
        )
        return None

    session_cookie = response.json().get("sessionCookie")
    if not session_cookie or not isinstance(session_cookie, str):
        logger.warning("auth.firebase.session_mint failed reason=malformed_response")
        return None

    logger.info("auth.firebase.session_mint success")
    return session_cookie


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _get_signing_credentials():
    """ADC가 service-account 자격증명일 때만 `.sign_bytes()`/`.service_account_email`을
    노출한다 — user 자격증명(로컬 `gcloud auth application-default login`)이면 서명 불가.
    테스트 모킹 지점(mint_custom_token 구조 검증용)."""
    credentials, _project = google.auth.default(scopes=[_IDENTITY_TOOLKIT_SCOPE])
    return credentials


def mint_custom_token(firebase_uid: str) -> str | None:
    """story 4dee942b(Phase1-S5·doc §9.1): 네이티브 부트스트랩 코드 소비 시점엔 원본 Firebase
    ID token이 더 이상 없다(발급 순간 이후로 저장/전달하지 않음 — 저장 시 사실상 라이브
    세션 자격증명을 DB에 두는 것과 같은 리스크). 대신 firebase_uid만으로 custom token을
    로컬 서명(네트워크 호출 없음, service-account 개인키로 직접 JWT 서명 — Firebase 공식
    custom token 포맷)해 `exchange_custom_token_for_id_token()`으로 넘긴다.

    ⛔custom token/id_token/세션쿠키 값은 로그에 절대 남기지 않는다."""
    try:
        credentials = _get_signing_credentials()
    except Exception:
        logger.warning("auth.firebase.custom_token failed reason=adc_unavailable")
        return None

    if not hasattr(credentials, "sign_bytes") or not hasattr(credentials, "service_account_email"):
        logger.warning("auth.firebase.custom_token failed reason=non_service_account_adc")
        return None

    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    payload = {
        "iss": credentials.service_account_email,
        "sub": credentials.service_account_email,
        "aud": _CUSTOM_TOKEN_AUDIENCE,
        "uid": firebase_uid,
        "iat": now,
        "exp": now + 3600,
    }
    signing_input = f"{_b64url(json.dumps(header).encode())}.{_b64url(json.dumps(payload).encode())}"
    try:
        signature = credentials.sign_bytes(signing_input.encode())
    except Exception:
        logger.warning("auth.firebase.custom_token failed reason=sign_failed")
        return None

    logger.info("auth.firebase.custom_token success")
    return f"{signing_input}.{_b64url(signature)}"


async def _call_sign_in_with_custom_token(custom_token: str, web_api_key: str) -> httpx.Response:
    """실 Google REST 호출 지점 — 테스트에서 모킹."""
    url = _SIGN_IN_WITH_CUSTOM_TOKEN_URL_TEMPLATE.format(api_key=web_api_key)
    async with httpx.AsyncClient() as client:
        return await client.post(url, json={"token": custom_token, "returnSecureToken": True})


async def exchange_custom_token_for_id_token(custom_token: str, web_api_key: str) -> str | None:
    """custom token → 실 ID token(signInWithCustomToken). 실패 시 None."""
    if not web_api_key:
        logger.warning("auth.firebase.custom_token_exchange failed reason=no_web_api_key")
        return None
    try:
        response = await _call_sign_in_with_custom_token(custom_token, web_api_key)
    except httpx.HTTPError:
        logger.warning("auth.firebase.custom_token_exchange failed reason=network_error")
        return None

    if response.status_code != 200:
        logger.warning(
            "auth.firebase.custom_token_exchange failed reason=google_rejected status=%d",
            response.status_code,
        )
        return None

    id_token = response.json().get("idToken")
    if not id_token or not isinstance(id_token, str):
        logger.warning("auth.firebase.custom_token_exchange failed reason=malformed_response")
        return None

    logger.info("auth.firebase.custom_token_exchange success")
    return id_token


async def mint_session_cookie_for_uid(
    firebase_uid: str, project_id: str, web_api_key: str, valid_duration_seconds: int = 5 * 24 * 60 * 60
) -> str | None:
    """story 4dee942b: firebase_uid만으로 세션쿠키 발급(네이티브 부트스트랩 소비 시점 전용
    경로) — custom token 발급→ID token 교환→기존 mint_session_cookie() 그대로 재사용
    (S4 발급 로직 재사용, 오르테가군 판정 2026-07-15). 체인 중 어느 단계든 실패하면 None."""
    custom_token = mint_custom_token(firebase_uid)
    if custom_token is None:
        return None
    id_token = await exchange_custom_token_for_id_token(custom_token, web_api_key)
    if id_token is None:
        return None
    return await mint_session_cookie(id_token, project_id, valid_duration_seconds)
