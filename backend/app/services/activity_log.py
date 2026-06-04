"""ActivityLogService — 내부 서비스 전용. API expose는 S-C3에서."""
from __future__ import annotations

import uuid
import logging
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity_log import ActivityLog

logger = logging.getLogger(__name__)

ActorType = Literal["agent", "human"]


async def record_activity_bg(
    *,
    org_id: uuid.UUID,
    action: str,
    actor_id: uuid.UUID | None = None,
    actor_type: ActorType | None = None,
    project_id: uuid.UUID | None = None,
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    context: dict | None = None,
) -> None:
    """BackgroundTask용 activity log 기록. 실패해도 caller에 영향 없음 (AC6)."""
    from app.core.database import async_session_factory

    try:
        async with async_session_factory() as db:
            resolved_type: ActorType = actor_type or "human"
            if actor_type is None and actor_id is not None:
                # AC3-2d(1b): canonical 정합 — TeamMember 직접 조회는 0085 후 canonical 휴먼(≠tm.id)을 못 찾아
                # "human" 기본 fallback만. lookup_members_by_ids(anchor)는 canonical/legacy 모두 해소.
                from app.services.member_resolver import lookup_members_by_ids
                m = (await lookup_members_by_ids({actor_id}, db)).get(actor_id)
                if m and m.type in ("agent", "human"):
                    resolved_type = m.type  # type: ignore[assignment]

            await ActivityLogService(db).record(
                org_id=org_id,
                action=action,
                actor_id=actor_id,
                actor_type=resolved_type,
                project_id=project_id,
                entity_type=entity_type,
                entity_id=entity_id,
                context=context,
            )
            await db.commit()
    except Exception:
        logger.warning("record_activity_bg failed action=%s actor_id=%s", action, actor_id, exc_info=True)


class ActivityLogService:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def record(
        self,
        *,
        org_id: uuid.UUID,
        action: str,
        actor_type: ActorType,
        actor_id: uuid.UUID | None = None,
        project_id: uuid.UUID | None = None,
        entity_type: str | None = None,
        entity_id: uuid.UUID | None = None,
        context: dict | None = None,
    ) -> ActivityLog:
        """activity_logs row 생성. immutable — update/delete 없음. (AC2, AC3, AC4, AC5)"""
        if actor_type not in ("agent", "human"):
            raise ValueError(f"actor_type must be 'agent' or 'human', got {actor_type!r}")

        log = ActivityLog(
            org_id=org_id,
            project_id=project_id,
            actor_id=actor_id,
            actor_type=actor_type,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            context=context or {},  # AC3: NULL 저장 금지, 기본값 {}
        )
        self._db.add(log)
        await self._db.flush()
        logger.info(
            "activity_log recorded action=%s actor_type=%s actor_id=%s entity_type=%s entity_id=%s",
            action, actor_type, actor_id, entity_type, entity_id,
        )
        return log
