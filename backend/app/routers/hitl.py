import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.dependencies.project_scope import enforce_write_scope, resolve_required_project_id
from app.repositories.hitl import HitlRepository
from app.schemas.hitl import PatchHitlPolicyRequest, ResolveHitlRequestBody
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/hitl", tags=["hitl", "Trust"])


def _repo(session: AsyncSession = Depends(get_db)) -> HitlRepository:
    return HitlRepository(session)


def _ok(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None}, status_code=status)


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


def _get_org_project(auth: AuthContext) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    meta = auth.claims.get("app_metadata", {})
    org_id_str = meta.get("org_id")
    project_id_str = meta.get("project_id")
    if not org_id_str or not project_id_str:
        return None, None
    return uuid.UUID(str(org_id_str)), uuid.UUID(str(project_id_str))


@router.get("/policy")
async def get_hitl_policy(
    auth: AuthContext = Depends(get_current_user),
    repo: HitlRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    snapshot = await repo.get_policy(org_id, project_id)
    return _ok(snapshot.model_dump(mode="json"))


@router.patch("/policy")
async def update_hitl_policy(
    request: Request,
    body: PatchHitlPolicyRequest,
    auth: AuthContext = Depends(get_current_user),
    repo: HitlRepository = Depends(_repo),
) -> JSONResponse:
    try:
        enforce_write_scope(auth, request)
    except HTTPException as exc:
        return _err("FORBIDDEN", str(exc.detail), exc.status_code)
    # E-MCP-OPT 후속(story f0c99070·doc legacy-project-fallback-sweep-audit §2.2 2단계): 이 라우트는
    # project_id 단독(org_id도 미검사) singleton upsert라 fail-closed 앵커가 없다 — 요청시점 재해소
    # 강제(무헤더 direct REST 실호출처 0 실측 확인, 즉시 강제 안전).
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id")
    if not org_id_str:
        return _err("FORBIDDEN", "org_id required", 403)
    org_id = uuid.UUID(str(org_id_str))
    try:
        project_id = await resolve_required_project_id(repo.session, request, auth, org_id)
    except HTTPException as exc:
        return _err(
            exc.detail.get("code", "PROJECT_ID_REQUIRED") if isinstance(exc.detail, dict) else "FORBIDDEN",
            exc.detail.get("message", str(exc.detail)) if isinstance(exc.detail, dict) else str(exc.detail),
            exc.status_code,
        )
    snapshot = await repo.save_policy(
        org_id=org_id,
        project_id=project_id,
        actor_id=auth.user_id,
        approval_rules=body.approval_rules,
        timeout_classes=body.timeout_classes,
    )
    return _ok(snapshot.model_dump(mode="json"))


@router.get("/requests")
async def list_hitl_requests(
    status: str | None = Query(default=None),
    auth: AuthContext = Depends(get_current_user),
    repo: HitlRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    requests = await repo.list_requests(org_id=org_id, project_id=project_id, status=status)
    # _ok 는 raw JSONResponse(json.dumps) — model_dump() 는 UUID/datetime 객체를 그대로 둬 직렬화
    # 불가(500). mode="json" 으로 UUID→str·datetime→ISO 직렬화(resolve 엔드포인트의 str() 우회와 정합).
    return _ok([r.model_dump(mode="json") for r in requests])


@router.patch("/requests/{request_id}")
async def resolve_hitl_request(
    request_id: uuid.UUID,
    body: ResolveHitlRequestBody,
    request: Request,
    auth: AuthContext = Depends(get_current_user),
    repo: HitlRepository = Depends(_repo),
) -> JSONResponse:
    try:
        enforce_write_scope(auth, request)
    except HTTPException as exc:
        return _err("FORBIDDEN", str(exc.detail), exc.status_code)
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    # story #2058 AC1: gates.py transition_gate_endpoint 와 같은 human-only 불변식.
    # HitlRequest 승인/거부는 여기 하나뿐이던 무방비 경로 — legacy write-scope 를 쥔 agent 키가
    # (자기 것이 아닌) 남의 gate_approval 요청까지 승인/거부할 수 있었다(GATE_SELF_APPROVAL 은
    # self 조합만 막았다). resolve_member 로 실 신원(type)을 확인 — auth.user_id 만으론(agent는
    # team_member id 공간이라) 사람 여부를 알 수 없다.
    resolved = await resolve_member(auth, org_id, repo.session, project_id=project_id)
    if resolved.type != "human":
        return _err("FORBIDDEN", "HITL 승인/거부는 휴먼 멤버만 가능합니다 (에이전트 API키 차단)", 403)
    row = await repo.resolve_request(
        request_id=request_id,
        org_id=org_id,
        project_id=project_id,
        actor_id=auth.user_id,
        status=body.status,
        response_text=body.response_text,
    )
    if row is None:
        return _err("NOT_FOUND_OR_NOT_PENDING", "Request not found or not in pending status", 404)
    return _ok({
        "id": str(row.id),
        "status": row.status,
        "responded_at": row.responded_at.isoformat() if row.responded_at else None,
    })
