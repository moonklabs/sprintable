"""E-GHAPP Bot-S: GitHub App(봇) per-org 설치 — install start / callback / status.

설치 flow: org admin이 FE "Connect GitHub" → (start) signed state로 GitHub App install URL → GitHub서
설치 → (callback) state 검증 → github_installation 저장. 연결상태(status)는 org-scoped 조회.

보안(lock): callback state=CSRF+org바인딩+nonce+TTL(verify_install_state)·전 read org_id 스코프
(anti-IDOR)·installation access token은 여기 저장 안 함(서비스가 단명 mint+캐시).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.github_installation import GithubInstallation
from app.services.github_app import (
    fetch_installation_metadata,
    sign_install_state,
    verify_install_state,
)

router = APIRouter(prefix="/api/v2/integrations/github", tags=["github-integration"])


@router.get("/install/start")
async def install_start(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> JSONResponse:
    """설치 URL 발급(org-bound signed state). FE Route Handler가 이 install_url로 302 리다이렉트."""
    if not settings.github_app_slug:
        return JSONResponse(status_code=503, content={"error": "github_app_not_configured"})
    state = sign_install_state(org_id)
    install_url = (
        f"https://github.com/apps/{settings.github_app_slug}/installations/new?state={state}"
    )
    return JSONResponse(content={"install_url": install_url})


@router.get("/install/callback")
async def install_callback(
    installation_id: int = Query(...),
    state: str = Query(...),
    setup_action: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """GitHub 설치 후 리다이렉트. state(CSRF+org+nonce+TTL) 검증 → github_installation upsert.

    인증 credential = **signed state**(org 바인딩) — 위조/만료/replay면 거부. 성공/실패 모두 FE 설정으로 리다이렉트.
    """
    settings_url = f"{settings.frontend_url.rstrip('/')}/settings/integrations" if getattr(settings, "frontend_url", "") else "/settings/integrations"

    org_id = verify_install_state(state)
    if org_id is None:
        return RedirectResponse(url=f"{settings_url}?github=invalid_state", status_code=302)

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
