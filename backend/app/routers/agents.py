"""S3 (org-level 멀티프로젝트 에이전트): org 범위 에이전트 생성 엔드포인트.

`POST /api/v2/agents` — 단일 project 종속(team-members create)과 달리 scope_mode 로 프로젝트
집합을 받아 members/api_key 1개 + N 프로젝트 grant 를 fan-out 한다(빌링=에이전트 1카운트).
인가/권한 규칙은 create_team_member 와 동일(agent actor can_manage_members + role rank + self-name).

블루프린트 docs/org-level-agent-multiproject-blueprint.md §4 G3 / §5.
"""
import json
import os
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import assert_agent_owner
from app.models.project import Project
from app.models.team import TeamMember
from app.repositories.agent_persona import AgentPersonaRepository
from app.schemas.recruit import RecruitRequest
from app.schemas.team_member import OrgAgentCreate, TeamMemberResponse
from app.services.agent_onboarding_config import (
    DEFAULT_RUNTIME,
    MCP_NATIVE_RUNTIMES,
    SUPPORTED_RUNTIMES,
    SUPPORTED_TRANSPORTS,
    build_agent_mcp_config,
    build_agent_mcp_config_bundle,
    build_connector_guidance,
    default_transport_for_hosting,
    resolve_instruction_filename,
    resolve_locale_from_request,
)
from app.services.agent_verify import get_verification_state, start_verification
from app.services.onboarding_funnel import emit_onboarding_event, safe_key_prefix
from app.services.org_agent import create_org_level_agent
from app.services.recruit_service import get_published_role_template, recruit_agent

router = APIRouter(prefix="/api/v2/agents", tags=["agents"])

_FAKECHAT_BASE_PORT = 8787
# 기존 에이전트 connection-artifact: 평문 키가 없으므로(생성 시 1회만 노출) 사용자가 채울 placeholder.
_API_KEY_PLACEHOLDER = "<YOUR_AGENT_API_KEY>"


async def _resolve_org_project_ids(
    body: OrgAgentCreate, session: AsyncSession, org_id: uuid.UUID
) -> list[uuid.UUID]:
    """scope_mode → grant 대상 프로젝트 id 리스트(org 소속·≥1·중복제거·순서보존)."""
    org_projects = [
        r[0]
        for r in (
            await session.execute(
                select(Project.id)
                .where(Project.org_id == org_id, Project.deleted_at.is_(None))
                .order_by(Project.created_at.asc())
            )
        ).all()
    ]
    if body.scope_mode == "org":
        # v1: 현재 org 의 모든 프로젝트. 미래 프로젝트 자동 grant 는 follow-up(project-create 훅).
        project_ids = org_projects
    elif body.scope_mode == "projects":
        if not body.project_ids:
            raise HTTPException(status_code=400, detail="project_ids required when scope_mode='projects'")
        valid = set(org_projects)
        invalid = [str(p) for p in body.project_ids if p not in valid]
        if invalid:
            raise HTTPException(status_code=400, detail=f"project_ids not in org: {invalid}")
        seen: set[uuid.UUID] = set()
        project_ids = []
        for p in body.project_ids:  # 순서 보존 + 중복 제거
            if p not in seen:
                seen.add(p)
                project_ids.append(p)
    else:
        raise HTTPException(status_code=400, detail="scope_mode must be 'org' or 'projects'")

    if not project_ids:
        raise HTTPException(status_code=400, detail="org has no projects to grant the agent into")
    return project_ids


@router.post("", status_code=201)
async def create_org_agent(
    body: OrgAgentCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """org-level 에이전트 생성 + scope_mode 프로젝트 집합 grant. 응답에 api_key 1회 노출."""
    # 권한: create_team_member 와 동일 규칙 재사용(agent actor 제약).
    from app.routers.team_members import _ROLE_RANK, _resolve_actor

    # E-SECURITY SEC-S8(story 83ea3d6a) O: project_ids를 role 체크보다 먼저 해소해야 아래
    # agent 분기가 실제 grant 대상 전체에 대해 admin 권한을 검증할 수 있다(기존엔 actor.project_id
    # 하나만 봐서 grant 대상과 무관했다).
    project_ids = await _resolve_org_project_ids(body, session, org_id)

    actor = await _resolve_actor(auth, session, org_id)
    if actor is not None and actor.type == "agent":
        # E-SECURITY SEC-S8 O(까심 실HTTP 2단계 재현, PR#1557부터 존재): has_project_role이
        # caller의 anchor project(actor.project_id) 하나만 검사해, P1에만 admin인 에이전트가
        # scope_mode='projects'로 P2(본인 무권한 project)나 scope_mode='org'로 org 전체에
        # 새 에이전트+API키를 찍어낼 수 있었다(grant 대상과 검증 대상 불일치). project_ids
        # 전원에 대해 admin role을 요구 — 하나라도 admin이 아니면 전체 요청 차단.
        from app.services.project_auth import has_project_role
        for pid in project_ids:
            if not await has_project_role(session, actor.id, pid, min_role="admin"):
                raise HTTPException(status_code=403, detail="project admin/owner role required to manage members")
        if _ROLE_RANK.get(body.role, 1) > _ROLE_RANK.get(actor.role, 1):
            raise HTTPException(status_code=403, detail="Cannot assign role higher than your own")
        if body.name == actor.name:
            raise HTTPException(status_code=400, detail="Agent cannot create a member with the same name as itself")
    else:
        # E-SECURITY SEC-S8(story 83ea3d6a) L 자매 갭 — create_team_member와 동일 패턴으로
        # `if actor.type == "agent"`에 갇혀 휴먼 caller(또는 actor 미해소)면 인가가 통째로
        # 스킵됐다. 이 엔드포인트는 단일 project가 아니라 org 범위(scope_mode='org'|'projects')
        # 라 project 단위 role 대신 org owner/admin을 요구(target-org 검증은
        # `_resolve_org_project_ids`가 이미 project_ids⊂org 소속으로 강제해 별도 조치 불요).
        # 에이전트 분기는 원래 로직 그대로 무회귀(위 if 블록 미변경).
        from app.services.project_auth import is_org_owner_or_admin
        if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
            raise HTTPException(status_code=403, detail="org admin/owner role required to manage members")

    created_by = uuid.UUID(auth.user_id)  # 휴먼=user_id / 에이전트=member.id (anchor sync 가 휴먼만 owner 매칭)
    member, api_key_plaintext = await create_org_level_agent(
        session,
        org_id=org_id,
        created_by=created_by,
        name=body.name,
        role=body.role,
        agent_config=body.agent_config,
        agent_role=body.agent_role,
        color=body.color,
        avatar_url=body.avatar_url,
        project_ids=project_ids,
    )

    response = TeamMemberResponse.model_validate(member).model_dump()
    response["member_id"] = str(member.id)
    response["project_ids"] = [str(p) for p in project_ids]
    response["scope_mode"] = body.scope_mode
    effective_port = member.fakechat_port or int(os.environ.get("FAKECHAT_PORT", _FAKECHAT_BASE_PORT))
    response["fakechat_port"] = effective_port
    response["api_key_created"] = bool(api_key_plaintext)
    # E-MCP-OPT S3/S7: 단일 SSOT generator 소비 — 호스팅 가용성 기본(MCP_PUBLIC_URL 존재) + 두
    # transport 변형 동봉(FE round-trip 0).
    config_bundle = build_agent_mcp_config_bundle(api_key_plaintext=api_key_plaintext)
    response["mcp_config"] = config_bundle["mcp_config"]
    response["default_transport"] = config_bundle["default_transport"]
    response["mcp_config_alternatives"] = config_bundle["mcp_config_alternatives"]
    if api_key_plaintext:
        response["api_key"] = api_key_plaintext

    # OB-4 seam: agent_created (funnel·non-blocking·fail-silent). key_prefix=prefix-only(평문키 금지).
    await emit_onboarding_event(
        session, "agent_created", agent_id=member.id, org_id=org_id,
        project_id=(project_ids[0] if project_ids else None),
        runtime="claude-code", transport=config_bundle["default_transport"],
        key_prefix=safe_key_prefix(api_key_plaintext),
    )
    await session.commit()
    return response


@router.get("/{agent_id}/connection-artifact")
async def get_agent_connection_artifact(
    agent_id: uuid.UUID,
    runtime: str = DEFAULT_RUNTIME,
    transport: str | None = None,
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """OB-1 AC3 + E-RECRUIT S5(story 4fca5a3e): 에이전트 activation 번들 — 同 SSOT generator 소비.

    기존 에이전트는 평문 키가 없으므로(생성 시 1회 노출) ``AGENT_API_KEY`` 는 placeholder 로 채운다 —
    사용자가 자기 키를 붙여 완성한다. wizard(OB-3)가 이 아티팩트를 렌더+copy+verify 한다.
    org-scope 로 조회(anti-IDOR). team_members 는 projection VIEW 라 멀티프로젝트 agent 가 N행이므로
    ``.limit(1)`` 로 MultipleResultsFound 차단(identity 조회·행 동형).

    E-MCP-OPT S3: ``transport`` 쿼리(``stdio``|``http``) — connect-step 토글이 다른 탭 선택 시 이
    파라미터로 재요청(§5, FE round-trip 방식 선택). 미지정 시 호스팅 가용성 기본(S7: MCP_PUBLIC_URL
    세팅=http·미설정=stdio — 과금/EE 무관).

    E-RECRUIT S5 G4(블루프린트 핵심 발견 — ``agent_personas.system_prompt``가 저장은 되나 어떤
    런타임에도 전달 안 됨): 이 **공용** 레이어에 fix를 둬서 recruit(S3) 전용이 아니라 **일반
    생성 에이전트도** persona 가 있으면(is_default) 그 자율 운영 지침을 파일로 받는다. persona
    가 없으면(미채용) 지침 파일 없이 mcp_config 만(이전 동작과 동일 — 회귀 없음).

    ⚠️ BREAKING(dev-only, 착수 전 미르코군 조율): 응답 shape 을 기존 ``{filename, content}``
    단일 파일에서 ``{files[], mcp_config, api_key}``(``api_key`` 는 GET 이라 placeholder 뿐)로
    교체 — S4 채용관 번들 프리뷰(파일 3종)와 recruit(S3) 응답 shape 에 맞춘다(G2: 재방문 시
    placeholder만·실키는 recruit 시점 1회).

    E-I18N Phase C(story 11f1087c): ``locale`` 쿼리(명시)→``Accept-Language`` 헤더(폴백) 순으로
    정규화해 ``build_connector_guidance()``(CONNECTOR_SETUP.md)에만 적용 — 이미 채용 시점에
    확정 locale로 저장된 ``resolved_system_prompt``(persona 파일)는 재합성하지 않는다(그 값은
    recruit() 호출 당시 locale의 정확한 기록이라, 여기서 다시 손대면 오히려 왜곡).

    까심 QA CI FAILURE(2026-07-08, 근본 fix): ``accept_language``의 ``Header()`` DI 마커는
    FastAPI ASGI 파이프라인을 통해서만 plain str/None으로 풀린다 — 이 함수를 realdb 테스트처럼
    **Python에서 직접 호출**하면 ``Header`` 객체 그대로 남아 ``resolve_locale_from_request()``가
    ``.split()``에서 AttributeError로 죽는다(HTTP 경로만 통과하는 QA로는 안 잡힘). 그래서 실제
    로직은 Header() 마커가 전혀 없는 ``_connection_artifact()``(plain str만 받음)로 옮기고, 이
    라우트 함수는 얇은 위임만 한다 — 직접-호출 테스트는 ``_connection_artifact``를 불러야 한다
    (Header DI는 라우트 경계에서만 받는다는 원칙).

    채용-kit 재설계(story b1fe41cf, 선생님 GO 2026-07-08): ``resolve_instruction_filename()``이
    이제 런타임 무관 단일 파일명(``KIT_FILENAME`` = ``SPRINTABLE_ONBOARDING.md``)을 반환한다 —
    예전엔 CLAUDE.md/AGENTS.md 등 실제 정체성 파일명 리터럴을 써서, 유저가 다운로드해 프로젝트
    루트에 저장하면 자기 에이전트의 진짜 정체성 파일을 덮어썼다(정체성 뭉갬 버그의 실제 코드
    지점). 새 파일명은 그 어떤 런타임의 정체성 파일명과도 충돌하지 않는다.
    """
    return await _connection_artifact(
        agent_id, runtime, transport, locale, accept_language,
        session=session, auth=auth, org_id=org_id,
    )


async def _connection_artifact(
    agent_id: uuid.UUID,
    runtime: str = DEFAULT_RUNTIME,
    transport: str | None = None,
    locale: str | None = None,
    accept_language: str | None = None,
    *,
    session: AsyncSession,
    auth: AuthContext,
    org_id: uuid.UUID,
) -> dict:
    """``get_agent_connection_artifact`` 실 로직 — Header() DI 마커 없음(plain str만).
    직접-호출(realdb·유닛 테스트)은 이 함수를 부른다."""
    if runtime not in SUPPORTED_RUNTIMES:
        raise HTTPException(status_code=400, detail=f"unsupported runtime: {runtime}")
    resolved_locale = resolve_locale_from_request(locale, accept_language)

    member = (await session.execute(
        select(TeamMember).where(
            TeamMember.id == agent_id,
            TeamMember.org_id == org_id,
            TeamMember.type == "agent",
        ).limit(1)
    )).scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    # G4: persona가 있으면(is_default) 자율 운영 지침을 파일로 emit — recruit 전용 아닌 공용 레이어.
    # 까심 QA RC(S5): list()는 `ORDER BY is_default DESC, created_at ASC` 정렬만 하지 실제
    # is_default 여부를 보장 안 함 — is_default=True 행이 하나도 없으면(POST /agent-personas가
    # is_default 생략 시 non-default 생성 가능·"정확히 1개 default" 불변식 없음) 가장 오래된
    # persona가 [0]에 와서 임의 system_prompt가 authoritative처럼 emit된다(G4 목적과 정반대).
    # is_default를 명시 확인 — 참인 행이 없으면 지침 파일 생략(안전 fallback, "미채용"과 동형).
    files: list[dict] = []
    personas = await AgentPersonaRepository(session).list(org_id, member.project_id, agent_id)
    default_persona = personas[0] if personas else None
    if (
        default_persona is not None
        and default_persona.is_default
        and default_persona.resolved_system_prompt
    ):
        files.append({
            "filename": resolve_instruction_filename(runtime),
            "content": default_persona.resolved_system_prompt,
        })

    if runtime not in MCP_NATIVE_RUNTIMES:
        # Q2(PO 확정) + 전 런타임 올지원(story 6f6ac081, PO 크럭스 승인): 범용 connector 버킷 +
        # 커넥터 전용 5종(opencode/openclaw/hermes/grok/pi) 전부 이 분기 — 포인터/안내만(SSE
        # dial-out은 `.mcp.json`과 별개 프로토콜이라 transport 파라미터 자체가 의미 없음/무시).
        # 가드를 단일 sentinel(`== CONNECTOR_RUNTIME`) 대신 `not in MCP_NATIVE_RUNTIMES`로
        # 반전한 이유: 전자는 커넥터 전용 5종을 그냥 통과시켜 `.mcp.json`을 오emit했다.
        resolved_transport = None
        mcp_config: dict | None = None
        files.append({
            "filename": "CONNECTOR_SETUP.md",
            "content": build_connector_guidance(runtime, resolved_locale),
        })
    else:
        resolved_transport = transport or default_transport_for_hosting()
        if resolved_transport not in SUPPORTED_TRANSPORTS:
            raise HTTPException(status_code=400, detail=f"unsupported transport: {transport}")
        mcp_config = build_agent_mcp_config(
            api_key_plaintext=_API_KEY_PLACEHOLDER, runtime=runtime, transport=resolved_transport,
        )
        if mcp_config is None:
            # http 요청됐으나 이 환경엔 호스팅 배포가 없음(MCP_PUBLIC_URL 미설정) — 명시 요청이라 400.
            raise HTTPException(status_code=400, detail=f"transport '{resolved_transport}' unavailable in this environment")
        files.append({
            "filename": ".mcp.json",
            "content": json.dumps(mcp_config, indent=2, ensure_ascii=False),
        })

    # OB-4 seam: config_generated (generator 아티팩트 반환·funnel·non-blocking).
    await emit_onboarding_event(
        session, "config_generated", agent_id=member.id, org_id=org_id,
        runtime=runtime, transport=resolved_transport,
    )
    await session.commit()

    return {
        "agent_id": str(member.id),
        "runtime": runtime,
        "files": files,
        "mcp_config": mcp_config,
        # G2: GET 재방문 — full key 재발급 불가(생성/recruit 시점 1회만 노출). placeholder 로 표시.
        "api_key": None,
    }


async def _fetch_org_agent(session: AsyncSession, agent_id: uuid.UUID, org_id: uuid.UUID):
    """org-scope agent 조회(anti-IDOR). team_members projection VIEW 멀티행 → .limit(1)."""
    return (await session.execute(
        select(TeamMember).where(
            TeamMember.id == agent_id,
            TeamMember.org_id == org_id,
            TeamMember.type == "agent",
        ).limit(1)
    )).scalar_one_or_none()


@router.post("/{agent_id}/recruit", status_code=201)
async def recruit_agent_endpoint(
    agent_id: uuid.UUID,
    body: RecruitRequest,
    accept_language: str | None = Header(None, alias="Accept-Language"),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """E-RECRUIT S3(story ff2996d0): role_template + runtime → 자율 운영 지침 합성(S2) + persona
    upsert(G7) + role-derived scope 로 키 회전(G2/G3) + 활성화 번들(``.mcp.json`` + 실 key 1회) 반환.

    G1: 에이전트가 없으면 FE가 먼저 기존 ``POST /agents``를 재사용해 만든다 — 이 엔드포인트는
    ``agent_id``가 이미 존재함을 전제(별도 인라인 분기 없음, 경로 divergence 방지).

    S19(#8, 최고임팩트 MUST): 이전엔 org-scope 조회(`_fetch_org_agent`)만 있고 caller-ownership
    확인이 없어 — org 내 임의 멤버가 자신이 만들지도 관리자도 아닌 agent를 재채용(키 로테이션+
    role/system_prompt 변경, 채용 엔드포인트 자체 탈취)할 수 있었다. team_members.py 업데이트/
    deactivate와 동일한 `assert_agent_owner`(생성자 또는 org-admin)로 닫는다.

    E-I18N Phase C(story 11f1087c): ``body.locale``(FE 명시 전달)→``Accept-Language`` 헤더(폴백)
    순으로 정규화해 ``compose_kit``에 배선 — 이 시점에 확정된 locale이 persona에 영속 기록된다
    (재채용 시 다른 locale로 다시 부르면 그 값으로 덮어씀, DB에 별도 locale 컬럼은 없음).

    까심 QA CI FAILURE 후속(2026-07-08, connection-artifact와 동형 근본 fix 선제 적용): Header()
    DI 마커는 라우트 경계에서만 받고, 실 로직은 plain str만 받는 ``_recruit_agent_endpoint()``로
    분리 — 직접-호출 테스트가 FastAPI ASGI 파이프라인을 안 거쳐도 Header sentinel leak이 날 수
    없다.
    """
    return await _recruit_agent_endpoint(
        agent_id, body, accept_language, session=session, auth=auth, org_id=org_id,
    )


async def _recruit_agent_endpoint(
    agent_id: uuid.UUID,
    body: RecruitRequest,
    accept_language: str | None = None,
    *,
    session: AsyncSession,
    auth: AuthContext,
    org_id: uuid.UUID,
) -> dict:
    """``recruit_agent_endpoint`` 실 로직 — Header() DI 마커 없음(plain str만).
    직접-호출(realdb·유닛 테스트)은 이 함수를 부른다."""
    member = await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))

    if body.runtime not in SUPPORTED_RUNTIMES:
        raise HTTPException(status_code=400, detail=f"unsupported runtime: {body.runtime}")

    role_template = await get_published_role_template(session, body.role_template_slug)
    if role_template is None:
        raise HTTPException(status_code=404, detail="role_template not found")

    resolved_locale = resolve_locale_from_request(body.locale, accept_language)
    try:
        result = await recruit_agent(
            session,
            agent_member=member,
            org_id=org_id,
            role_template=role_template,
            runtime=body.runtime,
            actor_id=uuid.UUID(auth.user_id),
            locale=resolved_locale,
        )
    except ValueError as exc:
        # validate_tool_groups fail-closed(QA MINOR 하드닝) — 오염된 role_template 데이터 400.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    persona = result["persona"]
    api_key_plaintext = result["api_key_plaintext"]
    bundle = build_agent_mcp_config_bundle(api_key_plaintext=api_key_plaintext, runtime=body.runtime)

    # OB-4 seam: config_generated(recruit 도 번들 생성 지점 — connection-artifact 와 동일 이벤트 재사용).
    await emit_onboarding_event(
        session, "config_generated", agent_id=member.id, org_id=org_id,
        project_id=member.project_id, runtime=body.runtime,
        transport=bundle["default_transport"], key_prefix=safe_key_prefix(api_key_plaintext),
    )
    await session.commit()

    return {
        "agent_id": str(member.id),
        "persona_id": str(persona.id),
        "role_template_slug": role_template.slug,
        "system_prompt": persona.system_prompt,
        "tool_allowlist": result["tool_allowlist"],
        "api_key": api_key_plaintext,
        "default_transport": bundle["default_transport"],
        "mcp_config": bundle["mcp_config"],
        "mcp_config_alternatives": bundle["mcp_config_alternatives"],
    }


@router.post("/{agent_id}/verify-connection")
async def verify_agent_connection(
    agent_id: uuid.UUID,
    transport: str | None = None,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """OB-2 AC1: 합성 connection_test Event 를 **실 SSE 경로**로 발사 → 라운드트립 verify 시작.

    single-target(AC3): 해당 agent 1명에게만 — fire_webhooks/org 브로드캐스트 미사용. 이벤트는
    실 /agent/stream 경로(우회 X)로 가고, 에이전트가 ack 하면(acked_seq>=seq) verified 가 된다.
    응답은 verification-status 와 동일한 6단계 레일(초기 상태)을 같이 실어 FE 가 즉시 렌더하게 한다.

    E-MCP-OPT S3: ``transport="http"`` 는 **합성 이벤트/SSE nudge 전부 스킵**한다 — http 는 서버→
    에이전트 push 경로 자체가 없어(streamable, client-initiated) 보낼 곳이 없다. heartbeat 기반
    4단계 레일을 즉시 조회해 반환(사실상 GET verification-status 와 동형 — "확인" 버튼 클릭이 곧
    현재 heartbeat freshness 재조회를 뜻한다).

    E-MCP-OPT S5(#4): project 미배정 에이전트는 **transport 무관 동일하게 400** — http 조기 return이
    이 가드보다 먼저면 미배정 에이전트가 stdio=400/http=200으로 갈렸다(까심 QA). project 스코프가
    없는 에이전트는애초에 "연결 검증"이 의미가 없으므로(heartbeat 조차 project 컨텍스트 하 tool
    호출을 전제) 두 transport 모두 이 가드를 먼저 통과해야 한다.

    S19(#9): recruit(#8)과 동일 갭 — org-scope만으로는 임의 org 멤버가 남의 agent 연결검증을
    트리거할 수 있었다. `assert_agent_owner`로 닫는다.
    """
    member = await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))
    if not member.project_id:
        raise HTTPException(status_code=400, detail="agent has no project scope to verify")

    if transport == "http":
        state = await get_verification_state(session, agent_id, transport="http")
        return {
            "agent_id": str(agent_id),
            "verification_seq": None,
            "verified": state["verified"],
            "rail": state["rail"],
        }

    seq = await start_verification(
        session, agent_id=agent_id, org_id=org_id, project_id=member.project_id
    )
    # OB-4 seam: event_sent (합성 verify 이벤트 디스패치·funnel·non-blocking·verify tx 동승).
    await emit_onboarding_event(
        session, "event_sent", agent_id=agent_id, org_id=org_id,
        project_id=member.project_id, runtime="claude-code", transport="stdio",
    )
    await session.commit()

    # commit 후 SSE 스트림 nudge(단일 타겟). payload 미포함 — 스트림이 seq>acked_seq 재조회로 가져간다.
    from app.routers.agent_gateway import wake_agent
    wake_agent(str(agent_id), seq)

    state = await get_verification_state(session, agent_id)
    return {
        "agent_id": str(agent_id),
        "verification_seq": seq,
        "verified": state["verified"],
        "rail": state["rail"],
    }


@router.get("/{agent_id}/verification-status")
async def agent_verification_status(
    agent_id: uuid.UUID,
    transport: str = "stdio",
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """OB-2 AC2: 레일 폴링/조회(BE↔FE 계약 락). SSE 우선·이 poll 은 fallback.

    각 단계 ``{state, status: pending|active|done}``. ack/verified 는 acked_seq>=seq 권위 신호만
    (stdio) 또는 heartbeat freshness(http, E-MCP-OPT S3 — 4단계 축소 레일).
    ``transport`` 쿼리 — connect-step 이 보고 있는 탭과 정합(기본 stdio·회귀0).
    """
    member = await _fetch_org_agent(session, agent_id, org_id)
    if member is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    state = await get_verification_state(session, agent_id, transport=transport)
    return {
        "agent_id": str(agent_id),
        "verification_seq": state["verify_seq"],
        "verified": state["verified"],
        "rail": state["rail"],
    }


@router.get("/access-matrix")
async def get_agent_access_matrix(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[dict]:
    """[에이전트 관리 IA·Phase 2] org-wide 에이전트×프로젝트 접근권한 매트릭스 시드(story da4c6b2d).

    PO crux 승인(2026-07-07): 후보 A 채택 — 프로젝트별 fan-out(N agents × M projects 왕복) 대신
    단일 인덱스드 쿼리로 org 전체 grant 를 한 번에 반환. FE 는 이미 별도로 가진 org 에이전트
    전체 목록·org 프로젝트 전체 목록에 이 sparse grant 목록만 겹쳐 매트릭스 셀 상태를 정한다
    (record_id 있음=허용, 없음=차단). 경로에 org path-param 을 안 둔다 — `get_verified_org_id` 로
    caller 의 검증된 org 만 암묵 사용(클라이언트가 org id 조작해 타org 조회하는 경로 원천 차단).

    **에이전트 격리(PO 승인조건 #1)**: `project_access.member_id` 는 에이전트 전용이 아니다 —
    휴먼 grant 도 `ensure_human_member` 성공 시 member_id 를 org_member.id(=members.id 미러)로
    세팅한다(`project_access.py` 휴먼 분기). 그래서 `member_id IS NOT NULL` 만으론 휴먼이 섞인다 —
    `members` 를 명시 JOIN 해 `type = 'agent'` 로 직접 격리.

    **인가(PO 승인조건 #2)**: 고객대면(org admin 이 자기 에이전트 접근을 조망) — `require_operator`
    (플랫폼 운영자) 아닌 **org admin/owner**. 기존 `is_org_owner_or_admin`(project_access.py 의
    role-설정 엔드포인트가 이미 씀) 재사용, 신규 프리미티브 0.
    """
    from app.services.project_auth import is_org_owner_or_admin

    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org owner or admin required")

    rows = (
        await session.execute(
            text(
                """
                SELECT pa.id AS record_id, pa.member_id AS agent_member_id, pa.project_id
                FROM project_access pa
                JOIN members m ON m.id = pa.member_id
                JOIN projects p ON p.id = pa.project_id
                WHERE m.type = 'agent' AND m.deleted_at IS NULL
                  AND p.org_id = :org_id AND p.deleted_at IS NULL
                """
            ),
            {"org_id": org_id},
        )
    ).mappings().all()
    return [
        {
            "agent_member_id": str(r["agent_member_id"]),
            "project_id": str(r["project_id"]),
            "record_id": str(r["record_id"]),
        }
        for r in rows
    ]
