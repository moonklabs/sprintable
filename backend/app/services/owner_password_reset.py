"""story 5023 (d) — a workspace SERVER has no mail, so «forgot password» (a mailed link) cannot work: the owner hands the person a reset link instead.

Only on a server host (`server_owner_setup.enabled()` — embedded AND the host's own switch: never hosted, never the desktop app). The link is the ordinary one of `/auth/forgot-password`
(`/reset-password?token=…`, 30 minutes, dead as soon as the password changes, every sign-in of the person ends when it is used) — the owner never sees or sets a password, and nothing new is trusted at the other end.

Who may be given a link: by an ACTIVE OWNER of the organization, in a person's session (an API key or an agent never — the same rule as turning remote control on), for a member of THIS organization who is
  · not the owner asking (their own password is theirs: change-password) · not an owner (one owner cannot take over another) ·
  · a person who is in NO other organization (on a server with several organizations the same account is also somebody else's member: a link would hand that account — and those organizations — to this owner).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import RESET_TOKEN_EXPIRE_MINUTES, create_password_reset_token
from app.models.project import OrgMember
from app.models.user import User
from app.services import server_owner_setup


class ResetLinkRefused(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@dataclass(frozen=True)
class ResetLink:
    url: str
    expires_in_seconds: int


def available_here() -> bool:
    """the server host only — hosted keeps the mailed link, the desktop app has no owner to ask"""
    return server_owner_setup.enabled()


async def other_org_counts(session: AsyncSession, org_id: uuid.UUID, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """for each user: in how many OTHER organizations they are a live member"""
    if not user_ids:
        return {}
    rows = await session.execute(
        select(OrgMember.user_id, func.count(OrgMember.id))
        .where(OrgMember.user_id.in_(user_ids), OrgMember.org_id != org_id, OrgMember.deleted_at.is_(None))
        .group_by(OrgMember.user_id)
    )
    return {uid: n for uid, n in rows}


def eligible(*, caller_is_owner: bool, caller_member_id: uuid.UUID, target_id: uuid.UUID, target_role: str, other_orgs: int) -> bool:
    """the same rule `check` enforces — the members list uses it to decide where to show the button"""
    return caller_is_owner and available_here() and target_id != caller_member_id and target_role != "owner" and other_orgs == 0


async def check(session: AsyncSession, *, org_id: uuid.UUID, caller: OrgMember | None, target: OrgMember | None) -> None:
    """raises `ResetLinkRefused` with the answer the person gets, or returns when a link may be made"""
    if not available_here():
        raise ResetLinkRefused(404, "not_available", "this server sends no mail-less reset links")
    if caller is None or caller.role != "owner":
        raise ResetLinkRefused(403, "ORG_MEMBER_OWNER_ONLY_ACTION", "only an owner of this organization can hand out a reset link")
    if target is None:
        raise ResetLinkRefused(404, "org_member_not_found", "no such member")
    if target.id == caller.id:
        raise ResetLinkRefused(409, "ORG_RESET_SELF", "this is your own account — change your password in your settings")
    if target.role == "owner":
        raise ResetLinkRefused(403, "ORG_RESET_OWNER_FORBIDDEN", "the password of an owner is reset by that owner")
    n = (await other_org_counts(session, org_id, [target.user_id])).get(target.user_id, 0)
    if n:
        raise ResetLinkRefused(409, "ORG_RESET_PERSON_IN_OTHER_ORGS", "this person is also a member of another organization on this server — only they can reset their password")


async def issue(session: AsyncSession, *, org_id: uuid.UUID, caller: OrgMember | None, target: OrgMember | None) -> ResetLink:
    await check(session, org_id=org_id, caller=caller, target=target)
    assert target is not None
    user = (await session.execute(select(User).where(User.id == target.user_id))).scalar_one_or_none()
    if user is None or not user.hashed_password:
        raise ResetLinkRefused(404, "org_member_not_found", "this member has no account here")
    token = create_password_reset_token(str(user.id), user.hashed_password)
    return ResetLink(url=f"{settings.app_url}/reset-password?token={token}", expires_in_seconds=RESET_TOKEN_EXPIRE_MINUTES * 60)
