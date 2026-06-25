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
from app.services.agent_onboarding_config import build_agent_mcp_config


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


# org-level 휴먼은 특정 프로젝트에 귀속되지 않는다(org_members SSOT 직접 해소). TeamMemberResponse.
# project_id 가 required 라 nil sentinel 을 둔다 — FE 스탠드업 로스터는 id/name/type 만 읽고
# 휴먼은 project 컬럼을 사용하지 않는다(S:166051f0). 응답 스키마(계약) 변경 0.
_ORG_LEVEL_HUMAN_PROJECT_ID = uuid.UUID(int=0)


def _build_org_human_response(row: dict, org_id: uuid.UUID) -> TeamMemberResponse:
    """org_members 직접 해소 휴먼 행 → TeamMemberResponse (S:166051f0).

    id = org_member.id(canonical 휴먼 신원). presence/active_story/색상 등은 휴먼 무의미 → 기본값.
    """
    now = row.get("created_at") or datetime.now(timezone.utc)
    return TeamMemberResponse(
        id=row["id"],
        project_id=_ORG_LEVEL_HUMAN_PROJECT_ID,
        org_id=org_id,
        user_id=row.get("user_id"),
        type="human",
        name=row["name"],
        role=row["role"],
        avatar_url=row.get("avatar_url"),
        is_active=True,
        color="#3385f8",
        created_at=now,
        updated_at=now,
    )


@router.get("", response_model=list[TeamMemberResponse])
async def list_team_members(
    project_id: uuid.UUID | None = Query(default=None),
    type_filter: str | None = Query(default=None, alias="type"),
    is_active: bool | None = Query(default=True),
    user_id: uuid.UUID | None = Query(default=None),
    repo: TeamMemberRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[TeamMemberResponse]:
    # S:166051f0 — org-level(project_id 없음): 휴먼 = org_members SSOT **직접** 해소
    # (team_members 뷰=members⋈project_access 비의존 → project_access.member_id NULL 인
    # grant-only/owner 휴먼도 포함, 곱연산 0). 에이전트는 기존 뷰(type=agent) 그대로.
    # project-scoped(project_id 지정)는 기존 뷰 경로 무변경 → 다른 consumer 무회귀(AC3).
    if project_id is None:
        result: list[TeamMemberResponse] = []
        if type_filter in (None, "human"):
            human_rows = await repo.list_org_human_members(user_id=user_id)
            result.extend(_build_org_human_response(r, org_id) for r in human_rows)
        if type_filter in (None, "agent"):
            agent_filters: dict = {"type": "agent"}
            if is_active is not None:
                agent_filters["is_active"] = is_active
            if user_id:
                agent_filters["user_id"] = user_id
            agents = await repo.list(**agent_filters)
            result.extend(await _inject_active_stories(agents, session))
        return result

    filters: dict = {"project_id": project_id}
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
    # AC1/AC2: agent actor의 멤버 관리 권한 체크.
    # E-MEMBER-POLICY S4: can_manage_members 플래그 직접 읽기 → effective 프로젝트 역할(has_project_role)
    # 단일 경로로 전환(블루프린트 §6). can_manage_members 는 role 에서 derived(0122 백필 can_manage=
    # true→role admin). owner/admin 이 멤버 관리. 기존 통과자(can_manage=true→admin) 무회귀 +
    # owner/admin 추가 통과(additive).
    actor = await _resolve_actor(auth, session, org_id)
    if actor is not None and actor.type == "agent":
        from app.services.project_auth import has_project_role
        if not await has_project_role(session, actor.id, actor.project_id, min_role="admin"):
            raise HTTPException(status_code=403, detail="project admin/owner role required to manage members")
        # AC3: target.role > actor.role → 403 (격상 차단)
        target_rank = _ROLE_RANK.get(body.role, 1)
        actor_rank = _ROLE_RANK.get(actor.role, 1)
        if target_rank > actor_rank:
            raise HTTPException(status_code=403, detail="Cannot assign role higher than your own")
        # AC4: target.alias(name) == actor.name → 400 (self-replication 차단)
        if body.name == actor.name:
            raise HTTPException(status_code=400, detail="Agent cannot create a member with the same name as itself")

    # S-MBR-02: user_id 있으면 org_members 선행 검증
    if body.user_id is not None:
        from app.models.project import OrgMember
        _org_check = await session.execute(
            select(OrgMember).where(
                OrgMember.org_id == org_id,
                OrgMember.user_id == body.user_id,
                OrgMember.deleted_at.is_(None),
            )
        )
        if _org_check.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=400,
                detail={"code": "USER_NOT_IN_ORG", "message": "먼저 조직에 초대해야 합니다"},
            )

    # Human member 생성은 org invite 플로우로 이전 (E-ENTITY-CLEANUP S4)
    if body.type == "human":
        raise HTTPException(
            status_code=410,
            detail="Human member creation via team-members is deprecated. Use org invites (/api/v2/organizations/{id}/invites) instead.",
        )

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

    # AC3-4 2-2: team_members가 projection 뷰로 강등됨 → INSERT 불가. transient TeamMember(미persist)로
    # 신원/응답을 표현하고, 실제 영속은 앵커(members + agent_project_profiles + project_access)로만 한다.
    now = datetime.now(timezone.utc)
    member = TeamMember(
        id=uuid.uuid4(),
        project_id=body.project_id,
        org_id=org_id,
        type=body.type,
        name=body.name,
        role=body.role,
        user_id=body.user_id,
        avatar_url=body.avatar_url,
        agent_config=body.agent_config,
        color=body.color,
        agent_role=body.agent_role,
        created_by=created_by,
        fakechat_port=fakechat_port,
        is_active=True,
        can_manage_members=False,
        last_seen_at=None,
        active_story_id=None,
        agent_status=None,
        created_at=now,
        updated_at=now,
    )  # NOT session.add — 앵커 write-sync가 유일 영속 경로(아래)

    # E-MEMBER-SSOT AC3-1b/AC3-4 2-2: 신규 agent 앵커 write-sync(members + agent_project_profiles +
    # project_access placement) = 유일 영속 경로. ⚠️ api_key 자동생성(아래)보다 선행 — agent_api_keys.
    # member_id→members FK(0080) 충족 + cut-on 무중단.
    if body.type == "agent":
        from app.services.agent_anchor_sync import sync_agent_anchor_on_create
        await sync_agent_anchor_on_create(session, member, created_by)

    from app.services.notification_preference_defaults import insert_default_preferences
    await insert_default_preferences(session, member.id, body.type)

    # AC5: audit_log에 creator_id, creator_type 기록
    if actor is not None:
        from app.models.audit import AuditLog
        audit = AuditLog(
            org_id=org_id,
            actor_id=actor.id,
            action="member_added",  # CHECK (action IN ('member_added','member_removed','role_changed'))
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
        from app.services.mcp_toolset import ALL_GROUPS
        api_key_repo = ApiKeyRepository(session)
        # 8d02d5e8: 온보딩 에이전트 키도 명시적 툴그룹 scope(전 비파괴 그룹) 부여 — 고급 Tool-permissions
        # UI와 동일 모델로 통일. scope=None(레거시 read/write fallback) 대신 list(ALL_GROUPS) 명시.
        # 동작 동일(resolve_policy None=전체)이나 모델 일관·레거시 표기 제거.
        _api_key_obj, api_key_plaintext = await api_key_repo.create(
            team_member_id=member.id, scope=list(ALL_GROUPS)
        )
        # E-MSG-POLICY S2: creator를 agent allow_list에 자동 등록(같은 트랜잭션·멱등).
        from app.services.agent_message_policy import ensure_creator_allowlisted
        await ensure_creator_allowlisted(session, member.id)

    # AC3: agent 응답에 fakechat_port + mcp_config 포함
    response = TeamMemberResponse.model_validate(member).model_dump()
    if body.type == "agent":
        response["member_id"] = str(member.id)
        # AC6: FAKECHAT_PORT 환경변수 호환 — DB 포트 우선, 없으면 환경변수 fallback
        effective_port = fakechat_port or int(os.environ.get("FAKECHAT_PORT", _FAKECHAT_BASE_PORT))
        response["fakechat_port"] = effective_port
        response["api_key_created"] = bool(api_key_plaintext)
        # OB-1 AC2: 단일 SSOT generator 소비(stdio 아티팩트). 인라인 sse config 제거.
        response["mcp_config"] = build_agent_mcp_config(api_key_plaintext=api_key_plaintext)
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
    # AC3-4 2-2: team_members 뷰 — 필드를 앵커 테이블로 라우팅(anchor-only). expire 후 뷰 재조회로 갱신값 반영.
    await repo.apply_anchor_update(member, data)
    session.expire(member)
    updated = await repo.get(id)
    return TeamMemberResponse.model_validate(updated or member)


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
    # AC3-4 2-2: team_members 뷰 — presence는 agent_project_profiles가 유일 소스(anchor-only).
    from app.services.agent_anchor_sync import sync_agent_profile_presence
    await sync_agent_profile_presence(session, id, last_seen_at=now, agent_status="online")
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
    # AC3-4 2-2: anchor-only — agent_project_profiles가 presence 유일 소스.
    from app.services.agent_anchor_sync import sync_agent_profile_presence
    await sync_agent_profile_presence(session, id, active_story_id=body.story_id, agent_status="online", last_seen_at=now)
    # 3414b6d7: claim=일 시작=실작업자 → implementation participation 멱등 생성(게이트/verdict
    # attribution). assignee(board)는 안 건드림 — participation만(claim만 하고 done해도 평가 가능).
    from app.services.participation_helpers import ensure_implementation_participation
    await ensure_implementation_participation(session, org_id, body.story_id, id)
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
    # AC3-4 2-2: anchor-only — agent_project_profiles가 presence 유일 소스.
    from app.services.agent_anchor_sync import sync_agent_profile_presence
    await sync_agent_profile_presence(session, id, active_story_id=None)
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
