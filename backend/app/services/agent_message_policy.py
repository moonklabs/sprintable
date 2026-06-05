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
from app.models.team import AgentMessageAllowlist


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
