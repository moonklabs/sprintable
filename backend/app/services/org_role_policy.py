"""story 5021 — WHO may hand out WHICH organization role: the one rule, in one place.

An organization role is `owner` · `admin` · `member` (schemas/org_member.ORG_ROLES). The rule is the one the PO fixed for changing a member's role (story 3491 · routers/org_members.py
`update_org_member`: an admin never makes an owner), applied to INVITATIONS too:

  owner  → may hand out owner · admin · member
  admin  → may hand out admin · member            (never owner)
  member → nothing                                 (and anyone without a role: nothing)

Used when an invitation is MADE (the caller's role now) and when it is ACCEPTED (the role its creator still holds now): an invitation made before this rule existed — or by someone who
has since been demoted, removed or deleted — is not a way to a role its maker may not give. A role that is not one of the three is never handed out."""
from __future__ import annotations

from app.schemas.org_member import ORG_ROLES


def can_grant_org_role(granter_role: str | None, target_role: str | None) -> bool:
    if target_role not in ORG_ROLES:
        return False
    if granter_role == "owner":
        return True
    if granter_role == "admin":
        return target_role in ("admin", "member")
    return False
