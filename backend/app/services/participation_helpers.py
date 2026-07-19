"""implementation participation 보장 공유 helper (3414b6d7).

assignee 설정(stories.py)·story claim(team_members.py) 양 경로가 동일하게 implementation(default)
역할 participation을 멱등 생성하도록 단일 helper로 추출 — 게이트/verdict attribution의 단일 진입점.
claim만 하고 done해도 participation이 있어야 merge gate가 평가하고 outcome verdict가 귀속된다.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# SPR-35: lazy 시드용 default 역할. 신규 org에 이 역할이 없으면 claim/assignee가 participation을
# 못 만들고, participation이 없으면 merge gate가 아예 실체화되지 않는다(게이트 없이 auto done).
DEFAULT_IMPLEMENTATION_ROLE_KEY = "implementation"
DEFAULT_IMPLEMENTATION_ROLE_LABEL = "구현"


async def _lazy_seed_default_role(session: AsyncSession, org_id: uuid.UUID):
    """default participation 역할 lazy 시드(SPR-35) — 시드된(또는 경쟁자가 시드한) 역할 반환.

    'implementation' key 역할이 이미 있는데 default가 아니면 org의 명시 설정으로 보고 None
    (건드리지 않음 — 기존 skip 동작 보존). 그 외(역할 자체가 없음)에만 생성. 동시 claim 경쟁은
    (org_id, key) 유니크 제약(uq_participation_role_org_key) + ON CONFLICT DO NOTHING으로
    흡수하고 재조회로 수렴한다.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.participation import ParticipationRole

    key_role = (await session.execute(
        select(ParticipationRole).where(
            ParticipationRole.org_id == org_id,
            ParticipationRole.key == DEFAULT_IMPLEMENTATION_ROLE_KEY,
        ).limit(1)
    )).scalar_one_or_none()
    if key_role is not None:
        # 명시 비-default implementation 역할 — org 의도 존중, is_default를 뒤집지 않는다.
        return key_role if key_role.is_default else None

    await session.execute(
        pg_insert(ParticipationRole).values(
            id=uuid.uuid4(), org_id=org_id,
            key=DEFAULT_IMPLEMENTATION_ROLE_KEY,
            label=DEFAULT_IMPLEMENTATION_ROLE_LABEL,
            is_default=True,
        ).on_conflict_do_nothing(index_elements=["org_id", "key"])
    )
    return (await session.execute(
        select(ParticipationRole).where(
            ParticipationRole.org_id == org_id,
            ParticipationRole.key == DEFAULT_IMPLEMENTATION_ROLE_KEY,
        ).limit(1)
    )).scalar_one_or_none()


async def ensure_implementation_participation(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    member_id: uuid.UUID,
) -> bool:
    """story에 member의 implementation(default) 역할 participation을 멱등 생성.

    이미 있으면 no-op. default role 미시드면 **lazy 시드**(SPR-35 — 신규 org 온보딩 갭 자가
    치유; 명시 비-default implementation 역할이 있으면 존중해 기존처럼 skip=False). 생성/존재
    시 True.
    """
    from app.repositories.participation import (
        ParticipationRepository,
        ParticipationRoleRepository,
    )

    role_repo = ParticipationRoleRepository(session, org_id)
    default_role = await role_repo.get_default()
    if default_role is None:
        default_role = await _lazy_seed_default_role(session, org_id)
    if default_role is None:
        return False
    p_repo = ParticipationRepository(session, org_id)
    if not await p_repo.exists(story_id, member_id, default_role.id):
        await p_repo.create(story_id=story_id, member_id=member_id, role_id=default_role.id)
    return True
