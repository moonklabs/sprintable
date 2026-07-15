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

import logging

import google.auth
import google.auth.transport.requests
import httpx

logger = logging.getLogger(__name__)

_IDENTITY_TOOLKIT_SCOPE = "https://www.googleapis.com/auth/identitytoolkit"
_CREATE_SESSION_COOKIE_URL_TEMPLATE = (
    "https://identitytoolkit.googleapis.com/v1/projects/{project_id}:createSessionCookie"
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
