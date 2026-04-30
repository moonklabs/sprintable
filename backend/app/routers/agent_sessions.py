import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.agent_session import AgentSessionError, AgentSessionRepository
from app.schemas.agent_session import TransitionSessionRequest

router = APIRouter(prefix="/api/v2/agent-sessions", tags=["agent-sessions"])


def _repo(session: AsyncSession = Depends(get_db)) -> AgentSessionRepository:
    return AgentSessionRepository(session)


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


@router.get("")
async def list_sessions(
    agent_id: uuid.UUID | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentSessionRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    sessions = await repo.list(org_id, project_id, agent_id=agent_id, status=status, limit=limit)
    return _ok({"sessions": [s.model_dump(mode="json") for s in sessions]})


@router.patch("/{id}")
async def transition_session(
    id: uuid.UUID,
    body: TransitionSessionRequest,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentSessionRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    try:
        session = await repo.transition(
            session_id=id,
            org_id=org_id,
            project_id=project_id,
            actor_id=uuid.UUID(auth.user_id),
            status=body.status,
            reason=body.reason,
        )
        return _ok({"session": session.model_dump(mode="json"), "resumptions": []})
    except AgentSessionError as e:
        return _err(e.code, str(e), e.status)
