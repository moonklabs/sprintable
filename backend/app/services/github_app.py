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
from urllib.parse import quote

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


async def create_check_run(
    installation_id: int,
    repo_full_name: str,
    head_sha: str,
    *,
    name: str = "sprintable/gate",
    status: str = "in_progress",
    conclusion: str | None = None,
    title: str | None = None,
    summary: str | None = None,
) -> dict | None:
    """story #2813 — `POST /repos/{repo}/check-runs`(installation token). 실패/토큰없음=None
    (fail-closed 상위 호출자 책임 — 이 함수는 예외를 삼키지 않는다, 호출자가 try/except로
    "실패해도 GitHub 쪽 상태는 안 바뀐다"를 보장). `status='completed'`일 때만 `conclusion` 필수
    (GitHub API 제약 — queued/in_progress엔 conclusion 없음)."""
    token = await get_installation_token(installation_id)
    if not token:
        return None
    body: dict = {"name": name, "head_sha": head_sha, "status": status}
    if status == "completed" and conclusion:
        body["conclusion"] = conclusion
    if title or summary:
        body["output"] = {"title": title or name, "summary": summary or ""}
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{_GITHUB_API}/repos/{repo_full_name}/check-runs",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
            json=body,
        )
    if resp.status_code not in (200, 201):
        logger.warning(
            "check-run create 실패 HTTP %s (repo=%s sha=%s)", resp.status_code, repo_full_name, head_sha
        )
        return None
    return resp.json()


async def update_check_run(
    installation_id: int,
    repo_full_name: str,
    check_run_id: int,
    *,
    status: str | None = None,
    conclusion: str | None = None,
    title: str | None = None,
    summary: str | None = None,
) -> dict | None:
    """story #2813 — `PATCH /repos/{repo}/check-runs/{id}`. create_check_run과 동일 계약(예외
    미삼킴·실패=None)."""
    token = await get_installation_token(installation_id)
    if not token:
        return None
    body: dict = {}
    if status:
        body["status"] = status
    if status == "completed" and conclusion:
        body["conclusion"] = conclusion
    if title or summary:
        body["output"] = {"title": title or "sprintable/gate", "summary": summary or ""}
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            f"{_GITHUB_API}/repos/{repo_full_name}/check-runs/{check_run_id}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
            json=body,
        )
    if resp.status_code != 200:
        logger.warning(
            "check-run update 실패 HTTP %s (repo=%s check_run_id=%s)",
            resp.status_code, repo_full_name, check_run_id,
        )
        return None
    return resp.json()


async def list_check_runs_for_ref(
    installation_id: int, repo_full_name: str, ref: str, *, name: str = "sprintable/gate",
) -> list[dict] | None:
    """story #2908 — `GET /repos/{repo}/commits/{ref}/check-runs?check_name=...`. `publish_gate_check`가
    새 check-run을 만들기 전에 그 SHA에 이미 이 이름의 check-run이 있는지 GitHub 쪽 실 상태를
    직접 물어본다 — `gate.github_check_run_id`는 그 Gate 행 하나의 캐시일 뿐이라, 서로 다른 Gate
    행(다른 PR 번호)이 같은 SHA에 바인딩되는 경우(스택 PR을 통합 PR로 재타겟하는 워크플로 등)
    캐시만 보면 "나는 모른다"고 오판해 같은 SHA에 동명 check-run을 중복 생성한다(실사고 그라운딩
    doc `2908-stacked-pr-gate-checkrun-orphan-design`). 실패/토큰없음=None(create_check_run/
    update_check_run과 동일 계약 — fail-closed 상위 호출자 책임). 조회 성공+매치 0건은 빈 리스트
    (None과 구분 — "몰라서 못 찾음"과 "찾아봤는데 없음"은 다른 신호)."""
    token = await get_installation_token(installation_id)
    if not token:
        return None
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{_GITHUB_API}/repos/{repo_full_name}/commits/{ref}/check-runs",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
            params={"check_name": name},
        )
    if resp.status_code != 200:
        logger.warning(
            "check-run 조회 실패 HTTP %s (repo=%s ref=%s)", resp.status_code, repo_full_name, ref
        )
        return None
    return resp.json().get("check_runs", [])


async def get_pull_request(installation_id: int, repo_full_name: str, pr_number: int) -> dict | None:
    """story #2893(설계안 §3 B3) — `GET /repos/{repo}/pulls/{pr}`. `POST /gates/{id}/reevaluate`
    (웹훅 페이로드 없이 사용자가 직접 재평가를 트리거)가 지금 이 PR의 **실 head SHA/merged**
    상태를 읽어오는 데 쓴다 — reopen처럼 GitHub 쪽 리뷰/체크 상태를 건드리지 않고(순수 GET),
    우리 쪽 게이트 판정만 최신 증거로 재실행한다. create_check_run과 동일 계약: 예외 미삼킴,
    실패/토큰없음=None."""
    token = await get_installation_token(installation_id)
    if not token:
        return None
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{_GITHUB_API}/repos/{repo_full_name}/pulls/{pr_number}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
        )
    if resp.status_code != 200:
        logger.warning(
            "PR 조회 실패 HTTP %s (repo=%s pr=%s)", resp.status_code, repo_full_name, pr_number,
        )
        return None
    return resp.json()


async def remove_pr_label(installation_id: int, repo_full_name: str, pr_number: int, label: str) -> bool:
    """story #2893(설계안 §3 B2-a) — `DELETE /repos/{repo}/issues/{pr}/labels/{name}`(PR도 issue
    라벨 엔드포인트 공유, GitHub 공식). SHA 재-pending 시 qa:pass/design:pass를 강제로 뗀다
    (「라벨=검증된 SHA에 대한 약속」 시맨틱 — 새 커밋이 오면 그 약속은 깨진 것).

    404(그 라벨이 애초에 PR에 없음)는 목표 상태(라벨 없음)와 동일하므로 성공 취급(idempotent —
    "있으면 떼고 없으면 그대로"). 그 외 실패만 경고 로그+False. create_check_run과 동일 계약:
    예외 미삼킴(호출자가 fail-closed try/except 담당)."""
    token = await get_installation_token(installation_id)
    if not token:
        return False
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.delete(
            f"{_GITHUB_API}/repos/{repo_full_name}/issues/{pr_number}/labels/{quote(label, safe='')}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
        )
    if resp.status_code not in (200, 404):
        logger.warning(
            "label 제거 실패 HTTP %s (repo=%s pr=%s label=%s)",
            resp.status_code, repo_full_name, pr_number, label,
        )
        return False
    return True


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
