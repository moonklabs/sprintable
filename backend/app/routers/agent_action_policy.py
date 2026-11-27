"""story 5041 ② — the user's settings for what an agent may do on its own: «always allow» (auto) · «ask first» (ask) · «block» (block), per action × agent × project.

GET    /api/v2/agent-action-policy?project_id=&agent_id=   the effective level of every action for that agent in that project (+ where it comes from · the floor rows, locked)
PUT    /api/v2/agent-action-policy                          one setting (an organisation owner / admin, a PERSON's session — no key of any kind)
DELETE /api/v2/agent-action-policy?action_key=&project_id=&agent_id=   back to what the wider scope says

Rules (services/agent_action_policy.py): `auto` only for ONE agent in ONE project · none for the organisation / project deletions · the 19 «floor» rows (a person's own signature) cannot be set.
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.member import Member
from app.services import agent_action_policy as policy
from app.services.activity_log import ActivityLogService
from app.services.member_resolver import resolve_member
from app.services.project_auth import is_org_owner_or_admin

router = APIRouter(prefix="/api/v2/agent-action-policy", tags=["agent-actions", "Trust"])


def _error(status: int, code: str, detail: str = "") -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": detail or code})


async def _admin_person(auth: AuthContext, org_id: uuid.UUID, session: AsyncSession) -> uuid.UUID:
    """a PERSON's session (no agent key · no personal `hu_live_` key — the same rule as pressing an approval card) who is an owner / admin of the organisation"""
    meta = auth.claims.get("app_metadata") or {}
    if meta.get("api_key_id") or meta.get("human_api_key_id"):
        raise _error(403, "ACTION_POLICY_PERSON_SESSION_REQUIRED")
    who = await resolve_member(auth, org_id, session)
    if who.type != "human":
        raise _error(403, "ACTION_POLICY_PERSON_SESSION_REQUIRED")
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise _error(403, "ACTION_POLICY_ADMIN_REQUIRED")
    return who.id


async def _scope(session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID | None, agent_id: uuid.UUID | None) -> None:
    """the project and the agent must be THIS organisation's (a setting never reaches across)"""
    if project_id is not None:
        found = (await session.execute(text("SELECT 1 FROM projects WHERE id = :p AND org_id = :o AND deleted_at IS NULL"), {"p": project_id, "o": org_id})).first()
        if found is None:
            raise _error(404, "ACTION_POLICY_PROJECT_NOT_FOUND")
    if agent_id is not None:
        found = (await session.execute(select(Member.id).where(Member.id == agent_id, Member.org_id == org_id, Member.type == "agent"))).first()
        if found is None:
            raise _error(404, "ACTION_POLICY_AGENT_NOT_FOUND")


class SetPolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_key: str
    level: Literal["auto", "ask", "block"]
    project_id: uuid.UUID | None = None
    agent_id: uuid.UUID | None = None


def _entry(e: policy.EffectiveAction) -> dict:
    return {"action_key": e.action_key, "level": e.level, "source": e.source, "locked": e.locked, "auto_allowed": e.auto_allowed}


@router.get("")
async def get_policy(
    project_id: uuid.UUID | None = None,
    agent_id: uuid.UUID | None = None,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    await _admin_person(auth, org_id, session)
    await _scope(session, org_id, project_id, agent_id)
    return {"project_id": str(project_id) if project_id else None, "agent_id": str(agent_id) if agent_id else None,
            "actions": [_entry(e) for e in await policy.list_effective(session, org_id=org_id, project_id=project_id, agent_id=agent_id)]}


@router.put("")
async def put_policy(
    body: SetPolicyRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    who = await _admin_person(auth, org_id, session)
    await _scope(session, org_id, body.project_id, body.agent_id)
    before, _ = await policy.resolve_action_level(session, org_id=org_id, project_id=body.project_id, agent_id=body.agent_id, action_key=body.action_key)
    try:
        row = await policy.set_action_level(session, org_id=org_id, action_key=body.action_key, level=body.level, project_id=body.project_id, agent_id=body.agent_id, set_by=who)
    except policy.PolicyError as e:
        raise _error(409 if e.code == "ACTION_POLICY_FLOOR" else 422, e.code, e.detail) from None
    # one activity row per change (immutable · the table has no closed list of words — the permission audit table's CHECK allows only role changes)
    await ActivityLogService(session).record(
        org_id=org_id, action="agent_action_policy.set", actor_type="human", actor_id=who, project_id=body.project_id,
        entity_type="agent_action_policy", entity_id=body.agent_id,
        context={"action_key": body.action_key, "level_before": before, "level_after": body.level,
                 "project_id": str(body.project_id) if body.project_id else None, "agent_id": str(body.agent_id) if body.agent_id else None},
    )
    await session.commit()
    return {"action_key": body.action_key, "level": row.level, "project_id": str(body.project_id) if body.project_id else None, "agent_id": str(body.agent_id) if body.agent_id else None}


@router.delete("")
async def delete_policy(
    action_key: str,
    project_id: uuid.UUID | None = None,
    agent_id: uuid.UUID | None = None,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    who = await _admin_person(auth, org_id, session)
    await _scope(session, org_id, project_id, agent_id)
    try:
        removed = await policy.clear_action_level(session, org_id=org_id, action_key=action_key, project_id=project_id, agent_id=agent_id)
    except policy.PolicyError as e:
        raise _error(409, e.code, e.detail) from None
    if removed:
        await ActivityLogService(session).record(
            org_id=org_id, action="agent_action_policy.clear", actor_type="human", actor_id=who, project_id=project_id,
            entity_type="agent_action_policy", entity_id=agent_id,
            context={"action_key": action_key, "project_id": str(project_id) if project_id else None, "agent_id": str(agent_id) if agent_id else None},
        )
    await session.commit()
    return {"removed": removed}
