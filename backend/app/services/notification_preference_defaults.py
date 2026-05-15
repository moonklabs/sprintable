"""member 생성 시 기본 NotificationPreference 자동 삽입 헬퍼."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification_preference import NotificationPreference

_HUMAN_DEFAULTS = [("global", "in_app", "all")]
_AGENT_DEFAULTS = [("global", "sse", "all")]


async def insert_default_preferences(
    db: AsyncSession,
    member_id: uuid.UUID,
    member_type: str,
) -> None:
    """human → global/in_app/all, agent → global/sse/all 기본 preference 삽입."""
    defaults = _HUMAN_DEFAULTS if member_type == "human" else _AGENT_DEFAULTS
    now = datetime.now(timezone.utc)
    for scope_type, channel, level in defaults:
        db.add(NotificationPreference(
            id=uuid.uuid4(),
            member_id=member_id,
            scope_type=scope_type,
            scope_id=None,
            channel=channel,
            level=level,
            created_at=now,
            updated_at=now,
        ))
