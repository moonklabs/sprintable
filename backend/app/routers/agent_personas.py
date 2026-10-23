import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.dependencies.ownership import assert_agent_owner
from app.repositories.agent_persona import AgentPersonaRepository
from app.schemas.agent_persona import CreatePersonaRequest, UpdatePersonaRequest
from app.services.agent_run_profile import base_children_problem, normalize_persona_text, persona_text_problem, persona_write_problem
from app.services.member_resolver import resolve_member_db_verified

router = APIRouter(prefix="/api/v2/agent-personas", tags=["agent-personas", "Organization"])


def _text_fields(body: CreatePersonaRequest | UpdatePersonaRequest) -> dict[str, str | None]:
    """every string the body carries — a list of strings (the tool allow-list) as one, so a NUL hidden in it is seen too"""
    out: dict[str, str | None] = {}
    for key, value in body.model_dump().items():
        if isinstance(value, str):
            out[key] = value
        elif isinstance(value, list) and all(isinstance(x, str) for x in value):
            out[key] = "".join(value)
    return out


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
    # story 4680 AC2: the text goes into the agent's session. A control character (a NUL was a 500) is refused readably; the invisible format characters and the unusual line breaks are
    # normalized at the write — saved = run, nothing visible changes for the person; over the cap it is refused here, readably, and nothing is written (never cut silently on its way in)
    invalid = persona_text_problem(_text_fields(body))
    if invalid:
        return _err("PERSONA_TEXT_INVALID", invalid, 422)
    body.system_prompt = normalize_persona_text(body.system_prompt)
    body.style_prompt = normalize_persona_text(body.style_prompt)
    too_long = await persona_write_problem(repo.session, org_id=org_id, system_prompt=body.system_prompt, style_prompt=body.style_prompt, base_persona_id=body.base_persona_id)
    if too_long:
        return _err("PERSONA_TOO_LONG", too_long, 422)
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


# story #4407 AC5 (PO 01:54Z) — `POST /seed` (builtin persona seeding) is removed. It never worked after the move to alembic:
# it called the Postgres function seed_builtin_personas(uuid, uuid, uuid), which exists only in the old Supabase migration
# (packages/db/supabase/migrations/20260406210000…) and was never ported (dev DB: neither the function nor its trigger), and
# its `:org_id::uuid` binding failed first anyway. No caller in the repository, the web or the MCP server. Listing builtins
# (`include_builtin`) and the builtin edit/delete guards stay — they are harmless.


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
    invalid = persona_text_problem(_text_fields(body))
    if invalid:
        return _err("PERSONA_TEXT_INVALID", invalid, 422)
    body.system_prompt = normalize_persona_text(body.system_prompt)
    body.style_prompt = normalize_persona_text(body.style_prompt)
    if body.base_persona_id is not None and body.base_persona_id == id:
        return _err("PERSONA_BASE_INVALID", "A persona cannot be its own base persona.", 422)
    if body.system_prompt is not None and not body.system_prompt.strip():
        # nothing is left of the instructions (blank, or only invisible characters): the column cannot be empty — a readable refusal, not a 500
        return _err("PERSONA_TEXT_INVALID", "The system prompt has nothing visible in it — write the instructions, or leave the field out to keep the current ones.", 422)
    # a PATCH is judged on what the persona WOULD be: the fields it changes and the ones it keeps (only when it touches the instructions, the style or the base persona)
    if body.system_prompt is not None or body.style_prompt is not None or body.base_persona_id is not None:
        current = await repo.get_texts(id, org_id, project_id)
        if current is not None:
            too_long = await persona_write_problem(
                repo.session, org_id=org_id,
                system_prompt=body.system_prompt if body.system_prompt is not None else current[0],
                style_prompt=body.style_prompt if body.style_prompt is not None else current[1],
                base_persona_id=body.base_persona_id if body.base_persona_id is not None else current[2],
            )
            if too_long:
                return _err("PERSONA_TOO_LONG", too_long, 422)
    # a persona that others use as their BASE is joined into each of them: PATCHed longer, each is judged again on what it would leave (the daemon would cut it silently otherwise)
    if body.system_prompt is not None or body.style_prompt is not None:
        current = await repo.get_texts(id, org_id, project_id)
        children = await repo.children_of(id, org_id, project_id) if current is not None else []
        if children:
            overflow = await base_children_problem(
                repo.session, org_id=org_id, base_id=id, children=children,
                new_system=body.system_prompt if body.system_prompt is not None else current[0],
                new_style=body.style_prompt if body.style_prompt is not None else current[1],
            )
            if overflow:
                return _err("PERSONA_TOO_LONG", overflow, 422)
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
