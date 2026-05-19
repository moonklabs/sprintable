import os
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import assert_agent_owner
from app.models.pm import Story
from app.models.team import TeamMember
from app.repositories.team_member import TeamMemberRepository
from app.schemas.team_member import (
    ActiveStorySummary, TeamMemberCreate, TeamMemberResponse, TeamMemberUpdate,
)


class ClaimBody(BaseModel):
    story_id: uuid.UUID


async def _inject_active_stories(
    members: list, session: AsyncSession
) -> list[TeamMemberResponse]:
    """AC6: active_story_id → stories batch 조회 후 inject."""
    ids = {m.active_story_id for m in members if m.active_story_id}
    stories: dict[uuid.UUID, Story] = {}
    if ids:
        result = await session.execute(select(Story).where(Story.id.in_(ids)))
        for s in result.scalars().all():
            stories[s.id] = s

    out = []
    for m in members:
        resp = TeamMemberResponse.model_validate(m)
        if m.active_story_id and m.active_story_id in stories:
            s = stories[m.active_story_id]
            resp = resp.model_copy(update={
                "active_story": ActiveStorySummary(id=s.id, title=s.title, status=s.status)
            })
        out.append(resp)
    return out

_FAKECHAT_BASE_PORT = 8787

router = APIRouter(prefix="/api/v2/team-members", tags=["team-members"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TeamMemberRepository:
    return TeamMemberRepository(session, org_id)


@router.get("", response_model=list[TeamMemberResponse])
async def list_team_members(
    project_id: uuid.UUID | None = Query(default=None),
    type_filter: str | None = Query(default=None, alias="type"),
    is_active: bool | None = Query(default=True),
    user_id: uuid.UUID | None = Query(default=None),
    repo: TeamMemberRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> list[TeamMemberResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if type_filter:
        filters["type"] = type_filter
    if is_active is not None:
        filters["is_active"] = is_active
    if user_id:
        filters["user_id"] = user_id
    members = await repo.list(**filters)
    return await _inject_active_stories(members, session)


@router.post("", status_code=201)
async def create_team_member(
    body: TeamMemberCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    repo = TeamMemberRepository(session, body.org_id)
    created_by = uuid.UUID(auth.user_id) if body.type == "agent" else None

    # AC1/AC2: agent 생성 시 fakechat_port 자동 할당 (project 내 중복 방지)
    fakechat_port: int | None = None
    if body.type == "agent":
        existing_ports = {
            r[0] for r in (await session.execute(
                select(TeamMember.fakechat_port).where(
                    TeamMember.project_id == body.project_id,
                    TeamMember.type == "agent",
                    TeamMember.fakechat_port.isnot(None),
                )
            )).all()
        }
        port = _FAKECHAT_BASE_PORT
        while port in existing_ports:
            port += 1
        fakechat_port = port

    member = await repo.create(
        project_id=body.project_id,
        type=body.type,
        name=body.name,
        role=body.role,
        user_id=body.user_id,
        avatar_url=body.avatar_url,
        agent_config=body.agent_config,
        webhook_url=body.webhook_url,
        color=body.color,
        agent_role=body.agent_role,
        created_by=created_by,
        fakechat_port=fakechat_port,
    )

    from app.services.notification_preference_defaults import insert_default_preferences
    await insert_default_preferences(session, member.id, body.type)

    # AC3: agent 생성 시 API key 자동 생성 + response에 포함
    api_key_plaintext: str | None = None
    if body.type == "agent":
        from app.repositories.api_key import ApiKeyRepository
        api_key_repo = ApiKeyRepository(session)
        _api_key_obj, api_key_plaintext = await api_key_repo.create(team_member_id=member.id)

    # AC3: agent 응답에 fakechat_port + mcp_config 포함
    response = TeamMemberResponse.model_validate(member).model_dump()
    if body.type == "agent":
        response["member_id"] = str(member.id)
        # AC6: FAKECHAT_PORT 환경변수 호환 — DB 포트 우선, 없으면 환경변수 fallback
        effective_port = fakechat_port or int(os.environ.get("FAKECHAT_PORT", _FAKECHAT_BASE_PORT))
        response["fakechat_port"] = effective_port
        response["api_key_created"] = bool(api_key_plaintext)
        response["mcp_config"] = {
            "mcpServers": {
                "sprintable": {
                    "type": "sse",
                    "url": f"http://localhost:{effective_port}/sse",
                }
            }
        }
        if api_key_plaintext:
            response["api_key"] = api_key_plaintext

    return response


@router.get("/{id}", response_model=TeamMemberResponse)
async def get_team_member(
    id: uuid.UUID,
    repo: TeamMemberRepository = Depends(_get_repo),
) -> TeamMemberResponse:
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    return TeamMemberResponse.model_validate(member)


@router.patch("/{id}", response_model=TeamMemberResponse)
async def update_team_member(
    id: uuid.UUID,
    body: TeamMemberUpdate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> TeamMemberResponse:
    repo = TeamMemberRepository(session, org_id)
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    if member.type == "agent":
        await assert_agent_owner(id, session, org_id, uuid.UUID(auth.user_id))
    data = body.model_dump(exclude_unset=True)
    updated = await repo.update(id, **data)
    return TeamMemberResponse.model_validate(updated)


@router.patch("/{id}/heartbeat")
async def heartbeat(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """AC1/2: last_seen_at = NOW(), agent_status = online 갱신."""
    repo = TeamMemberRepository(session, org_id)
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    now = datetime.now(timezone.utc)
    await repo.update(id, last_seen_at=now, agent_status="online")
    return {"ok": True, "last_seen_at": now.isoformat()}


@router.post("/{id}/claim")
async def claim_story(
    id: uuid.UUID,
    body: ClaimBody,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """AC1/3: active_story_id 갱신 + story 존재 검증."""
    repo = TeamMemberRepository(session, org_id)
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")

    # AC3: story가 해당 project에 존재하는지 검증
    story_result = await session.execute(
        select(Story).where(Story.id == body.story_id, Story.project_id == member.project_id)
    )
    story = story_result.scalar_one_or_none()
    if story is None:
        raise HTTPException(status_code=400, detail="Story not found in this project")

    now = datetime.now(timezone.utc)
    await repo.update(id, active_story_id=body.story_id, agent_status="online", last_seen_at=now)
    return {"claimed": True, "story_id": str(body.story_id)}


@router.post("/{id}/unclaim")
async def unclaim_story(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """AC2: active_story_id = NULL."""
    repo = TeamMemberRepository(session, org_id)
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    await repo.update(id, active_story_id=None)
    return {"unclaimed": True}


@router.delete("/{id}", status_code=200)
async def deactivate_team_member(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    repo = TeamMemberRepository(session, org_id)
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    if member.type == "agent":
        await assert_agent_owner(id, session, org_id, uuid.UUID(auth.user_id))
    ok = await repo.deactivate(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Team member not found")
    return {"ok": True, "deactivated": True}
