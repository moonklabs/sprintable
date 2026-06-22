"""E-GHAPP Bot-S: GitHub App(봇) 토큰/state 보안 서비스 (산티아고 lock 보안모델).

- App private key: **Secret Manager only**(prod) / env fallback(dev·local). 프로세스 메모리 캐시·로그 노출 0.
- App JWT: RS256·`iss`=client ID·`iat`=now−60s·`exp`≤10분.
- Installation token: `POST /app/installations/{id}/access_tokens`(App JWT Bearer)·~1h·**DB 영속 0**·
  인메모리 캐시 + 만료 전 재mint.
- 설치 callback state: CSRF nonce + org 바인딩 + TTL(서명·replay/위조 거부).

⚠️ GitHub App API 시그니처(endpoint/claims)는 GitHub 공식 docs 기준(2026-06 PO 검증): iss=client ID·
exp≤10m·POST access_tokens·token 1h. impl 변동 시 현행 docs 재확인.
"""
from __future__ import annotations

import logging
import time
import uuid

import httpx
from jose import JWTError, jwt

from app.core.config import settings

logger = logging.getLogger(__name__)

_GITHUB_API = "https://api.github.com"
_APP_JWT_TTL = 540  # 9분(<10분 상한·clock drift 여유)
_TOKEN_REFRESH_SKEW = 300  # 만료 5분 전 재mint

# private key 프로세스 캐시(로그/덤프 노출 회피 위해 모듈 전역·재fetch 최소화).
_private_key_cache: str | None = None
# installation token 인메모리 캐시: installation_id → (token, expiry_epoch). **DB 영속 안 함**.
_token_cache: dict[int, tuple[str, float]] = {}


def _load_private_key() -> str | None:
    """App private key(PEM) 로드 — Secret Manager(prod) 우선, env(dev/local) fallback. 프로세스 캐시.

    로그에 키를 절대 찍지 않는다(존재/소스만).
    """
    global _private_key_cache
    if _private_key_cache:
        return _private_key_cache

    secret_name = settings.github_app_private_key_secret
    if secret_name:
        try:
            from google.cloud import secretmanager  # lazy — prod 경로에서만.

            client = secretmanager.SecretManagerServiceClient()
            resp = client.access_secret_version(name=secret_name)
            _private_key_cache = resp.payload.data.decode("utf-8")
            logger.info("github app private key loaded from Secret Manager")
            return _private_key_cache
        except Exception as exc:  # noqa: BLE001
            logger.error("Secret Manager private key fetch 실패: %s", exc)
            return None

    # env fallback 은 **dev/local 전용**. prod(app_env=production)는 Secret Manager strict — env 키 무시.
    if settings.github_app_private_key and settings.app_env != "production":
        _private_key_cache = settings.github_app_private_key
        logger.info("github app private key loaded from env (dev/local fallback)")
        return _private_key_cache
    if settings.github_app_private_key and settings.app_env == "production":
        logger.error("prod 에서 env private key 무시 — Secret Manager(github_app_private_key_secret) 필요")

    logger.warning("github app private key 미설정/미해소 — App 토큰 발급 불가(inert)")
    return None


def build_app_jwt() -> str | None:
    """App self-auth JWT(RS256·iss=client ID·exp≤10분). 키/클라이언트ID 없으면 None(inert)."""
    key = _load_private_key()
    if not key or not settings.github_app_client_id:
        return None
    now = int(time.time())
    claims = {"iss": settings.github_app_client_id, "iat": now - 60, "exp": now + _APP_JWT_TTL}
    try:
        return jwt.encode(claims, key, algorithm="RS256")
    except Exception as exc:  # noqa: BLE001
        logger.error("app JWT 서명 실패: %s", exc)
        return None


async def get_installation_token(installation_id: int) -> str | None:
    """installation access token(~1h) 발급/캐시. 만료 전이면 캐시 반환·아니면 재mint. **DB 영속 0**.

    토큰/실패는 로그에 값 안 찍음. App JWT/키 없으면 None(inert·CI 이벤트 경로 무관).
    """
    cached = _token_cache.get(installation_id)
    if cached and cached[1] - _TOKEN_REFRESH_SKEW > time.time():
        return cached[0]

    app_jwt = build_app_jwt()
    if not app_jwt:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{_GITHUB_API}/app/installations/{installation_id}/access_tokens",
                headers={
                    "Authorization": f"Bearer {app_jwt}",
                    "Accept": "application/vnd.github+json",
                },
            )
        if resp.status_code not in (200, 201):
            logger.warning("installation token mint HTTP %s (installation=%s)", resp.status_code, installation_id)
            return None
        data = resp.json()
        token = data.get("token")
        if not token:
            return None
        # expires_at ISO8601 → epoch. 파싱 실패 시 보수적 55분.
        expiry = time.time() + 55 * 60
        exp_str = data.get("expires_at")
        if exp_str:
            try:
                from datetime import datetime

                expiry = datetime.fromisoformat(exp_str.replace("Z", "+00:00")).timestamp()
            except (ValueError, TypeError):
                pass
        _token_cache[installation_id] = (token, expiry)
        return token
    except Exception as exc:  # noqa: BLE001
        logger.warning("installation token mint 실패(installation=%s): %s", installation_id, exc)
        return None


async def fetch_installation_metadata(installation_id: int) -> dict | None:
    """`GET /app/installations/{id}`(App JWT) — account login/type·repo selection. best-effort(None=graceful)."""
    app_jwt = build_app_jwt()
    if not app_jwt:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{_GITHUB_API}/app/installations/{installation_id}",
                headers={"Authorization": f"Bearer {app_jwt}", "Accept": "application/vnd.github+json"},
            )
        if resp.status_code != 200:
            return None
        d = resp.json()
        acct = d.get("account") or {}
        return {
            "account_login": acct.get("login"),
            "account_type": acct.get("type"),
            "repository_selection": d.get("repository_selection"),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("installation metadata fetch 실패(installation=%s): %s", installation_id, exc)
        return None


# ── 설치 callback state (CSRF + org binding + nonce + TTL) ────────────────────────

_STATE_TTL = 600  # 10분


def sign_install_state(org_id: uuid.UUID) -> str:
    """설치 시작 시 발급하는 state — org 바인딩 + nonce(jti·replay 방어) + TTL(exp). HS256 서명."""
    now = int(time.time())
    claims = {
        "org_id": str(org_id),
        "jti": uuid.uuid4().hex,  # nonce — replay 방어(callback 1회성 의미부여).
        "iat": now,
        "exp": now + _STATE_TTL,
        "aud": "github-app-install",
    }
    return jwt.encode(claims, settings.github_app_state_secret, algorithm="HS256")


def verify_install_state(state: str) -> tuple[uuid.UUID, str] | None:
    """callback state 검증 → (org_id, jti). 서명불일치/만료/aud불일치/jti없음/형식오류면 None(위조 거부).

    jti(nonce)는 호출자가 서버측 one-time consume(재사용 거부)에 사용한다 — TTL(exp)은 여기서 거름.
    """
    if not state or not settings.github_app_state_secret:
        return None
    try:
        claims = jwt.decode(
            state,
            settings.github_app_state_secret,
            algorithms=["HS256"],
            audience="github-app-install",
        )
    except JWTError:
        return None
    jti = claims.get("jti")
    if not jti:
        return None
    try:
        return uuid.UUID(claims.get("org_id")), str(jti)
    except (ValueError, TypeError):
        return None


async def verify_installation_owned(code: str, installation_id: int) -> bool:
    """anti-IDOR 핵심: install callback OAuth `code`(user-authorization-during-install) → user token →
    `GET /user/installations` 에 installation_id 포함 여부. = 콜백을 완료하는 user(org admin)가 그
    installation 을 **정당히 통제**함을 증명. 임의 installation_id 주입(IDOR) 차단. 실패/불일치 → False.
    """
    if not code or not settings.github_app_client_id or not settings.github_app_client_secret:
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            tok = await client.post(
                "https://github.com/login/oauth/access_token",
                headers={"Accept": "application/json"},
                data={
                    "client_id": settings.github_app_client_id,
                    "client_secret": settings.github_app_client_secret,
                    "code": code,
                },
            )
            if tok.status_code != 200:
                return False
            user_token = tok.json().get("access_token")
            if not user_token:
                return False
            insts = await client.get(
                f"{_GITHUB_API}/user/installations",
                headers={"Authorization": f"Bearer {user_token}", "Accept": "application/vnd.github+json"},
            )
            if insts.status_code != 200:
                return False
            ids = {i.get("id") for i in (insts.json().get("installations") or [])}
            return installation_id in ids
    except Exception as exc:  # noqa: BLE001
        logger.warning("installation ownership 검증 실패(installation=%s): %s", installation_id, exc)
        return False
