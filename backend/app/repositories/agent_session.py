from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import AgentSession
from app.schemas.agent_session import AgentSessionResponse

VALID_STATUSES = frozenset({"active", "idle", "suspended", "terminated"})


class AgentSessionError(Exception):
    def __init__(self, code: str, status: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _to_response(session: AgentSession) -> AgentSessionResponse:
    return AgentSessionResponse(
        id=session.id,
        org_id=session.org_id,
        project_id=session.project_id,
        agent_id=session.agent_id,
        persona_id=session.persona_id,
        deployment_id=session.deployment_id,
        session_key=session.session_key,
        channel=session.channel,
        title=session.title,
        status=session.status,
        context_window_tokens=session.context_window_tokens,
        session_metadata=session.session_metadata or {},
        context_snapshot=session.context_snapshot or {},
        created_by=session.created_by,
        started_at=session.started_at,
        last_activity_at=session.last_activity_at,
        idle_at=session.idle_at,
        suspended_at=session.suspended_at,
        ended_at=session.ended_at,
        terminated_at=session.terminated_at,
        created_at=session.created_at,
        updated_at=session.updated_at,
    )


class AgentSessionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def list(
        self,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        agent_id: uuid.UUID | None = None,
        status: str | None = None,
        limit: int = 50,
    ) -> list[AgentSessionResponse]:
        q = (
            select(AgentSession)
            .where(
                AgentSession.org_id == org_id,
                AgentSession.project_id == project_id,
                AgentSession.deleted_at.is_(None),
            )
            .order_by(AgentSession.last_activity_at.desc())
            .limit(min(limit, 100))
        )
        if agent_id:
            q = q.where(AgentSession.agent_id == agent_id)
        if status:
            q = q.where(AgentSession.status == status)
        r = await self.session.execute(q)
        return [_to_response(s) for s in r.scalars().all()]

    async def get(self, session_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID) -> AgentSessionResponse | None:
        r = await self.session.execute(
            select(AgentSession).where(
                AgentSession.id == session_id,
                AgentSession.org_id == org_id,
                AgentSession.project_id == project_id,
                AgentSession.deleted_at.is_(None),
            )
        )
        s = r.scalar_one_or_none()
        return _to_response(s) if s else None

    async def transition(
        self,
        session_id: uuid.UUID,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        actor_id: uuid.UUID,
        status: str,
        reason: str | None = None,
    ) -> AgentSessionResponse:
        if status not in VALID_STATUSES:
            raise AgentSessionError("INVALID_STATUS", 400, f"Invalid status: {status}")

        r = await self.session.execute(
            select(AgentSession).where(
                AgentSession.id == session_id,
                AgentSession.org_id == org_id,
                AgentSession.project_id == project_id,
                AgentSession.deleted_at.is_(None),
            )
        )
        s = r.scalar_one_or_none()
        if s is None:
            raise AgentSessionError("SESSION_NOT_FOUND", 404, "Session not found")

        now = datetime.now(timezone.utc)
        patch: dict[str, Any] = {
            "status": status,
            "last_activity_at": now,
            "updated_at": now,
            "session_metadata": {
                **(s.session_metadata or {}),
                "transition_reason": "manual_transition",
                "transition_note": reason,
                "transition_actor_id": str(actor_id),
            },
        }

        if status == "active":
            patch.update({"idle_at": None, "suspended_at": None, "ended_at": None, "terminated_at": None})
        elif status == "idle":
            patch.update({"idle_at": now, "suspended_at": None, "ended_at": None, "terminated_at": None})
        elif status == "suspended":
            patch.update({"idle_at": None, "suspended_at": now, "ended_at": None, "terminated_at": None})
        else:  # terminated
            patch.update({"idle_at": None, "suspended_at": None, "ended_at": now, "terminated_at": now})

        await self.session.execute(
            update(AgentSession).where(AgentSession.id == session_id).values(**patch)
        )
        await self.session.flush()
        await self.session.refresh(s)
        return _to_response(s)
