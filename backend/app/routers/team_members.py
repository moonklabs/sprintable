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


_ROLE_RANK: dict[str, int] = {"owner": 4, "admin": 3, "manager": 2, "member": 1}


async def _resolve_actor(auth: AuthContext, session: AsyncSession, org_id: uuid.UUID) -> TeamMember | None:
    """auth context → TeamMember 조회. API Key: user_id = member.id, JWT: user_id = supabase user_id."""
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        result = await session.execute(
            select(TeamMember).where(TeamMember.id == uuid.UUID(auth.user_id))
        )
    else:
        result = await session.execute(
            select(TeamMember).where(
                TeamMember.user_id == uuid.UUID(auth.user_id),
                TeamMember.org_id == org_id,
            )
        )
    return result.scalars().first()


@router.post("", status_code=201)
async def create_team_member(
    body: TeamMemberCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    # AC1/AC2: agent actor의 can_manage_members 체크
    actor = await _resolve_actor(auth, session, org_id)
    if actor is not None and actor.type == "agent":
        if not actor.can_manage_members:
            raise HTTPException(status_code=403, detail="Agent does not have can_manage_members permission")
        # AC3: target.role > actor.role → 403 (격상 차단)
        target_rank = _ROLE_RANK.get(body.role, 1)
        actor_rank = _ROLE_RANK.get(actor.role, 1)
        if target_rank > actor_rank:
            raise HTTPException(status_code=403, detail="Cannot assign role higher than your own")
        # AC4: target.alias(name) == actor.name → 400 (self-replication 차단)
        if body.name == actor.name:
            raise HTTPException(status_code=400, detail="Agent cannot create a member with the same name as itself")

    # Human member 생성은 org invite 플로우로 이전 (E-ENTITY-CLEANUP S4)
    if body.type == "human":
        raise HTTPException(
            status_code=410,
            detail="Human member creation via team-members is deprecated. Use org invites (/api/v2/organizations/{id}/invites) instead.",
        )

    repo = TeamMemberRepository(session, org_id)
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

    # AC5: audit_log에 creator_id, creator_type 기록
    if actor is not None:
        from app.models.audit import AuditLog
        audit = AuditLog(
            org_id=org_id,
            actor_id=actor.id,
            action="team_member.create",
            target_user_id=member.id,
            audit_metadata={
                "creator_id": str(actor.id),
                "creator_type": actor.type,
                "target_type": member.type,
                "target_role": member.role,
            },
        )
        session.add(audit)

    # AP-S2: agent가 agent를 생성한 경우 owner/admin human에게 알림 발송
    if actor is not None and actor.type == "agent" and member.type == "agent":
        from app.services.notification_dispatch import dispatch_notification
        admin_result = await session.execute(
            select(TeamMember.id).where(
                TeamMember.org_id == org_id,
                TeamMember.type == "human",
                TeamMember.role.in_(["owner", "admin"]),
                TeamMember.is_active.is_(True),
            )
        )
        admin_ids = [row[0] for row in admin_result.all()]
        if admin_ids:
            await dispatch_notification(
                session,
                org_id=org_id,
                event_type="agent_joined",
                target_member_ids=admin_ids,
                title=f"새 에이전트 합류: {member.name}",
                body=f"{actor.name}(에이전트)이 {member.name}을 생성했습니다.",
                reference_type="team_member",
                reference_id=member.id,
            )

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
    """AC2: active_story_id = NULL. AC7: file lock 자동 해제."""
    repo = TeamMemberRepository(session, org_id)
    member = await repo.get(id)
    if member is None:
        raise HTTPException(status_code=404, detail="Team member not found")
    await repo.update(id, active_story_id=None)
    # AC7: unclaim 시 해당 멤버의 모든 file lock 해제
    from app.routers.file_locks import release_all_file_locks
    await release_all_file_locks(session, id)
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
