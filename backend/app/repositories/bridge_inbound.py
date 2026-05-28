from __future__ import annotations

import time
import uuid
from collections import defaultdict
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.bridge import BridgeChannelMapping, BridgeUserMapping
from app.models.team import TeamMember

_RATE_LIMIT_WINDOW = 60
_RATE_LIMIT_MAX = 60
_rate_buckets: dict[str, list[float]] = defaultdict(list)


def check_rate_limit(key: str, now: float | None = None) -> bool:
    now = now or time.time()
    bucket = _rate_buckets[key]
    recent = [t for t in bucket if now - t < _RATE_LIMIT_WINDOW]
    if len(recent) >= _RATE_LIMIT_MAX:
        _rate_buckets[key] = recent
        return False
    recent.append(now)
    _rate_buckets[key] = recent
    return True


class BridgeInboundRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def find_channel_mapping(self, platform: str, channel_id: str) -> BridgeChannelMapping | None:
        result = await self.session.execute(
            select(BridgeChannelMapping).where(
                BridgeChannelMapping.platform == platform,
                BridgeChannelMapping.channel_id == channel_id,
                BridgeChannelMapping.is_active.is_(True),
            )
        )
        return result.scalar_one_or_none()

    async def find_user_mapping(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        platform: str,
        platform_user_id: str,
    ) -> BridgeUserMapping | None:
        result = await self.session.execute(
            select(BridgeUserMapping).where(
                BridgeUserMapping.org_id == org_id,
                BridgeUserMapping.platform == platform,
                BridgeUserMapping.platform_user_id == platform_user_id,
                BridgeUserMapping.is_active.is_(True),
            )
        )
        mapping = result.scalar_one_or_none()
        if mapping is None:
            return None

        member = await self.session.execute(
            select(TeamMember.id).where(
                TeamMember.id == mapping.team_member_id,
                TeamMember.org_id == org_id,
                TeamMember.project_id == project_id,
                TeamMember.is_active.is_(True),
            )
        )
        if member.scalar_one_or_none() is None:
            return None
        return mapping

    async def create_memo(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        created_by: uuid.UUID,
        title: str,
        content: str,
        memo_type: str,
        metadata: "dict[str, Any]",
        assigned_to: "uuid.UUID | None",
    ) -> str:
        # Memos are retired (E-MEMO-RETIRE S3-3); channels should use conversation_id mapping.
        raise NotImplementedError("Memo creation is retired. Configure conversation_id in channel mapping.")

    async def find_fallback_author(self, org_id: uuid.UUID, project_id: uuid.UUID) -> uuid.UUID | None:
        for member_type in ("agent", "human"):
            result = await self.session.execute(
                select(TeamMember.id)
                .where(
                    TeamMember.org_id == org_id,
                    TeamMember.project_id == project_id,
                    TeamMember.type == member_type,
                    TeamMember.is_active.is_(True),
                )
                .order_by(TeamMember.created_at.asc())
                .limit(1)
            )
            found = result.scalar_one_or_none()
            if found:
                return found
        return None

def build_bridge_metadata(platform: str, event: dict[str, Any]) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "source": platform,
        "channel_id": event.get("channelId"),
        "thread_ts": event.get("threadTs"),
        "team_id": event.get("teamId"),
    }
    if event.get("eventId"):
        metadata["event_id"] = event["eventId"]
    if platform == "slack":
        metadata["slack_ts"] = event.get("messageTs")
    elif platform == "teams":
        raw = event.get("raw") or {}
        metadata["teams_activity_id"] = raw.get("id") or event.get("messageTs")
        metadata["teams_service_url"] = raw.get("serviceUrl")
        metadata["teams_conversation_id"] = (raw.get("conversation") or {}).get("id") or event.get("channelId")
    return metadata
