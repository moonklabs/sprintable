import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.member import Member
from app.repositories.agent_persona import AgentPersonaRepository
from app.schemas.agent_persona import CreatePersonaRequest, UpdatePersonaRequest
from app.services.project_auth import assert_target_in_caller_org

router = APIRouter(prefix="/api/v2/agent-personas", tags=["agent-personas"])


def _repo(session: AsyncSession = Depends(get_db)) -> AgentPersonaRepository:
    return AgentPersonaRepository(session)


def _ok(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None}, status_code=status)


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


def _get_org_project(auth: AuthContext) -> tuple[uuid.UUID, uuid.UUID]:
    meta = auth.claims.get("app_metadata", {})
    org_id_str = meta.get("org_id")
    project_id_str = meta.get("project_id")
    if not org_id_str or not project_id_str:
        return None, None
    return uuid.UUID(str(org_id_str)), uuid.UUID(str(project_id_str))


async def _assert_agent_in_caller_org(session: AsyncSession, caller_org_id: uuid.UUID, agent_id: uuid.UUID) -> None:
    """E-SECURITY SEC-S7(story a7dd0431·까심 QA 부수발견 E): create_persona/seed_builtin_personas가
    caller의 org_id만으로 target agent_id에 persona를 생성해 타 org agent 오염(public AgentCard
    내용 오염 + default persona collision DoS)이 가능했다. SEC-S6의 `assert_target_in_caller_org`
    공통 가드 재사용 — target(agent)의 실제 org를 조회해 caller org와 대조."""
    target_org_id = (await session.execute(
        select(Member.org_id).where(Member.id == agent_id, Member.type == "agent")
    )).scalar_one_or_none()
    assert_target_in_caller_org(caller_org_id, target_org_id, not_found_detail="Agent not found")


@router.get("")
async def list_personas(
    agent_id: uuid.UUID = Query(...),
    include_builtin: bool = Query(default=False),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentPersonaRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    personas = await repo.list(org_id, project_id, agent_id, include_builtin=include_builtin)
    return _ok([p.model_dump(mode="json") for p in personas])


@router.post("", status_code=201)
async def create_persona(
    body: CreatePersonaRequest,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentPersonaRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    await _assert_agent_in_caller_org(repo.session, org_id, body.agent_id)
    try:
        persona = await repo.create(
            org_id=org_id,
            project_id=project_id,
            agent_id=body.agent_id,
            actor_id=uuid.UUID(auth.user_id),
            name=body.name,
            slug=body.slug,
            description=body.description,
            system_prompt=body.system_prompt,
            style_prompt=body.style_prompt,
            model=body.model,
            base_persona_id=body.base_persona_id,
            tool_allowlist=body.tool_allowlist,
            is_default=body.is_default or False,
        )
        return _ok(persona.model_dump(mode="json"), status=201)
    except ValueError as e:
        return _err("VALIDATION_ERROR", str(e), 400)


@router.post("/seed")
async def seed_builtin_personas(
    agent_id: uuid.UUID = Query(...),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentPersonaRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    await _assert_agent_in_caller_org(repo.session, org_id, agent_id)
    result = await repo.seed_builtin(org_id, project_id, agent_id)
    return _ok(result)


@router.get("/{id}")
async def get_persona(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentPersonaRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    persona = await repo.get(id, org_id, project_id)
    if persona is None:
        return _err("NOT_FOUND", "Persona not found", 404)
    return _ok(persona.model_dump(mode="json"))


@router.patch("/{id}")
async def update_persona(
    id: uuid.UUID,
    body: UpdatePersonaRequest,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentPersonaRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    try:
        persona = await repo.update(
            id, org_id, project_id,
            actor_id=uuid.UUID(auth.user_id),
            **{k: v for k, v in body.model_dump().items() if v is not None},
        )
        if persona is None:
            return _err("NOT_FOUND", "Persona not found", 404)
        return _ok(persona.model_dump(mode="json"))
    except ValueError as e:
        return _err("FORBIDDEN", str(e), 403)


@router.delete("/{id}")
async def delete_persona(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentPersonaRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    try:
        ok = await repo.delete(id, org_id, project_id)
        if not ok:
            return _err("NOT_FOUND", "Persona not found", 404)
        return _ok({"ok": True, "id": str(id)})
    except ValueError as e:
        return _err("FORBIDDEN", str(e), 403)
