"""E-LOOP-LEDGER S3: /api/v2/loops 라우터 (POST/GET/LIST, 블루프린트 §3).

계약: 성공은 raw model/list 반환, 오류는 HTTPException(dict detail {code,message}) —
main.py 핸들러가 {data:null,error:{code,message,...},meta:null}로 감싼다(hypotheses.py 동형).

authz:
- POST: resolve_member(auth, org_id, session, project_id=body.project_id)가 project 접근을
  검증(무권한이면 400/403) + caller를 created_by_member_id로 서버 해소.
- LIST: get_project_scoped_org_id 의존성(project_id 쿼리파람 기반, has_project_access SSOT).
- GET(단건): _require_loop_project_access(service)가 org-scope 로드 후 has_project_access로
  cross-project IDOR 차단(docs.py의 _require_doc_project_access와 동형).

status FSM 전이는 이 스토리의 스코프 밖(S5 게이트/후속) — 생성 시 status='draft' 고정.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_project_scoped_org_id, get_verified_org_id
from app.dependencies.database import get_db
from app.schemas.loop import LoopCreate, LoopResponse
from app.services import loop as svc
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/loops", tags=["loops"])

# 서비스 도메인 오류 code → HTTP status.
_ERROR_STATUS: dict[str, int] = {
    "LOOP_NOT_FOUND": 404,
    "LOOP_PROJECT_ACCESS_DENIED": 403,
}


def _raise(err: svc.LoopServiceError) -> None:
    raise HTTPException(
        status_code=_ERROR_STATUS.get(err.code, 400),
        detail={"code": err.code, "message": err.message},
    )


@router.get("", response_model=list[LoopResponse])
async def list_loops(
    response: Response,
    project_id: uuid.UUID = Query(...),
    status_filter: str | None = Query(default=None, alias="status"),
    parent_loop_id: uuid.UUID | None = Query(default=None),
    goal_tag: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=2000),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
) -> list[LoopResponse]:
    items = await svc.list_loops(
        session, org_id, project_id,
        status=status_filter, parent_loop_id=parent_loop_id, goal_tag=goal_tag, limit=limit,
    )
    response.headers["X-Total-Count"] = str(len(items))
    return items


@router.post("", response_model=LoopResponse, status_code=201)
async def create_loop(
    body: LoopCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> LoopResponse:
    # resolve_member(project_id)가 프로젝트 접근을 검증한다(hypotheses.create_hypothesis와 동형).
    caller = await resolve_member(auth, org_id, session, project_id=body.project_id)
    return await svc.create_loop(session, org_id, caller, body)


@router.get("/{loop_id}", response_model=LoopResponse)
async def get_loop(
    loop_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> LoopResponse:
    try:
        return await svc.get_loop(session, org_id, uuid.UUID(str(auth.user_id)), loop_id)
    except svc.LoopServiceError as err:
        _raise(err)
