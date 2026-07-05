"""S3 (org-level 멀티프로젝트 에이전트): org 범위 에이전트 생성 엔드포인트.

`POST /api/v2/agents` — 단일 project 종속(team-members create)과 달리 scope_mode 로 프로젝트
집합을 받아 members/api_key 1개 + N 프로젝트 grant 를 fan-out 한다(빌링=에이전트 1카운트).
인가/권한 규칙은 create_team_member 와 동일(agent actor can_manage_members + role rank + self-name).

블루프린트 docs/org-level-agent-multiproject-blueprint.md §4 G3 / §5.
"""
import json
import os
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.project import Project
from app.models.team import TeamMember
from app.repositories.agent_persona import AgentPersonaRepository
from app.schemas.recruit import RecruitRequest
from app.schemas.team_member import OrgAgentCreate, TeamMemberResponse
from app.services.agent_onboarding_config import (
    CONNECTOR_RUNTIME,
    DEFAULT_RUNTIME,
    SUPPORTED_RUNTIMES,
    SUPPORTED_TRANSPORTS,
    build_agent_mcp_config,
    build_agent_mcp_config_bundle,
    build_connector_guidance,
    default_transport_for_edition,
    resolve_instruction_filename,
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

    actor = await _resolve_actor(auth, session, org_id)
    if actor is not None and actor.type == "agent":
        # S4: can_manage_members → has_project_role(min='admin') 단일 경로(role 에서 derived).
        from app.services.project_auth import has_project_role
        if not await has_project_role(session, actor.id, actor.project_id, min_role="admin"):
            raise HTTPException(status_code=403, detail="project admin/owner role required to manage members")
        if _ROLE_RANK.get(body.role, 1) > _ROLE_RANK.get(actor.role, 1):
            raise HTTPException(status_code=403, detail="Cannot assign role higher than your own")
        if body.name == actor.name:
            raise HTTPException(status_code=400, detail="Agent cannot create a member with the same name as itself")

    project_ids = await _resolve_org_project_ids(body, session, org_id)

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
    # E-MCP-OPT S3: 단일 SSOT generator 소비 — edition 기본 + 두 transport 변형 동봉(FE round-trip 0).
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
    파라미터로 재요청(§5, FE round-trip 방식 선택). 미지정 시 edition 기본(SaaS=http·OSS=stdio).

    E-RECRUIT S5 G4(블루프린트 핵심 발견 — ``agent_personas.system_prompt``가 저장은 되나 어떤
    런타임에도 전달 안 됨): 이 **공용** 레이어에 fix를 둬서 recruit(S3) 전용이 아니라 **일반
    생성 에이전트도** persona 가 있으면(is_default) 그 자율 운영 지침을 파일로 받는다. persona
    가 없으면(미채용) 지침 파일 없이 mcp_config 만(이전 동작과 동일 — 회귀 없음).

    ⚠️ BREAKING(dev-only, 착수 전 미르코군 조율): 응답 shape 을 기존 ``{filename, content}``
    단일 파일에서 ``{files[], mcp_config, api_key}``(``api_key`` 는 GET 이라 placeholder 뿐)로
    교체 — S4 채용관 번들 프리뷰(파일 3종)와 recruit(S3) 응답 shape 에 맞춘다(G2: 재방문 시
    placeholder만·실키는 recruit 시점 1회).
    """
    if runtime not in SUPPORTED_RUNTIMES:
        raise HTTPException(status_code=400, detail=f"unsupported runtime: {runtime}")

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

    if runtime == CONNECTOR_RUNTIME:
        # Q2(PO 확정): connector = 포인터/안내만 — SSE dial-out은 `.mcp.json`과 별개 프로토콜이라
        # transport 파라미터 자체가 의미 없음(무시).
        resolved_transport = None
        mcp_config: dict | None = None
        files.append({"filename": "CONNECTOR_SETUP.md", "content": build_connector_guidance(runtime)})
    else:
        resolved_transport = transport or default_transport_for_edition()
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
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """E-RECRUIT S3(story ff2996d0): role_template + runtime → 자율 운영 지침 합성(S2) + persona
    upsert(G7) + role-derived scope 로 키 회전(G2/G3) + 활성화 번들(``.mcp.json`` + 실 key 1회) 반환.

    G1: 에이전트가 없으면 FE가 먼저 기존 ``POST /agents``를 재사용해 만든다 — 이 엔드포인트는
    ``agent_id``가 이미 존재함을 전제(별도 인라인 분기 없음, 경로 divergence 방지).
    """
    member = await _fetch_org_agent(session, agent_id, org_id)
    if member is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    if body.runtime not in SUPPORTED_RUNTIMES:
        raise HTTPException(status_code=400, detail=f"unsupported runtime: {body.runtime}")

    role_template = await get_published_role_template(session, body.role_template_slug)
    if role_template is None:
        raise HTTPException(status_code=404, detail="role_template not found")

    try:
        result = await recruit_agent(
            session,
            agent_member=member,
            org_id=org_id,
            role_template=role_template,
            runtime=body.runtime,
            actor_id=uuid.UUID(auth.user_id),
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
    """
    member = await _fetch_org_agent(session, agent_id, org_id)
    if member is None:
        raise HTTPException(status_code=404, detail="Agent not found")
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
