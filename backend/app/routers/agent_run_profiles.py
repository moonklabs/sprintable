"""story #4540 (E-DESKTOP-2 C-5) — the model and effort a desktop agent starts with.
Contract: doc «E-DESKTOP-2 C-5 — 에이전트 실행 프로필 계약» v1.1 (20764ba3) §2 · §3 · §4.

- GET /api/v2/agent-run-profile/options       — what the pickers offer (the measured table)
- GET /api/v2/agent-run-profile               — the daemon, with an agent's own key, right before a start: that agent's only
- GET /api/v2/agents/{id}/run-profile         — a person of the org; `can_change` says whether they may change it
- PUT /api/v2/agents/{id}/run-profile         — one agent (a person's own session)
- PUT /api/v2/agents/run-profile              — many agents, all or nothing (a person's own session)

Changing is the runtime PATCH's rule (creator · org owner/admin · never the system agent) and a person's own session only —
an agent key or a person's own API key gets 403. There is no restart here: a change is used from the next start, and
restarting one by one is the desktop app's (ⓓ).
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id_no_project_gate
from app.dependencies.database import get_db
from app.models.member import Member
from app.services import agent_run_profile as profiles
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2", tags=["agent-run-profiles"])

_KEEP = "keep"


class OneChange(BaseModel):
    runtime: str | None = None  # absent: as it is
    model: str | None  # null: the runtime's default
    effort: str | None
    # story #4598 — «묻지 않고 일하기»: absent = as it is · a change of it is an org owner's only (the service: 403 owner_required)
    unattended: bool | None = None


class BulkChange(BaseModel):
    agent_ids: list[uuid.UUID]
    runtime: str = _KEEP
    model: str | None = _KEEP
    effort: str | None = _KEEP
    unattended: bool | str = _KEEP  # story #4598 — a bool, or "keep" as the other fields


def _keep(value: Any) -> Any:
    return profiles.KEEP if value == _KEEP else value


async def _person_session(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    from app.routers.auth import _requires_interactive_session

    if _requires_interactive_session(auth):
        raise HTTPException(status_code=403, detail={"code": "person_session_required"})
    member = await resolve_member(auth, org_id, db)
    if member.type != "human":
        raise HTTPException(status_code=403, detail={"code": "person_session_required"})
    return member


@router.get("/agent-run-profile/options")
async def get_options(
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    return profiles.options()


@router.get("/agent-run-profile")
async def get_own_profile(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    caller = await resolve_member(auth, org_id, db)
    if caller.type != "agent":
        raise HTTPException(status_code=403, detail={"code": "agent_key_required"})
    member = await db.get(Member, uuid.UUID(str(caller.id)))
    if member is None or member.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return await profiles.read_for_daemon(db, member=member)


@router.get("/agents/{agent_id}/run-profile")
async def get_agent_profile(
    agent_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    person = await resolve_member(auth, org_id, db)
    if person.type != "human":
        raise HTTPException(status_code=403, detail={"code": "person_session_required"})
    return await profiles.read_for_person(db, org_id=org_id, user_id=uuid.UUID(auth.user_id), agent_id=agent_id)


@router.put("/agents/run-profile")
async def put_many_profiles(
    body: BulkChange,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    person = await _person_session(db, auth, org_id)
    if not isinstance(body.unattended, bool) and body.unattended != _KEEP:
        raise HTTPException(status_code=422, detail={"code": "invalid_unattended"})
    views = await profiles.change(
        db, org_id=org_id, user_id=uuid.UUID(auth.user_id), updated_by=uuid.UUID(str(person.id)),
        agent_ids=body.agent_ids, runtime=_keep(body.runtime), model=_keep(body.model), effort=_keep(body.effort),
        unattended=_keep(body.unattended),
        actor_is_owner=await profiles.is_active_owner(db, org_id=org_id, user_id=uuid.UUID(auth.user_id)),
    )
    await db.commit()
    return {"profiles": views}


@router.put("/agents/{agent_id}/run-profile")
async def put_agent_profile(
    agent_id: uuid.UUID,
    body: OneChange,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    person = await _person_session(db, auth, org_id)
    actor_is_owner = await profiles.is_active_owner(db, org_id=org_id, user_id=uuid.UUID(auth.user_id))
    views = await profiles.change(
        db, org_id=org_id, user_id=uuid.UUID(auth.user_id), updated_by=uuid.UUID(str(person.id)),
        agent_ids=[agent_id], runtime=profiles.KEEP if body.runtime is None else body.runtime,
        model=body.model, effort=body.effort,
        unattended=profiles.KEEP if body.unattended is None else body.unattended, actor_is_owner=actor_is_owner,
    )
    await db.commit()
    view = views[0]
    view["can_change"] = True
    view["can_change_unattended"] = actor_is_owner  # story #4598
    return view


@router.delete("/agents/{agent_id}/run-profile/allowed-hosts/{host}")
async def remove_allowed_host(
    agent_id: uuid.UUID,
    host: str,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id_no_project_gate),
):
    """story #4580 — [빼기] on the agent's «허용 주소» list (a person, with the run profile's own rights · idempotent)."""
    person = await _person_session(db, auth, org_id)
    result = await profiles.remove_allowed_host(
        db, org_id=org_id, user_id=uuid.UUID(auth.user_id), updated_by=uuid.UUID(str(person.id)), agent_id=agent_id, host=host,
    )
    await db.commit()
    return result
