"""story #4825 (공개 2-② (나), 로컬 모드 로그인) — `POST /api/v2/auth/local-bootstrap`: the desktop app's embedded server gives its owner a session
without a sign-up or an e-mail verification.

Who may call it: only the app's own main process. The route exists ONLY when `settings.is_embedded` (SPRINTABLE_EMBEDDED on + a bootstrap secret of
32+ characters + not Cloud Run) — otherwise it is not registered at all (`register_local_auth_routes`), and a hosted deployment, which never carries
either variable, has no such path. When it exists the caller must (a) come from the loopback interface and (b) present the per-install secret in
`X-Local-Bootstrap-Secret` (constant-time compare). Every refusal is the same bare 403 — it does not say which check failed — and nothing of the
secret is ever logged or echoed.

What it does: the owner of this install is ONE account (`LOCAL_OWNER_EMAIL`, verified, no password — it cannot sign in with one). The first call
creates that account, an organization it owns and a first project; every later call (the app calls it on every launch) finds the same account and only
issues a new session — it never creates a second owner, organization or project. A transaction-scoped advisory lock serialises concurrent calls.
The session is issued exactly as a password sign-in does (`create_tokens` + a stored refresh token), so the web middleware and the backend accept it
unchanged; the app puts the two tokens into the window's cookies (`sp_at` · `sp_rt`).
"""
from __future__ import annotations

import hmac
import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.rate_limit import limiter
from app.core.security import REFRESH_TOKEN_EXPIRE_DAYS, create_refresh_token, create_tokens
from app.dependencies.database import get_db
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/auth", tags=["auth", "local"])

#: the one owner account of an embedded install (a reserved, non-routable address: nothing can be mailed to it and nobody can register it by accident)
LOCAL_OWNER_EMAIL = "owner@local.sprintable"
_LOOPBACK = {"127.0.0.1", "::1"}
#: a caller that came through a proxy carries one of these; the app's own main process, talking straight to the loopback port, never does. If
#: the server were ever fronted by a reverse proxy on this machine every client would look like loopback, so these headers close that route.
_FORWARDED_HEADERS = ("forwarded", "x-forwarded-for", "x-real-ip")
_LOCK_KEY = "sprintable:local-bootstrap"


class LocalBootstrapRequest(BaseModel):
    """All optional: names for the first organization and project, and what the owner is called (the app passes the OS user's name)."""

    display_name: str | None = Field(default=None, max_length=80)
    org_name: str | None = Field(default=None, max_length=80)
    project_name: str | None = Field(default=None, max_length=80)


def _refuse() -> JSONResponse:
    """One answer for every refusal — it never says which check failed."""
    return JSONResponse({"data": None, "error": {"code": "FORBIDDEN", "message": "Forbidden"}, "meta": None}, status_code=403)


def is_reserved_owner_address(email: str | None) -> bool:
    """True on an EMBEDDED install for any address in the reserved owner domain — `register` refuses it there so that nothing but this route
    can make the owner's account. Always False on a hosted deployment (`is_embedded` is False there), so hosted sign-up is unchanged."""
    return settings.is_embedded and (email or "").strip().lower().endswith("@local.sprintable")


def _clean(value: str | None, fallback: str) -> str:
    value = (value or "").strip()
    return value or fallback


@router.post("/local-bootstrap")
@limiter.limit("30/minute")
async def local_bootstrap(
    request: Request,
    body: LocalBootstrapRequest | None = None,
    x_local_bootstrap_secret: str | None = Header(default=None),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    # the route is only registered when embedded; this re-check keeps a mis-wired test app or a later refactor from serving it anywhere else
    if not settings.is_embedded:
        return _refuse()
    host = request.client.host if request.client else ""
    if host not in _LOOPBACK:
        logger.warning("local-bootstrap refused: caller is not loopback")
        return _refuse()
    if any(h in request.headers for h in _FORWARDED_HEADERS):
        logger.warning("local-bootstrap refused: the call came through a proxy")
        return _refuse()
    expected = settings.local_bootstrap_secret.encode()
    provided = (x_local_bootstrap_secret or "").encode()
    if not hmac.compare_digest(provided, expected):
        logger.warning("local-bootstrap refused: secret mismatch")
        return _refuse()

    # lazy imports: the auth router is a large module; keep this one importable on its own and avoid an import cycle at app start
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.routers.auth import (
        _ok,
        _persist_resolved_context,
        _refresh_session_context,
        _store_refresh_token,
        _write_audit,
    )
    from app.services.agent_onboarding_config import resolve_locale_from_request
    from app.services.org_project_create import create_org_with_owner, create_project_with_member, lock_first_org_path

    body = body or LocalBootstrapRequest()
    # one install, one owner: concurrent calls (two windows starting at once) wait here and then see the first call's rows
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": _LOCK_KEY})

    now = datetime.now(timezone.utc)
    # any state of the row: a deactivated or purged one must not make the insert below fail with a unique-key error (a 500) — it is refused instead.
    # Whose account this is does not rest on a password or a second factor (the owner may set either later and must not be locked out of their own
    # install): on an embedded install nothing but this route can make an account at the reserved address — `register` refuses it there
    # (`is_reserved_owner_address`) and no OAuth / e-mail flow is configured.
    user = (await session.execute(select(User).where(User.email == LOCAL_OWNER_EMAIL))).scalar_one_or_none()
    if user is not None and (not user.is_active or user.deleted_at is not None):
        logger.warning("local-bootstrap refused: the owner account is deactivated or deleted")
        return _refuse()
    if user is None:
        user = User(
            email=LOCAL_OWNER_EMAIL,
            hashed_password="",  # no password: nothing can sign in as the owner except through this route
            display_name=_clean(body.display_name, "Owner"),
            is_active=True,
            email_verified=True,
            tos_accepted_at=now,
            locale=resolve_locale_from_request(None, request.headers.get("accept-language")),
        )
        session.add(user)
        await session.flush()

    # the same per-person lock every first-organization path takes, held BEFORE the look: a setup or invite flow that creates this person's first
    # organization while we wait is seen by the look below instead of being doubled
    await lock_first_org_path(session, user.id)
    org_id = (await session.execute(
        # joined to the organization: a membership whose organization is gone (org_members.org_id has no foreign key) is not "my organization"
        select(OrgMember.org_id).join(Organization, Organization.id == OrgMember.org_id)
        .where(OrgMember.user_id == user.id, OrgMember.role == "owner", OrgMember.deleted_at.is_(None))
        .order_by(OrgMember.created_at.asc()).limit(1)
    )).scalar_one_or_none()
    created_org = org_id is None
    if created_org:
        # the app sends a localized name; the server keeps no Korean user strings (story #3779), so its own default is English
        org = await create_org_with_owner(
            session, name=_clean(body.org_name, "My workspace"), slug=None, user_id=str(user.id), owner_member_id=None,
        )
        org_id = org.id
        # the first project belongs to the organization THIS call made: nobody else can be creating one in an organization that did not exist a
        # moment ago (no slug race), and a person who later deletes their projects does not get a new one on every launch
        await create_project_with_member(
            session, org_id=org_id, name=_clean(body.project_name, "First project"),
            description=None, slug=None, user_id=str(user.id),
        )
    await session.flush()

    # the session is issued exactly as a password sign-in does it (routers/auth.py login): same claims, same stored refresh token
    # the session is for THIS install's organization, not whatever the person-wide default would pick (a sign-in picks `last_org_id` / the oldest
    # membership — another organization the owner belongs to would win and could even have no project)
    _md = await _refresh_session_context(user, session, org_id, None)
    if settings.build_app_metadata_defallback:
        _persist_resolved_context(user, _md)
    tokens = create_tokens(str(user.id), email=user.email, app_metadata=_md, session_started_at=int(now.timestamp()))
    _, refresh_exp = create_refresh_token(str(user.id), expires_delta=timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    await _store_refresh_token(session, user, tokens["refresh_token"], refresh_exp, app_metadata=_md)
    await _write_audit(
        session, "login_success", user_id=user.id, email=user.email, ip_address=host, user_agent=request.headers.get("user-agent"), detail="local_bootstrap",
    )
    await session.commit()
    return _ok(tokens)


def register_local_auth_routes(app: FastAPI) -> bool:
    """Register the route on `app` only when this is an embedded install (`settings.is_embedded`). Returns whether it did."""
    if settings.is_embedded:
        app.include_router(router)
        return True
    return False


def assert_local_bootstrap_config() -> None:
    """Startup guard (fail-closed, like the stub routers' `assert_*_not_registered_in_prod`): the embedded switch and its secret go together, and
    never on Cloud Run. A hosted process that carries either variable — alone or half-configured — refuses to start."""
    import os

    flag = os.environ.get("SPRINTABLE_EMBEDDED", "").strip().lower() in {"1", "true", "yes"}
    secret = settings.local_bootstrap_secret
    if not flag:
        if secret:
            raise RuntimeError("LOCAL_BOOTSTRAP_SECRET is set but SPRINTABLE_EMBEDDED is not — refusing to start (embedded-only setting)")
        return
    if os.environ.get("K_SERVICE"):
        raise RuntimeError("SPRINTABLE_EMBEDDED is set on Cloud Run — refusing to start (embedded-only setting)")
    if len(secret) < 32:
        raise RuntimeError("SPRINTABLE_EMBEDDED is set but LOCAL_BOOTSTRAP_SECRET is missing or shorter than 32 characters — refusing to start")
