"""E-GHAPP Bot-S: GitHub App(봇) per-org 설치 — install start / callback / status.

설치 flow: org admin이 FE "Connect GitHub" → (start) signed state로 GitHub App install URL → GitHub서
설치 → (callback) state 검증 → github_installation 저장. 연결상태(status)는 org-scoped 조회.

보안(lock): callback state=CSRF+org바인딩+nonce+TTL(verify_install_state)·전 read org_id 스코프
(anti-IDOR)·installation access token은 여기 저장 안 함(서비스가 단명 mint+캐시).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, RedirectResponse
from jose import jwt
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id, require_admin
from app.dependencies.database import get_db
from app.models.github_installation import GithubInstallation, GithubInstallNonce
from app.services.github_app import (
    fetch_installation_metadata,
    sign_install_state,
    verify_install_state,
    verify_installation_owned,
)

router = APIRouter(prefix="/api/v2/integrations/github", tags=["github-integration"])


@router.get("/install/start")
async def install_start(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(require_admin),  # ⭐org admin 전용(non-admin 거부).
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """설치 URL 발급(org-bound signed state + 서버측 nonce 등록). FE Route Handler가 install_url로 302."""
    if not settings.github_app_slug:
        return JSONResponse(status_code=503, content={"error": "github_app_not_configured"})
    state = sign_install_state(org_id)
    # nonce 서버측 등록 — callback서 one-time consume(replay 방어).
    claims = jwt.get_unverified_claims(state)
    session.add(
        GithubInstallNonce(
            jti=claims["jti"],
            org_id=org_id,
            expires_at=datetime.fromtimestamp(int(claims["exp"]), tz=timezone.utc),
        )
    )
    await session.commit()
    install_url = (
        f"https://github.com/apps/{settings.github_app_slug}/installations/new?state={state}"
    )
    return JSONResponse(content={"install_url": install_url})


@router.get("/install/callback")
async def install_callback(
    installation_id: int = Query(...),
    state: str = Query(...),
    code: str | None = Query(default=None),
    setup_action: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """GitHub 설치 후 리다이렉트. state(CSRF+org+nonce+TTL) 검증 → nonce one-time consume → installation
    소속 검증(anti-IDOR) → github_installation upsert. 위조/만료/replay/소속불일치 전부 거부.
    """
    settings_url = "/settings/integrations"

    verified = verify_install_state(state)
    if verified is None:
        return RedirectResponse(url=f"{settings_url}?github=invalid_state", status_code=302)
    org_id, jti = verified

    # one-time consume(replay 방어): atomic DELETE — 없으면(재사용/만료) 거부. consume은 즉시 커밋.
    consumed = await session.execute(
        delete(GithubInstallNonce).where(
            GithubInstallNonce.jti == jti,
            GithubInstallNonce.expires_at > datetime.now(timezone.utc),
        )
    )
    await session.commit()
    if consumed.rowcount == 0:
        return RedirectResponse(url=f"{settings_url}?github=replay_or_expired", status_code=302)

    # ⭐anti-IDOR: 콜백을 완료하는 user(org admin)가 이 installation 을 정당히 통제하는지 검증.
    # 임의 installation_id 주입 차단. (code=user-authorization-during-install OAuth code·single-use.)
    if not await verify_installation_owned(code or "", installation_id):
        return RedirectResponse(url=f"{settings_url}?github=not_owned", status_code=302)

    meta = await fetch_installation_metadata(installation_id) or {}

    # org_id 기준 upsert(per-org 1설치·state가 org 바인딩이라 org A가 org B 행 못 씀=anti-IDOR).
    existing = (
        await session.execute(
            select(GithubInstallation).where(GithubInstallation.org_id == org_id)
        )
    ).scalar_one_or_none()

    if existing is not None:
        existing.installation_id = installation_id
        existing.account_login = meta.get("account_login")
        existing.account_type = meta.get("account_type")
        existing.repository_selection = meta.get("repository_selection")
        existing.suspended_at = None
    else:
        session.add(
            GithubInstallation(
                org_id=org_id,
                installation_id=installation_id,
                account_login=meta.get("account_login"),
                account_type=meta.get("account_type"),
                repository_selection=meta.get("repository_selection"),
            )
        )
    try:
        await session.commit()
    except Exception:
        await session.rollback()
        # installation_id가 다른 org에 이미 묶임(글로벌 uq) 등 → 충돌 거부(조용히 실패 리다이렉트).
        return RedirectResponse(url=f"{settings_url}?github=conflict", status_code=302)

    return RedirectResponse(url=f"{settings_url}?github=connected", status_code=302)


@router.get("/status")
async def github_status(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """현 org의 GitHub App 연결상태(org_id 스코프·anti-IDOR). 미설치=graceful connected:false."""
    inst = (
        await session.execute(
            select(GithubInstallation).where(GithubInstallation.org_id == org_id)
        )
    ).scalar_one_or_none()
    if inst is None:
        return JSONResponse(content={"connected": False})
    return JSONResponse(
        content={
            "connected": True,
            "account_login": inst.account_login,
            "account_type": inst.account_type,
            "repository_selection": inst.repository_selection,
            "suspended": inst.suspended_at is not None,
        }
    )
