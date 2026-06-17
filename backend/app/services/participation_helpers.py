"""implementation participation 보장 공유 helper (3414b6d7).

assignee 설정(stories.py)·story claim(team_members.py) 양 경로가 동일하게 implementation(default)
역할 participation을 멱등 생성하도록 단일 helper로 추출 — 게이트/verdict attribution의 단일 진입점.
claim만 하고 done해도 participation이 있어야 merge gate가 평가하고 outcome verdict가 귀속된다.
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession


async def ensure_implementation_participation(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    member_id: uuid.UUID,
) -> bool:
    """story에 member의 implementation(default) 역할 participation을 멱등 생성.

    이미 있으면 no-op. default role 미시드면 skip(False). 생성/존재 시 True.
    """
    from app.repositories.participation import (
        ParticipationRepository,
        ParticipationRoleRepository,
    )

    role_repo = ParticipationRoleRepository(session, org_id)
    default_role = await role_repo.get_default()
    if default_role is None:
        return False
    p_repo = ParticipationRepository(session, org_id)
    if not await p_repo.exists(story_id, member_id, default_role.id):
        await p_repo.create(story_id=story_id, member_id=member_id, role_id=default_role.id)
    return True
