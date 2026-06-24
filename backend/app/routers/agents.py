"""S3 (org-level 멀티프로젝트 에이전트): org 범위 에이전트 생성 엔드포인트.

`POST /api/v2/agents` — 단일 project 종속(team-members create)과 달리 scope_mode 로 프로젝트
집합을 받아 members/api_key 1개 + N 프로젝트 grant 를 fan-out 한다(빌링=에이전트 1카운트).
인가/권한 규칙은 create_team_member 와 동일(agent actor can_manage_members + role rank + self-name).

블루프린트 docs/org-level-agent-multiproject-blueprint.md §4 G3 / §5.
"""
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.project import Project
from app.schemas.team_member import OrgAgentCreate, TeamMemberResponse
from app.services.org_agent import create_org_level_agent

router = APIRouter(prefix="/api/v2/agents", tags=["agents"])

_FAKECHAT_BASE_PORT = 8787


async def _resolve_org_project_ids(
    body: OrgAgentCreate, session: AsyncSession, org_id: uuid.UUID
) -> list[uuid.UUID]:
    """scope_mode → grant 대상 프로젝트 id 리스트(org 소속·≥1·중복제거·순서보존)."""
    org_projects = [
        r[0]
        for r in (
            await session.execute(
                select(Project.id)
                .where(Project.org_id == org_id, Project.deleted_at.is_(None))
                .order_by(Project.created_at.asc())
            )
        ).all()
    ]
    if body.scope_mode == "org":
        # v1: 현재 org 의 모든 프로젝트. 미래 프로젝트 자동 grant 는 follow-up(project-create 훅).
        project_ids = org_projects
    elif body.scope_mode == "projects":
        if not body.project_ids:
            raise HTTPException(status_code=400, detail="project_ids required when scope_mode='projects'")
        valid = set(org_projects)
        invalid = [str(p) for p in body.project_ids if p not in valid]
        if invalid:
            raise HTTPException(status_code=400, detail=f"project_ids not in org: {invalid}")
        seen: set[uuid.UUID] = set()
        project_ids = []
        for p in body.project_ids:  # 순서 보존 + 중복 제거
            if p not in seen:
                seen.add(p)
                project_ids.append(p)
    else:
        raise HTTPException(status_code=400, detail="scope_mode must be 'org' or 'projects'")

    if not project_ids:
        raise HTTPException(status_code=400, detail="org has no projects to grant the agent into")
    return project_ids


def _build_mcp_config(effective_port: int, api_key_plaintext: str | None) -> dict:
    """온보딩 응답의 mcp_config. E-MCP-HTTP prod 승격: env MCP_PUBLIC_URL(prod 게이트웨이 /mcp) 설정 시
    streamable-http(type:"http"·per-request Bearer)·미설정(dev/로컬)이면 기존 localhost SSE(무회귀).
    http 모드 실인증=per-request bearer(=발급 api_key)라 키 있을 때만 Authorization 헤더 포함."""
    mcp_public_url = os.environ.get("MCP_PUBLIC_URL", "").strip()
    if mcp_public_url:
        server: dict = {"type": "http", "url": mcp_public_url}
        if api_key_plaintext:
            server["headers"] = {"Authorization": f"Bearer {api_key_plaintext}"}
        return {"mcpServers": {"sprintable": server}}
    return {
        "mcpServers": {
            "sprintable": {"type": "sse", "url": f"http://localhost:{effective_port}/sse"}
        }
    }


@router.post("", status_code=201)
async def create_org_agent(
    body: OrgAgentCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """org-level 에이전트 생성 + scope_mode 프로젝트 집합 grant. 응답에 api_key 1회 노출."""
    # 권한: create_team_member 와 동일 규칙 재사용(agent actor 제약).
    from app.routers.team_members import _ROLE_RANK, _resolve_actor

    actor = await _resolve_actor(auth, session, org_id)
    if actor is not None and actor.type == "agent":
        # S4: can_manage_members → has_project_role(min='admin') 단일 경로(role 에서 derived).
        from app.services.project_auth import has_project_role
        if not await has_project_role(session, actor.id, actor.project_id, min_role="admin"):
            raise HTTPException(status_code=403, detail="project admin/owner role required to manage members")
        if _ROLE_RANK.get(body.role, 1) > _ROLE_RANK.get(actor.role, 1):
            raise HTTPException(status_code=403, detail="Cannot assign role higher than your own")
        if body.name == actor.name:
            raise HTTPException(status_code=400, detail="Agent cannot create a member with the same name as itself")

    project_ids = await _resolve_org_project_ids(body, session, org_id)

    created_by = uuid.UUID(auth.user_id)  # 휴먼=user_id / 에이전트=member.id (anchor sync 가 휴먼만 owner 매칭)
    member, api_key_plaintext = await create_org_level_agent(
        session,
        org_id=org_id,
        created_by=created_by,
        name=body.name,
        role=body.role,
        agent_config=body.agent_config,
        agent_role=body.agent_role,
        color=body.color,
        avatar_url=body.avatar_url,
        project_ids=project_ids,
    )

    response = TeamMemberResponse.model_validate(member).model_dump()
    response["member_id"] = str(member.id)
    response["project_ids"] = [str(p) for p in project_ids]
    response["scope_mode"] = body.scope_mode
    effective_port = member.fakechat_port or int(os.environ.get("FAKECHAT_PORT", _FAKECHAT_BASE_PORT))
    response["fakechat_port"] = effective_port
    response["api_key_created"] = bool(api_key_plaintext)
    response["mcp_config"] = _build_mcp_config(effective_port, api_key_plaintext)
    if api_key_plaintext:
        response["api_key"] = api_key_plaintext
    return response
