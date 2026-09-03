"""story #3373(Phase1·마케팅운영) — 채널 연결 OAuth state(CSRF + org 바인딩 + PKCE verifier +
nonce + TTL). `app/services/github_app.py::sign_install_state`/`verify_install_state`(설치
callback state)를 그대로 미러 — 새 서명 패턴을 발명하지 않는다.

독립 시크릿(`channel_oauth_state_secret`) — auth.py의 로그인용 `create_oauth_state_token`
(별도 키)과도, github_app_state_secret과도 분리(그라운딩 doc §9 "기본=분리" 확定, 도메인마다
자기 키). HS256 self-signed JWT — state 자체는 브라우저 redirect를 왕복하는 값이라 서명은
"위조·변조 방지"이지 "비밀 은닉"이 아니다(PKCE verifier를 여기 실어도 access_token 자체가
아니므로 이 자리에서의 노출 허용 범위 — RFC 7636 취지: verifier가 유출돼도 그 자체로는
authorization code 없이 아무것도 못 한다).

PKCE(code_verifier/code_challenge)는 이 스토리에서 신규 구현이다 — 그라운딩 §2 확認: 기존
auth.py/security.py엔 PKCE 로직이 전혀 없었다(주석 인용뿐)."""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
import uuid

from jose import JWTError, jwt

from app.core.config import settings

_STATE_TTL_SECONDS = 600  # 10분 — github_app.py sign_install_state와 동일 TTL
_AUDIENCE = "channel-oauth"


class ChannelOAuthStateNotConfigured(RuntimeError):
    """channel_oauth_state_secret 미설정."""


def generate_pkce_pair() -> tuple[str, str]:
    """(code_verifier, code_challenge) — RFC 7636 S256. verifier=43~128자 URL-safe 랜덤,
    challenge=base64url(sha256(verifier))(패딩 제거)."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


def sign_channel_oauth_state(
    *, org_id: uuid.UUID, requester_member_id: uuid.UUID, channel: str, code_verifier: str,
    connection_id: uuid.UUID | None = None,
) -> str:
    """연결 시작(authorize) 시 발급 — org·상신자·채널·PKCE verifier를 서명해 콜백까지 들고
    간다. `connection_id`는 재인증(reauth, 기존 행 재연결) 흐름에서만 채워 콜백이 어느 행을
    갱신할지 명확히 한다(생략 시 신규 연결)."""
    if not settings.channel_oauth_state_secret:
        raise ChannelOAuthStateNotConfigured("channel_oauth_state_secret not set")
    now = int(time.time())
    claims = {
        "org_id": str(org_id),
        "requester_member_id": str(requester_member_id),
        "channel": channel,
        "code_verifier": code_verifier,
        "connection_id": str(connection_id) if connection_id else None,
        "jti": uuid.uuid4().hex,
        "iat": now,
        "exp": now + _STATE_TTL_SECONDS,
        "aud": _AUDIENCE,
    }
    return jwt.encode(claims, settings.channel_oauth_state_secret, algorithm="HS256")


class ChannelOAuthState:
    __slots__ = ("org_id", "requester_member_id", "channel", "code_verifier", "connection_id", "jti")

    def __init__(
        self, *, org_id: uuid.UUID, requester_member_id: uuid.UUID, channel: str, code_verifier: str,
        connection_id: uuid.UUID | None, jti: str,
    ) -> None:
        self.org_id = org_id
        self.requester_member_id = requester_member_id
        self.channel = channel
        self.code_verifier = code_verifier
        self.connection_id = connection_id
        self.jti = jti


def verify_channel_oauth_state(state: str, *, expected_channel: str) -> ChannelOAuthState | None:
    """서명불일치/만료/aud불일치/channel 불일치/형식오류 → None(위조·재사용 거부, 뮤테이션
    대상 — 이 함수를 no-op으로 만들면 위조 state가 그대로 통과한다). jti는 이 함수가 소비하지
    않는다(단발성 authorize→callback 왕복이 유일 경로라 별도 replay 저장소는 이 스토리
    범위 밖 — github_app.py의 jti 설계와 달리 콜백이 즉시 1회 소비되는 구조라 TTL만으로 충분,
    필요해지면 후속 스토리에서 추가)."""
    if not state or not settings.channel_oauth_state_secret:
        return None
    try:
        claims = jwt.decode(
            state, settings.channel_oauth_state_secret, algorithms=["HS256"], audience=_AUDIENCE,
        )
    except JWTError:
        return None
    if claims.get("channel") != expected_channel:
        return None
    try:
        org_id = uuid.UUID(claims["org_id"])
        requester_member_id = uuid.UUID(claims["requester_member_id"])
        code_verifier = claims["code_verifier"]
        connection_id = uuid.UUID(claims["connection_id"]) if claims.get("connection_id") else None
        jti = claims["jti"]
    except (KeyError, ValueError, TypeError):
        return None
    return ChannelOAuthState(
        org_id=org_id, requester_member_id=requester_member_id, channel=expected_channel,
        code_verifier=code_verifier, connection_id=connection_id, jti=jti,
    )
