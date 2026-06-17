"""S3 (org-level 멀티프로젝트 에이전트): org 범위 에이전트 1개 생성 + N 프로젝트 grant fan-out.

members/api_key 는 **1회만** 생성하고(빌링=에이전트 1카운트), project_ids 전체에 per-project
앵커(agent_project_profiles + project_access grant)를 멱등 write 한다. project_ids[0] 를 앵커
프로젝트로 기존 `sync_agent_anchor_on_create`(members+profile+grant)를 태우고, 나머지는
`write_agent_project_placement`(profile+grant)만 추가한다 — members 중복 생성 0(identity 안정).

블루프린트 docs/org-level-agent-multiproject-blueprint.md §4 G3.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.team import TeamMember
from app.services.agent_anchor_sync import (
    sync_agent_anchor_on_create,
    write_agent_project_placement,
)

_FAKECHAT_BASE_PORT = 8787


async def _allocate_fakechat_port(session: AsyncSession, project_id: uuid.UUID) -> int:
    """프로젝트 내 미사용 fakechat 포트 — create_team_member 와 동일 규칙(프로젝트별 유일)."""
    existing = {
        r[0]
        for r in (
            await session.execute(
                select(TeamMember.fakechat_port).where(
                    TeamMember.project_id == project_id,
                    TeamMember.type == "agent",
                    TeamMember.fakechat_port.isnot(None),
                )
            )
        ).all()
    }
    port = _FAKECHAT_BASE_PORT
    while port in existing:
        port += 1
    return port


async def create_org_level_agent(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    created_by: uuid.UUID | None,
    name: str,
    role: str = "member",
    agent_config: dict | None = None,
    agent_role: str | None = None,
    color: str = "#3385f8",
    avatar_url: str | None = None,
    project_ids: list[uuid.UUID],
) -> tuple[TeamMember, str | None]:
    """org-level 에이전트 1개 생성 후 project_ids 전체에 grant fan-out.

    project_ids 는 호출부에서 **org 소속·≥1·중복제거** 검증 완료를 가정(순서 보존). 반환:
    (transient TeamMember, api_key 평문). 영속은 앵커 write-sync(members/profile/grant)·api_key
    로만 — get_db 가 커밋한다(엔드포인트 명시 커밋 없음).
    """
    if not project_ids:
        raise ValueError("project_ids must be non-empty")

    anchor_project = project_ids[0]
    now = datetime.now(timezone.utc)
    member = TeamMember(
        id=uuid.uuid4(),
        project_id=anchor_project,
        org_id=org_id,
        type="agent",
        name=name,
        role=role,
        user_id=None,
        avatar_url=avatar_url,
        agent_config=agent_config,
        color=color,
        agent_role=agent_role,
        created_by=created_by,
        fakechat_port=await _allocate_fakechat_port(session, anchor_project),
        is_active=True,
        can_manage_members=False,
        last_seen_at=None,
        active_story_id=None,
        agent_status=None,
        created_at=now,
        updated_at=now,
    )  # NOT session.add — 앵커 write-sync 가 유일 영속 경로

    # 앵커 프로젝트: members + agent_project_profiles + project_access grant
    await sync_agent_anchor_on_create(session, member, created_by)

    # 추가 프로젝트: per-project placement(profile + grant)만 — members 는 위에서 1회 생성됨.
    for pid in project_ids[1:]:
        await write_agent_project_placement(
            session,
            member_id=member.id,
            project_id=pid,
            agent_config=agent_config,
            agent_role=agent_role,
            fakechat_port=await _allocate_fakechat_port(session, pid),
            role=role,
            color=color,
            can_manage_members=False,
        )
    await session.flush()

    # default 알림 설정(멤버당 1회)
    from app.services.notification_preference_defaults import insert_default_preferences

    await insert_default_preferences(session, member.id, "agent")

    # API key 1개(전 비파괴 툴그룹 scope) — create_team_member 와 동일 모델
    from app.repositories.api_key import ApiKeyRepository
    from app.services.mcp_toolset import ALL_GROUPS

    _key, api_key_plaintext = await ApiKeyRepository(session).create(
        team_member_id=member.id, scope=list(ALL_GROUPS)
    )

    # 생성자를 agent allow_list 에 자동 등록(멱등)
    from app.services.agent_message_policy import ensure_creator_allowlisted

    await ensure_creator_allowlisted(session, member.id)

    return member, api_key_plaintext
