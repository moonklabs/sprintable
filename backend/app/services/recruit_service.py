"""E-RECRUIT S3 (story ff2996d0): POST /recruit MVP 오케스트레이션.

role_template + runtime → (S2) 합성 kit + persona upsert(G7) + role-derived scope 로 API key
회전(G2/G3) + 활성화 번들(mcp_config + 실 key 1회) 반환. compose_kit 자체는 순수(S2 G4)라
이 서비스가 그 순수 함수를 실 DB 상태(role_template/persona/key)에 배선하는 접합부다.

채용-kit 재설계(story b1fe41cf, 선생님 GO 2026-07-08) 이후: recipe DATA는 더 이상 kit
합성에 쓰이지 않는다(워크플로는 유저것 — `sprintable_get_workflow_guide` 자가-pull로 대체,
크럭스 결정①) — 이 파일이 예전에 갖고 있던 ``resolve_recipe_by_slug()``는 그래서 삭제됐다
(다른 소비자 없음 확인, 죽은 코드 방치 안 함).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.role_template import RoleTemplate
from app.repositories.agent_persona import AgentPersonaRepository
from app.repositories.api_key import ApiKeyRepository
from app.schemas.agent_persona import PersonaSummaryResponse
from app.services.agent_recruiter import compose_kit, validate_tool_groups
from app.services.model_family import render_kit_for_family, resolve_model_family


async def get_published_role_template(session: AsyncSession, slug: str) -> RoleTemplate | None:
    result = await session.execute(
        select(RoleTemplate).where(RoleTemplate.slug == slug, RoleTemplate.is_published.is_(True))
    )
    return result.scalar_one_or_none()


async def acquire_agent_mutation_lock(session: AsyncSession, agent_id: uuid.UUID) -> None:
    """까심 QA 재QA 잔여1건(S3, 크로스엔드포인트 레이스): ``recruit_agent()``와 standalone
    ``POST /api-keys/rotate``(``api_keys.py``)가 같은 키를 동시 rotate하면, advisory lock이
    recruit 본문에만 걸려 있어 standalone 쪽이 락 없이 끼어들어 CAS 를 이겼다. 두 진입점이 반드시
    **같은 네임스페이스 문자열**로 이 함수를 호출해야 서로 직렬화된다(데이터는 그때도 안전했지만
    —패배 트랜잭션 롤백— 정상 요청이 500 으로 크래시하는 게 문제였음). PO 선호안(a): 양쪽 다 감싼다."""
    await session.execute(
        select(func.pg_advisory_xact_lock(func.hashtext(f"recruit_agent:{agent_id}")))
    )


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
    locale: str = "ko",
) -> dict[str, Any]:
    """recruit 본체 — 반환: ``{persona, api_key_plaintext, tool_allowlist}``.

    QA MINOR 하드닝(S2에서 명시 유보된 부분의 소비 지점): ``validate_tool_groups``를 어떤 write
    (persona/key)도 하기 전에 먼저 호출 — role_template.default_tool_groups 가 오염돼 있으면
    ``resolve_policy``의 미인식-그룹 fail-open(전체 비파괴 허용)으로 새는 걸 fail-closed 로 막는다.

    까심 QA HIGH(S3 RC): ``get_recruited()`` 조회→create 사이 + 키 rotate 의 old조회→revoke→insert
    사이에 락이 없으면 동일 agent 에 대한 동시 recruit 2콜이 persona 2행 + active 키 2개(scope
    서로 다름)를 만들어 G2/G3 단일소스 전제가 깨진다(codex 실재현). SELECT FOR UPDATE 는 아직
    존재하지 않는 행은 못 잠그므로(check-then-insert TOCTOU — 기존 [[feedback_check_then_insert_toctou]]
    교훈과 동형) agent-scoped `pg_advisory_xact_lock` 으로 이 함수 본문 전체(조회→분기→write)를
    직렬화한다 — 트랜잭션 종료 시 자동 해제, 기존 `onboarding_first_auth:{member_id}` 관례와 동일 패턴.

    E-I18N Phase C(story 11f1087c): ``locale``은 request-scoped(호출부가 FE 전달값→Accept-Language
    폴백으로 이미 정규화해 넘긴다) — 여기선 그대로 ``compose_kit``에 전달만 한다. 기본값 "ko"라
    이 함수를 직접 호출하는 기존/테스트 코드는 무변경 하위호환.

    채용-kit 재설계(story b1fe41cf): ``compose_kit``이 구조화 dict를 반환 — DB의 ``system_prompt``
    컬럼(Text)은 여전히 단일 문자열이라 ``"\n\n".join(kit.values())``로 재구성한다(라이브
    오케스트레이션 소비자가 없어 — §크럭스 §0 확인 — 이 join 순서/포맷 변경은 breaking 아님).

    E-RECRUIT S26(story `510a1ed4`, PO 오르테가 dead-path 지적 2026-07-09): ``render_kit_for_family``
    는 여기서 **runtime 자동추론으로 상시 적용**한다(명시 opt-in 파라미터 아님) — 이미 받은
    ``runtime``에서 family를 자동 도출해 렌더하는 게 "모델-aware"의 본질이지, 유저가 매번 family를
    또 지정해야 하면 그게 더 이상한 설계다. 미매핑 runtime(cursor/grok/opencode/openclaw/hermes/pi)
    은 ``resolve_model_family``가 GENERIC(=거의 no-op·terse pass-through)으로 fail-safe 해서
    "family 미지정 시 기존 동작과 사실상 동일"이라는 회귀 요건도 자연히 충족한다.
    """
    await acquire_agent_mutation_lock(session, agent_member.id)

    tool_allowlist = list(role_template.default_tool_groups)
    validate_tool_groups(tool_allowlist)  # fail-closed — ValueError 전파, 호출부가 400 매핑

    kit = compose_kit(role_template, runtime, locale)
    kit = render_kit_for_family(kit, resolve_model_family(runtime))
    system_prompt = "\n\n".join(kit.values())

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
            # QA MEDIUM(persona description stale): 새 role의 description이 None이어도 이전
            # role의 값이 잔존하면 안 됨 — 이 필드만 None도 명시 반영으로 승격.
            force_none_fields={"description"},
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
