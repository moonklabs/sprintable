"""story 4714 (AC2) — «Mac에서 열 링크를 메일로 받기»: the phone app's first screen, when no Mac is paired, mails the signed-in person
a link to open on a Mac. Design: nwachukwu/4714-ac2-mac-link-mail-design-1017.md · words: yuna/4714-ac2-mac-link-mail-copy-1018.md.

What makes this safe to expose (the only thing here that sends mail outside):
  · the receiver is the caller's OWN account address, read from the account row — the request carries no address, no body at all;
  · a person's browser/app session only — an agent key and a person's own API key are 403 (nothing a script could loop);
  · the link is `{app_url}/desktop`, a plain address: no token, no code, no session — a mail that leaks gives nothing;
  · counted per person (3 an hour, one a minute) and FAILING CLOSED — a counting problem is a 503, never a mail;
  · an unverified address gets no mail (409) — the person verifies first.
`delivered` is the truth of the send: a console fallback (no mail provider) is `false`, never reported as sent."""
from __future__ import annotations

import asyncio
import logging
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import hit_person_limits_strict
from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/desktop", tags=["desktop"])

# per signed-in person (not per address): the same shape as «인증 메일 다시 보내기» (3 an hour) plus a minute between two — TIGHTEST FIRST (the
# counter stops at the first full window, so a request the minute rule refuses does not use up the hour)
MAC_LINK_MAIL_LIMITS = ("1/minute", "3/hour")
_SCOPE = "mac-link-mail"


def _refuse(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message}, headers=headers)


@router.post("/mac-link-mail")
async def post_mac_link_mail(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
):
    from app.routers.auth import _requires_interactive_session

    response.headers["Cache-Control"] = "no-store"
    if _requires_interactive_session(auth):
        raise _refuse(403, "person_session_required", "a person's session is required")
    user = (await db.execute(select(User).where(User.id == uuid.UUID(str(auth.user_id))))).scalar_one_or_none()
    if user is None or not user.email or not user.is_active or user.deleted_at is not None:  # story #4752: a deleted account is mailed nothing (its tokens are cut off; this is the same answer if one slips through)
        raise _refuse(404, "user_not_found", "user not found")
    if not user.email_verified:
        raise _refuse(409, "email_not_verified", "verify your email first")

    wait = hit_person_limits_strict(_SCOPE, str(user.id), *MAC_LINK_MAIL_LIMITS)  # a storage problem raises → main.py answers 503
    if wait is not None:
        raise _refuse(429, "rate_limited", "too many requests", headers={"Retry-After": str(wait)})

    from app.services.agent_onboarding_config import resolve_locale
    from app.services.email import render_action_email, send_email
    from app.services.i18n_catalog import t

    locale = resolve_locale(user.locale)
    link = f"{os.getenv('NEXT_PUBLIC_APP_URL', 'https://app.sprintable.ai')}/desktop"  # nothing but the page: no token · no code · no query
    delivered = await asyncio.to_thread(  # the sync sender (SMTP 10 s · Resend 30 s) must not hold the event loop
        send_email,
        to=user.email,
        subject=t("mac_link_mail.subject", locale),
        html_body=render_action_email(
            intro_lines=[t("mac_link_mail.intro_1", locale), t("mac_link_mail.intro_2", locale)],
            cta_label=t("mac_link_mail.cta_label", locale),
            cta_url=link,
            expiry_note=t("mac_link_mail.expiry_note", locale),
            security_note=t("mac_link_mail.security_note", locale),
            fallback_label=t("mac_link_mail.fallback_label", locale),
            locale=locale,
        ),
    )
    if not delivered:
        logger.warning("mac-link-mail: not delivered (console fallback — no mail provider) user_id=%s", user.id)  # no address in the log
    return {"delivered": bool(delivered), "email": user.email}
