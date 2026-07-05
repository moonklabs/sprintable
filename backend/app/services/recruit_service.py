"""E-RECRUIT S3 (story ff2996d0): POST /recruit MVP 오케스트레이션.

role_template + runtime → (S2) 합성 지침 + persona upsert(G7) + role-derived scope 로 API key
회전(G2/G3) + 활성화 번들(mcp_config + 실 key 1회) 반환. compose_prompt 자체는 순수(S2 G4)라
이 서비스가 그 순수 함수를 실 DB 상태(role_template/recipe/persona/key)에 배선하는 접합부다.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.role_template import RoleTemplate
from app.repositories.agent_persona import AgentPersonaRepository
from app.repositories.api_key import ApiKeyRepository
from app.schemas.agent_persona import PersonaSummaryResponse
from app.services.agent_recruiter import compose_prompt, validate_tool_groups


async def get_published_role_template(session: AsyncSession, slug: str) -> RoleTemplate | None:
    result = await session.execute(
        select(RoleTemplate).where(RoleTemplate.slug == slug, RoleTemplate.is_published.is_(True))
    )
    return result.scalar_one_or_none()


async def resolve_recipe_by_slug(session: AsyncSession, slug: str | None) -> dict[str, Any] | None:
    """role_template.default_workflow_recipe_slug → workflow_recipes 형태 dict(builtin 또는 DB)."""
    if not slug:
        return None
    from app.models.workflow_template import WorkflowTemplate
    from app.routers.workflow_recipes import _BUILTIN_BY_ID, _template_to_recipe

    if slug in _BUILTIN_BY_ID:
        return _BUILTIN_BY_ID[slug]
    result = await session.execute(
        select(WorkflowTemplate).where(
            WorkflowTemplate.slug == slug, WorkflowTemplate.is_enabled.is_(True)
        )
    )
    template = result.scalar_one_or_none()
    return _template_to_recipe(template) if template else None


async def _rotate_or_create_key(
    session: AsyncSession, *, agent_id: uuid.UUID, scope: list[str]
) -> tuple[Any, str]:
    """recruit은 매 호출(신규·재채용 무관)마다 에이전트의 활성 키를 role-derived scope 로 회전한다
    — 신규 채용도 ``POST /agents`` 가 만든 ALL_GROUPS 기본 키를 role scope 로 좁히는 게 맞다(G2/G3:
    scope 는 항상 default_tool_groups 파생 하나여야 하고, 채용 후에도 더 넓은 키가 살아있으면 G3
    단일소스 원칙이 깨진다)."""
    key_repo = ApiKeyRepository(session)
    keys = await key_repo.list_by_member(agent_id)
    active = next((k for k in keys if k.revoked_at is None), None)
    if active is not None:
        result = await key_repo.rotate(active.id, scope=scope)
        assert result is not None  # active 조회 직후 rotate — 레이스 없는 한 항상 존재
        return result
    return await key_repo.create(team_member_id=agent_id, scope=scope)


async def recruit_agent(
    session: AsyncSession,
    *,
    agent_member: Any,
    org_id: uuid.UUID,
    role_template: RoleTemplate,
    runtime: str,
    actor_id: uuid.UUID,
) -> dict[str, Any]:
    """recruit 본체 — 반환: ``{persona, api_key_plaintext, tool_allowlist}``.

    QA MINOR 하드닝(S2에서 명시 유보된 부분의 소비 지점): ``validate_tool_groups``를 어떤 write
    (persona/key)도 하기 전에 먼저 호출 — role_template.default_tool_groups 가 오염돼 있으면
    ``resolve_policy``의 미인식-그룹 fail-open(전체 비파괴 허용)으로 새는 걸 fail-closed 로 막는다.
    """
    tool_allowlist = list(role_template.default_tool_groups)
    validate_tool_groups(tool_allowlist)  # fail-closed — ValueError 전파, 호출부가 400 매핑

    recipe = await resolve_recipe_by_slug(session, role_template.default_workflow_recipe_slug)
    system_prompt = compose_prompt(role_template, recipe, runtime)

    persona_repo = AgentPersonaRepository(session)
    existing = await persona_repo.get_recruited(org_id, agent_member.project_id, agent_member.id)

    if existing is not None:
        persona: PersonaSummaryResponse = await persona_repo.update(
            existing.id, org_id, agent_member.project_id, actor_id,
            name=role_template.name,
            slug=role_template.slug,
            description=role_template.description,
            system_prompt=system_prompt,
            tool_allowlist=tool_allowlist,
            role_template_id=role_template.id,
            is_default=True,
        )
    else:
        persona = await persona_repo.create(
            org_id=org_id,
            project_id=agent_member.project_id,
            agent_id=agent_member.id,
            actor_id=actor_id,
            name=role_template.name,
            slug=role_template.slug,
            description=role_template.description,
            system_prompt=system_prompt,
            tool_allowlist=tool_allowlist,
            role_template_id=role_template.id,
            is_default=True,
        )

    _new_key, api_key_plaintext = await _rotate_or_create_key(
        session, agent_id=agent_member.id, scope=tool_allowlist
    )

    return {
        "persona": persona,
        "api_key_plaintext": api_key_plaintext,
        "tool_allowlist": tool_allowlist,
    }
