"""story #4397 — which push devices a notification for (org, members) goes to.

A device belongs to a person, not to one org. Its row carries the org + member it last registered with (the upsert re-homes
it), so selecting by org + member reached only the org the person last opened the app in. With the `push_devices_by_user`
setting on, devices are selected by the **person** behind each target member (org_members.user_id in that org), plus rows
not backfilled yet (user_id NULL) the old way. Off (default): the old selection, unchanged.

The setting stays off in prod until the app build that re-registers on account switch (and switches org when a notification
of another org is tapped) is out — otherwise someone who switched accounts would get the previous account's notifications.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.member import Member
from app.models.project import OrgMember
from app.models.push_device import PushDevice


async def select_active_devices(
    db: AsyncSession, org_id: uuid.UUID, member_ids: list[uuid.UUID], *extra_where: Any,
) -> list[PushDevice]:
    """Active devices for these members of `org_id` (mute filtering is the caller's, at member level)."""
    if not member_ids:
        return []
    # story #4752: a member whose seat is closed (the person deleted the account, or was removed) gets no push — the notice that reaches the in-app list and the webhooks already drops a closed member
    # (the `team_members` view), so the push must not keep sending to the device of a person who is gone. (NOT-IN a closed list, so an id that is not a `members` row at all keeps working as before.)
    closed = select(Member.id).where(Member.id.in_(member_ids), or_(Member.deleted_at.is_not(None), Member.is_active.is_(False)))   # (a removal by an admin sets `is_active`; the account deletion sets both)
    by_org_member = and_(PushDevice.org_id == org_id, PushDevice.member_id.in_(member_ids), PushDevice.member_id.not_in(closed))
    if settings.push_devices_by_user:
        people = (
            select(OrgMember.user_id)
            .where(OrgMember.org_id == org_id, OrgMember.id.in_(member_ids), OrgMember.deleted_at.is_(None), OrgMember.id.not_in(closed))   # (the same «closed» as the by-member branch — story #4752)
            .scalar_subquery()
        )
        who = or_(PushDevice.user_id.in_(people), and_(PushDevice.user_id.is_(None), by_org_member))
    else:
        who = by_org_member
    rows = await db.execute(select(PushDevice).where(who, PushDevice.is_active.is_(True), *extra_where))
    return list(rows.scalars().all())
