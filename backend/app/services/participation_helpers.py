"""implementation participation 보장 공유 helper (3414b6d7).

assignee 설정(stories.py)·story claim(team_members.py) 양 경로가 동일하게 implementation(default)
역할 participation을 멱등 생성하도록 단일 helper로 추출 — 게이트/verdict attribution의 단일 진입점.
claim만 하고 done해도 participation이 있어야 merge gate가 평가하고 outcome verdict가 귀속된다.
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

# org 생성 시드용 default 역할 — 실DB 테스트(test_claim_participation.py)가 쓰는 canonical
# key와 동일. merge gate/verdict attribution의 role_key로 그대로 흐른다.
DEFAULT_PARTICIPATION_ROLE_KEY = "implementation"
DEFAULT_PARTICIPATION_ROLE_LABEL = "구현"


async def seed_default_participation_role(session: AsyncSession, org_id: uuid.UUID) -> bool:
    """빈 org에 default implementation 역할을 시드(멱등). 생성 시 True.

    participation_role이 org별로 0행이면 ensure_implementation_participation이 skip →
    merge gate가 "no implementation participation"으로 gate row 없이 영구 ask_human(교착).
    org 생성 시 이 시드를 태워 fresh 설치에서 게이트 attribution이 성립하게 한다.
    역할이 하나라도 있는 org는 명시 설정으로 보고 건드리지 않는다(default 부재 포함).
    """
    from sqlalchemy import select
    from sqlalchemy.exc import IntegrityError

    from app.models.participation import ParticipationRole

    existing = await session.execute(
        select(ParticipationRole.id).where(ParticipationRole.org_id == org_id).limit(1)
    )
    if existing.scalar_one_or_none() is not None:
        return False
    try:
        # 동시 org-create 경합은 uq(org_id, key)가 잡는다 — SAVEPOINT로 세션 오염 없이 흡수.
        async with session.begin_nested():
            session.add(ParticipationRole(
                id=uuid.uuid4(),
                org_id=org_id,
                key=DEFAULT_PARTICIPATION_ROLE_KEY,
                label=DEFAULT_PARTICIPATION_ROLE_LABEL,
                is_default=True,
            ))
        return True
    except IntegrityError:
        return False


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
