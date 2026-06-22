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
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id, require_admin
from app.dependencies.database import get_db
from app.models.github_installation import GithubInstallation, GithubInstallNonce
from app.models.pm import Story
from app.models.pull_request_story_link import PullRequestStoryLink
from app.services.github_app import (
    fetch_installation_metadata,
    sign_install_state,
    verify_install_state,
    verify_installation_owned,
)
from app.services.pr_story_link import upsert_link

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


class _ExplicitLinkBody(BaseModel):
    story_id: uuid.UUID
    repo_full_name: str
    pr_number: int


@router.post("/links")
async def create_explicit_link(
    body: _ExplicitLinkBody,
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """PR↔story **명시연결**(explicit·confidence high·Bot-L.2 UI 의 BE). resolver 체인 최우선·close-on-merge
    가능. ⭐anti-IDOR **2층**: ①story 가 caller org 소속 ②**repo 가 org 의 설치 context**(installation account)에
    속함. 둘 다 미충족 = generic 404(타 org/repo 존재 oracle 0). per-org 격리·upsert·created_by=caller member.
    """
    if not body.repo_full_name.strip() or "/" not in body.repo_full_name or body.pr_number <= 0:
        return JSONResponse(status_code=422, content={"error": "invalid_pr_identity"})
    # ①story org-scope 검증(타 org story_id 차단·존재 여부 노출 금지).
    story = (
        await session.execute(
            select(Story).where(
                Story.id == body.story_id, Story.org_id == org_id, Story.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    if story is None:
        return JSONResponse(status_code=404, content={"error": "story_not_found"})
    # ②repo 가 org 의 설치 context 에 속하는지(anti-IDOR·임의 repo high link 차단). org 의 active installation
    # account_login 과 repo owner 일치 요구. 미설치/owner 불일치 = generic 404(repo 존재 oracle 0).
    inst = (
        await session.execute(
            select(GithubInstallation).where(
                GithubInstallation.org_id == org_id, GithubInstallation.suspended_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    repo_owner = body.repo_full_name.strip().split("/", 1)[0].lower()
    if inst is None or not inst.account_login or repo_owner != inst.account_login.lower():
        return JSONResponse(status_code=404, content={"error": "repo_not_in_org_context"})
    try:
        created_by: uuid.UUID | None = uuid.UUID(auth.user_id)
    except (ValueError, TypeError):
        created_by = None
    link = await upsert_link(
        session, org_id, body.story_id, body.repo_full_name, body.pr_number,
        link_source="explicit", confidence="high", created_by=created_by,
        evidence={"by": "explicit_api"},
    )
    await session.commit()
    return JSONResponse(
        content={
            "id": str(link.id),
            "story_id": str(body.story_id),
            "repo_full_name": link.repo_full_name,
            "pr_number": link.pr_number,
            "link_source": "explicit",
            "confidence": "high",
        }
    )


def _link_view(link: PullRequestStoryLink) -> dict:
    return {
        "id": str(link.id),
        "repo_full_name": link.repo_full_name,
        "pr_number": link.pr_number,
        "link_source": link.link_source,
        "confidence": link.confidence,
        "evidence": link.evidence,
        "created_at": link.created_at.isoformat() if link.created_at else None,
    }


@router.get("/links")
async def list_links(
    story_id: uuid.UUID = Query(...),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """story 의 PR↔story 링크 목록(Bot-L.2 UI '연결 PR 표시'). org-scope·story 선검증(anti-IDOR).
    타 org/부재 story = generic 404(존재 oracle 0). 링크는 org+story+미삭제만 반환."""
    story = (
        await session.execute(
            select(Story).where(
                Story.id == story_id, Story.org_id == org_id, Story.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    if story is None:
        return JSONResponse(status_code=404, content={"error": "story_not_found"})
    links = (
        await session.execute(
            select(PullRequestStoryLink)
            .where(
                PullRequestStoryLink.org_id == org_id,
                PullRequestStoryLink.story_id == story_id,
                PullRequestStoryLink.deleted_at.is_(None),
            )
            .order_by(PullRequestStoryLink.created_at.desc())
        )
    ).scalars().all()
    return JSONResponse(content={"links": [_link_view(link) for link in links]})


@router.delete("/links/{link_id}")
async def delete_link(
    link_id: uuid.UUID,
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """PR↔story 링크 해제(Bot-L.2 UI '해제'·soft-delete). ⭐anti-IDOR: `link.id AND org_id` — 타 org/부재/
    이미 삭제는 generic 404(존재 oracle 0). soft-delete(deleted_at) 라 close-on-merge resolver 에서 즉시 제외."""
    link = (
        await session.execute(
            select(PullRequestStoryLink).where(
                PullRequestStoryLink.id == link_id,
                PullRequestStoryLink.org_id == org_id,
                PullRequestStoryLink.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if link is None:
        return JSONResponse(status_code=404, content={"error": "link_not_found"})
    link.deleted_at = datetime.now(timezone.utc)
    await session.commit()
    return JSONResponse(content={"deleted": True, "id": str(link_id)})
