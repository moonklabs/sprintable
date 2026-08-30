"""E-MSG-POLICY S3 (BE): 에이전트 메시징 정책 관리 endpoints.

agent별 mode(creator_only/org_wide/list) 조회·변경 + allow_list 멤버 add/remove.
assert_agent_owner 게이트 — **에이전트 생성자 OR org admin/owner**(org-scoped). story
#3231 4라운드(카디르 QA) — 이 파일 헤더가 예전엔 "admin/owner-only"라고 적어놨었는데
부정확했다(assert_agent_owner 자체가 창작자를 admin/owner와 OR로 통과시킴) — 실제로
그 부정확한 서술을 그대로 믿고 Member가 만든 에이전트의 allowlist 피커를 org-admin
전용으로 잘못 잠갔던 게 회귀 원인이었다. S1 enforcement가 즉시 반영(다음
conversation-create부터). mode는 canonical `members`에 저장(team_members는 0088
projection 뷰라 직접 UPDATE 불가).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import assert_agent_owner
from app.models.member import Member
from app.models.team import AgentMessageAllowlist
from app.schemas.org_member import OrgMemberResponse
from app.services.member_resolver import resolve_member_identity

router = APIRouter(prefix="/api/v2", tags=["agent-message-policy", "Organization"])

_VALID_MODES = ("creator_only", "org_wide", "list")


class MessagePolicyResponse(BaseModel):
    agent_id: uuid.UUID
    mode: str
    allowlist: list[uuid.UUID]


class UpdateModeRequest(BaseModel):
    mode: str

    @field_validator("mode")
    @classmethod
    def _valid_mode(cls, v: str) -> str:
        if v not in _VALID_MODES:
            raise ValueError(f"mode must be one of {list(_VALID_MODES)}")
        return v


class AllowlistAddRequest(BaseModel):
    member_id: uuid.UUID


async def _allowlist_ids(session: AsyncSession, agent_id: uuid.UUID) -> list[uuid.UUID]:
    rows = (await session.execute(
        select(AgentMessageAllowlist.allowed_id).where(
            AgentMessageAllowlist.agent_member_id == agent_id
        )
    )).scalars().all()
    return list(rows)


@router.get("/agents/{agent_id}/message-policy", response_model=MessagePolicyResponse)
async def get_message_policy(
    agent_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> MessagePolicyResponse:
    agent = await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))
    return MessagePolicyResponse(
        agent_id=agent_id,
        mode=getattr(agent, "message_policy_mode", None) or "creator_only",
        allowlist=await _allowlist_ids(session, agent_id),
    )


@router.get("/agents/{agent_id}/message-policy/candidates", response_model=list[OrgMemberResponse])
async def list_message_policy_candidates(
    agent_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[OrgMemberResponse]:
    """story #3231 4라운드(카디르 QA) — messaging-policy-section.tsx의 allowlist 추가
    피커가 org-admin 전용 GET /api/v2/org-members(3231 1라운드)에 막혀, Member가 만든
    에이전트는 그 생성자 본인이 자기 allowlist 후보를 못 봤다(신규 회귀 — 위 헤더의
    "admin/owner-only" 서술이 실은 부정확했던 게 근본원인). 이 위(get/update/allowlist)
    엔드포인트들과 동일 게이트(assert_agent_owner=생성자 OR org admin/owner)를 재사용해
    이 특정 agent_id의 소유자에게만 org 로스터를 준다.
    """
    await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))
    result = await session.execute(
        text(
            """
            SELECT om.id, om.org_id, om.user_id, om.role,
                   om.created_at, om.deleted_at,
                   u.email,
                   COALESCE(m.name, u.display_name, u.email) AS name
            FROM org_members om
            LEFT JOIN users u ON u.id = om.user_id
            LEFT JOIN members m
                   ON m.org_id = om.org_id AND m.user_id = om.user_id
                  AND m.type = 'human' AND m.deleted_at IS NULL
            WHERE om.org_id = :org_id AND om.deleted_at IS NULL
            ORDER BY om.created_at
            """
        ),
        {"org_id": str(org_id)},
    )
    return [
        OrgMemberResponse(
            id=row.id,
            org_id=row.org_id,
            user_id=row.user_id,
            role=row.role,
            created_at=row.created_at,
            deleted_at=row.deleted_at,
            email=row.email,
            name=row.name,
        )
        for row in result
    ]


@router.put("/agents/{agent_id}/message-policy", response_model=MessagePolicyResponse)
async def update_message_policy(
    agent_id: uuid.UUID,
    body: UpdateModeRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> MessagePolicyResponse:
    await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))
    # team_members는 뷰 → canonical members.id에 UPDATE (뷰가 투영).
    await session.execute(
        update(Member).where(Member.id == agent_id).values(message_policy_mode=body.mode)
    )
    await session.commit()
    return MessagePolicyResponse(
        agent_id=agent_id, mode=body.mode, allowlist=await _allowlist_ids(session, agent_id)
    )


@router.post("/agents/{agent_id}/message-policy/allowlist", status_code=201,
             response_model=MessagePolicyResponse)
async def add_allowlist_member(
    agent_id: uuid.UUID,
    body: AllowlistAddRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> MessagePolicyResponse:
    agent = await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))
    # 대상이 같은 org의 멤버인지 검증(grant-only 휴먼 포함).
    target = await resolve_member_identity(body.member_id, org_id, session)
    if target is None:
        raise HTTPException(status_code=404, detail="Member not found in org")
    await session.execute(
        pg_insert(AgentMessageAllowlist)
        .values(id=uuid.uuid4(), agent_member_id=agent_id, allowed_id=body.member_id, org_id=org_id)
        .on_conflict_do_nothing(constraint="uq_agent_message_allowlist_pair")  # 멱등
    )
    await session.commit()
    return MessagePolicyResponse(
        agent_id=agent_id,
        mode=getattr(agent, "message_policy_mode", None) or "creator_only",
        allowlist=await _allowlist_ids(session, agent_id),
    )


@router.delete("/agents/{agent_id}/message-policy/allowlist/{member_id}",
               response_model=MessagePolicyResponse)
async def remove_allowlist_member(
    agent_id: uuid.UUID,
    member_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> MessagePolicyResponse:
    agent = await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))
    await session.execute(
        sa_delete(AgentMessageAllowlist).where(
            AgentMessageAllowlist.agent_member_id == agent_id,
            AgentMessageAllowlist.allowed_id == member_id,
        )
    )
    await session.commit()
    return MessagePolicyResponse(
        agent_id=agent_id,
        mode=getattr(agent, "message_policy_mode", None) or "creator_only",
        allowlist=await _allowlist_ids(session, agent_id),
    )
