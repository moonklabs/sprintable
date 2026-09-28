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
from app.models.project import OrgMember
from app.models.push_device import PushDevice


async def select_active_devices(
    db: AsyncSession, org_id: uuid.UUID, member_ids: list[uuid.UUID], *extra_where: Any,
) -> list[PushDevice]:
    """Active devices for these members of `org_id` (mute filtering is the caller's, at member level)."""
    if not member_ids:
        return []
    by_org_member = and_(PushDevice.org_id == org_id, PushDevice.member_id.in_(member_ids))
    if settings.push_devices_by_user:
        people = (
            select(OrgMember.user_id)
            .where(OrgMember.org_id == org_id, OrgMember.id.in_(member_ids), OrgMember.deleted_at.is_(None))
            .scalar_subquery()
        )
        who = or_(PushDevice.user_id.in_(people), and_(PushDevice.user_id.is_(None), by_org_member))
    else:
        who = by_org_member
    rows = await db.execute(select(PushDevice).where(who, PushDevice.is_active.is_(True), *extra_where))
    return list(rows.scalars().all())
