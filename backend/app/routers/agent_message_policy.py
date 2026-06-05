"""E-MSG-POLICY S3 (BE): 에이전트 메시징 정책 관리 endpoints.

agent별 mode(creator_only/org_wide/list) 조회·변경 + allow_list 멤버 add/remove.
admin/owner-only(assert_agent_owner)·org-scoped. S1 enforcement가 즉시 반영(다음 conversation-create부터).
mode는 canonical `members`에 저장(team_members는 0088 projection 뷰라 직접 UPDATE 불가).
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import assert_agent_owner
from app.models.member import Member
from app.models.team import AgentMessageAllowlist
from app.services.member_resolver import resolve_member_identity

router = APIRouter(prefix="/api/v2", tags=["agent-message-policy"])

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
