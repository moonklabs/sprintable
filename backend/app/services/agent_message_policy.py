"""E-MSG-POLICY S2: agent API 키 생성 시 creator를 agent_message_allowlist에 자동 등록.

creator는 list 모드에서도 항상 DM 가능해야 한다(S1 enforcement의 is_creator가 user_id로 이미 보장하나,
allowlist에 **명시 entry**를 둬 SSOT/관리 UI(S3)에 creator가 노출되게 한다).

allowed_id = agent의 owner_member_id(= 생성 휴먼의 member.id, agent_anchor_sync가 created_by→org_member.id로
세팅). enforcement가 참가자 member_id와 매칭하는 값과 동일 도메인이라 정합.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.member import Member
from app.models.team import AgentMessageAllowlist, TeamMember


async def ensure_creator_allowlisted(session: AsyncSession, agent_member_id: uuid.UUID) -> bool:
    """agent의 creator(owner)를 agent_message_allowlist에 멱등 등록. 등록(or 이미 존재) 시 True.

    - owner_member_id 없으면(=creator 미상) skip(False). is_creator(user_id)가 enforcement는 커버.
    - unique(agent_member_id, allowed_id)로 멱등 — 키 재생성/rotate 시 중복 없음, 기존 entry 보존.
    """
    row = (await session.execute(
        select(Member.owner_member_id, Member.org_id).where(Member.id == agent_member_id)
    )).first()
    if row is None or row.owner_member_id is None:
        return False
    owner_member_id, org_id = row.owner_member_id, row.org_id
    await session.execute(
        pg_insert(AgentMessageAllowlist)
        .values(
            id=uuid.uuid4(),
            agent_member_id=agent_member_id,
            allowed_id=owner_member_id,
            org_id=org_id,
        )
        .on_conflict_do_nothing(constraint="uq_agent_message_allowlist_pair")
    )
    return True


async def policy_denial(db: AsyncSession, agent_tm: TeamMember, humans: list[tuple[uuid.UUID, uuid.UUID | None]]) -> dict | None:
    """E-MSG-POLICY S1 — whether a conversation of this agent with these people (member id, user id) is refused, and why. `None` = allowed.

    story 4714: moved here from `conversations._enforce_agent_creator_policy` unchanged, so the conversation endpoints and the phone's start list
    (which must not offer an agent the person could not open a conversation with) decide with ONE function. The answer is the 403's `message` and
    `details` (`reason`: allowlist_miss · created_by_none · creator_not_participant).

    - org_wide: every person of the organization may.
    - list: a person on the agent's allowlist, or the agent's creator (always).
    - creator_only (the default): the agent's creator must be one of the people.
    """
    mode = getattr(agent_tm, "message_policy_mode", None) or "creator_only"
    if mode == "org_wide":
        return None
    if mode == "list":
        allowed_ids = set((await db.execute(
            select(AgentMessageAllowlist.allowed_id).where(AgentMessageAllowlist.agent_member_id == agent_tm.id)
        )).scalars().all())
        for member_id, user_id in humans:
            is_creator = user_id is not None and user_id == agent_tm.created_by  # the creator may in every mode
            if member_id not in allowed_ids and not is_creator:
                return {
                    "message": "Member is not in this agent's message allowlist",
                    "details": {"agent_id": str(agent_tm.id), "member_id": str(member_id), "reason": "allowlist_miss"},
                }
        return None
    if agent_tm.created_by is None:
        return {
            "message": "Agent has no creator — conversation not allowed",
            "details": {"agent_id": str(agent_tm.id), "reason": "created_by_none"},
        }
    if agent_tm.created_by not in {u for _, u in humans if u}:
        return {
            "message": "Agent's creator must be a participant in this conversation",
            "details": {"agent_id": str(agent_tm.id), "reason": "creator_not_participant"},
        }
    return None
