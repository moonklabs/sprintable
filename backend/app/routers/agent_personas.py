import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.dependencies.ownership import assert_agent_owner
from app.repositories.agent_persona import AgentPersonaRepository
from app.schemas.agent_persona import CreatePersonaRequest, UpdatePersonaRequest
from app.services.member_resolver import resolve_member_db_verified

router = APIRouter(prefix="/api/v2/agent-personas", tags=["agent-personas", "Organization"])


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
    # story #4000(보안 감사) — org 소속만으로는 남의 agent에 persona(system_prompt 포함)를
    # 붙일 수 있었다(SEC-S7이 막은 건 타 org 축뿐, 같은 org 안 타 agent 축은 열려 있었다).
    # assert_agent_owner가 존재+org+ownership(생성자 or org admin)을 한 번에 검증.
    await assert_agent_owner(body.agent_id, repo.session, org_id, uuid.UUID(auth.user_id))
    try:
        # story #3370 회귀 클래스(페드루 PO 지시 2026-09-11) — actor_id는
        # AgentPersona.created_by로 영속된다. resolve_member_db_verified()의 영속
        # 멤버 id로 정정(휴먼 JWT의 auth.user_id는 users.id, org 멤버 id가 아니다).
        resolved = await resolve_member_db_verified(auth, org_id, repo.session)
        persona = await repo.create(
            org_id=org_id,
            project_id=project_id,
            agent_id=body.agent_id,
            actor_id=resolved.id,
            name=body.name,
            slug=body.slug,
            description=body.description,
            system_prompt=body.system_prompt,
            style_prompt=body.style_prompt,
            model=body.model,
            expected_cost_note=body.expected_cost_note,
            stop_condition_note=body.stop_condition_note,
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
    # story #4000 — create_persona와 동일 축(위 참고).
    await assert_agent_owner(agent_id, repo.session, org_id, uuid.UUID(auth.user_id))
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
    # story #4000(보안 감사) — PATCH는 raw repo.update()로 바로 넘어가 소유권 검사가 아예
    # 없었다(org/project 스코프만) — 대상 agent_id를 먼저 찾아 assert_agent_owner로 막는다.
    # assert_agent_owner의 HTTPException(403/404)은 그대로 전파(api_keys.py 등 기존
    # 8곳 이상의 호출부와 동일 관례 — app.main의 구조적 에러 핸들러가 일관 포맷으로 감싼다).
    agent_id = await repo.get_agent_id(id, org_id, project_id)
    if agent_id is None:
        return _err("NOT_FOUND", "Persona not found", 404)
    await assert_agent_owner(agent_id, repo.session, org_id, uuid.UUID(auth.user_id))
    try:
        # story #3370 회귀 클래스 — create_persona와 같은 actor_id 축(위 참고).
        resolved = await resolve_member_db_verified(auth, org_id, repo.session)
        persona = await repo.update(
            id, org_id, project_id,
            actor_id=resolved.id,
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
    # story #4000(보안 감사) — update_persona와 동일 축(위 참고).
    agent_id = await repo.get_agent_id(id, org_id, project_id)
    if agent_id is None:
        return _err("NOT_FOUND", "Persona not found", 404)
    await assert_agent_owner(agent_id, repo.session, org_id, uuid.UUID(auth.user_id))
    try:
        ok = await repo.delete(id, org_id, project_id)
        if not ok:
            return _err("NOT_FOUND", "Persona not found", 404)
        return _ok({"ok": True, "id": str(id)})
    except ValueError as e:
        return _err("FORBIDDEN", str(e), 403)
