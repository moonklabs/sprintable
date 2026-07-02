"""E-LOOP-LEDGER S3/S4/S5/S22: /api/v2/loops 라우터 (POST/GET/LIST loops + POST/GET artifacts +
POST decision + POST transition, 블루프린트 §3/§4/§5/§22).

계약: 성공은 raw model/list 반환, 오류는 HTTPException(dict detail {code,message}) —
main.py 핸들러가 {data:null,error:{code,message,...},meta:null}로 감싼다(hypotheses.py 동형).

authz(loops):
- POST: resolve_member(auth, org_id, session, project_id=body.project_id)가 project 접근을
  검증(무권한이면 400/403) + caller를 created_by_member_id로 서버 해소.
- LIST: get_project_scoped_org_id 의존성(project_id 쿼리파람 기반, has_project_access SSOT).
- GET(단건)/context-pack: require_loop_project_access(service)가 org-scope 로드 후 has_project_access로
  cross-project IDOR 차단(docs.py의 _require_doc_project_access와 동형).

authz(artifacts, S4) — 2단계:
① loop_id로 loop을 먼저 org-scope 로드(404) → resolve_member(project_id=loop.project_id)로
   caller의 그 project 접근 검증(agent 분기도 root-fix #1815로 보호) + actor 서버 해소.
② asset_id가 그 loop과 같은 project 소유인지(서비스 레벨 ASSET_PROJECT_MISMATCH) — 신규
   크로스-리소스 IDOR 축(타 project asset을 이 loop에 link 못 하게).

authz(decision, S5) — loop project 접근(위와 동일) + **human-only 명시 체크**(gates.py
transition_gate_endpoint와 동형: caller.type != 'human' → 403 — 결정 게이트는 순수 HITL,
에이전트 API키는 자동 승인 불가). gate_type='loop_decision'은 gate_service._ALWAYS_MANUAL_GATE_TYPES에
있어 org disposition posture와 무관하게 항상 human-pending.

status FSM 전이(deciding→executing)는 loop의 전 variant_group이 결판났을 때만 발생(S5 §5).
생성 시 status='draft' 고정.

authz(transition, S22) — loop project 접근(위와 동일, root-fix 보호) — **human-only 아님**
(HITL 판단점이 아니라 순수 워크플로 진행 마커라 agent도 허용. 실제 결정은 여전히 S5의
human-only 게이트만 통과 가능 — 진행은 agent·결정은 human의 분리). 화이트리스트
({briefing,generating,deciding,measuring,abandoned})가 executing/closed를 배제해 S5/S7의
전제(전 슬롯 결정됨·hypothesis 해소됨)를 이 제네릭 엔드포인트로 우회 못 하게 한다.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_project_scoped_org_id, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.loop import LoopRunRepository
from app.schemas.context_pack import ContextPackResponse
from app.schemas.loop import (
    LoopArtifactCreate,
    LoopArtifactResponse,
    LoopArtifactVariantGroup,
    LoopCreate,
    LoopDecisionRequest,
    LoopDecisionResponse,
    LoopResponse,
    LoopTransitionRequest,
)
from app.services import loop as svc
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/loops", tags=["loops"])

# 서비스 도메인 오류 code → HTTP status.
_ERROR_STATUS: dict[str, int] = {
    "LOOP_NOT_FOUND": 404,
    "LOOP_PROJECT_ACCESS_DENIED": 403,
    "ASSET_NOT_FOUND": 404,
    "ASSET_PROJECT_MISMATCH": 403,
    "HYPOTHESIS_NOT_FOUND": 404,
    "HYPOTHESIS_PROJECT_MISMATCH": 403,
    "LOOP_NOT_IN_DECIDING_STATE": 409,
    "GATE_ALREADY_RESOLVED": 409,
    "NO_PENDING_ARTIFACTS_IN_GROUP": 422,
    "ARTIFACT_SET_MISMATCH": 422,
    "INVALID_LOOP_TRANSITION": 409,
    "TRANSITION_NOT_ALLOWED": 422,
    # S14(P2)
    "LOOP_HYPOTHESIS_REQUIRED": 400,
    "HUMAN_OWNER_REQUIRED": 400,
    "INVALID_CREATE_STATUS": 400,
    "CROSS_PROJECT_LINK_FORBIDDEN": 400,
    "HYPOTHESIS_NOT_ACTIVE": 422,
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
    try:
        return await svc.create_loop(session, org_id, caller, body)
    except svc.LoopServiceError as err:
        _raise(err)


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


@router.get("/{loop_id}/context-pack", response_model=ContextPackResponse)
async def get_loop_context_pack(
    loop_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ContextPackResponse:
    """P1-S12: structured Context Pack(S13 UI 패널 데이터 소스, doc fbe5923e §3).

    authz는 get_loop과 동일 — require_loop_project_access(org-scope 로드+has_project_access,
    cross-project IDOR 차단)."""
    try:
        loop = await svc.require_loop_project_access(session, loop_id, uuid.UUID(str(auth.user_id)), org_id)
    except svc.LoopServiceError as err:
        _raise(err)
    from app.services.context_pack_items import build_loop_context_pack
    return await build_loop_context_pack(session, org_id, loop)


@router.post("/{loop_id}/artifacts", response_model=LoopArtifactResponse, status_code=201)
async def create_loop_artifact(
    loop_id: uuid.UUID,
    body: LoopArtifactCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> LoopArtifactResponse:
    loop = await LoopRunRepository(session, org_id).get(loop_id)
    if loop is None:
        raise HTTPException(
            status_code=404, detail={"code": "LOOP_NOT_FOUND", "message": "루프를 찾을 수 없습니다."}
        )
    # ①loop project 접근 — resolve_member(project_id)가 검증(root-fix #1815로 agent도 보호) +
    # 서버 actor 해소(hypotheses/loops POST와 동일 anti-spoofing).
    caller = await resolve_member(auth, org_id, session, project_id=loop.project_id)
    try:
        return await svc.create_loop_artifact(session, org_id, caller, loop, body)
    except svc.LoopServiceError as err:
        _raise(err)


@router.get("/{loop_id}/artifacts", response_model=list[LoopArtifactVariantGroup])
async def list_loop_artifacts(
    loop_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[LoopArtifactVariantGroup]:
    try:
        # get_loop이 require_loop_project_access(GET 단건과 동일 IDOR 방어)를 내부에서 수행 —
        # 결과(LoopResponse)는 authz 게이트 통과 증거로만 쓰고 버린다.
        await svc.get_loop(session, org_id, uuid.UUID(str(auth.user_id)), loop_id)
    except svc.LoopServiceError as err:
        _raise(err)
    return await svc.list_loop_artifacts(session, org_id, loop_id)


@router.post("/{loop_id}/decision", response_model=LoopDecisionResponse)
async def decide_loop(
    loop_id: uuid.UUID,
    body: LoopDecisionRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> LoopDecisionResponse:
    loop = await LoopRunRepository(session, org_id).get(loop_id)
    if loop is None:
        raise HTTPException(
            status_code=404, detail={"code": "LOOP_NOT_FOUND", "message": "루프를 찾을 수 없습니다."}
        )
    # ①loop project 접근 — resolve_member(project_id)가 검증(root-fix #1815로 agent도 보호).
    caller = await resolve_member(auth, org_id, session, project_id=loop.project_id)
    # ⭐human-only(gates.py transition_gate_endpoint와 동형) — 결정 게이트는 순수 HITL, agent 승인 불가.
    if caller.type != "human":
        raise HTTPException(
            status_code=403,
            detail={"code": "DECISION_HUMAN_ONLY", "message": "루프 결정은 휴먼 멤버만 가능합니다 (에이전트 불가)."},
        )
    try:
        return await svc.decide_loop_artifacts(session, org_id, caller, loop, body)
    except svc.LoopServiceError as err:
        _raise(err)


@router.post("/{loop_id}/transition", response_model=LoopResponse)
async def transition_loop(
    loop_id: uuid.UUID,
    body: LoopTransitionRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> LoopResponse:
    loop = await LoopRunRepository(session, org_id).get(loop_id)
    if loop is None:
        raise HTTPException(
            status_code=404, detail={"code": "LOOP_NOT_FOUND", "message": "루프를 찾을 수 없습니다."}
        )
    # loop project 접근 — resolve_member(project_id)가 검증(root-fix #1815로 agent도 보호).
    # human-only 아님 — 진행은 agent도 가능(결정은 여전히 S5 human-only 게이트만 통과 가능).
    await resolve_member(auth, org_id, session, project_id=loop.project_id)
    try:
        return await svc.transition_loop(session, org_id, loop, body.status)
    except svc.LoopServiceError as err:
        _raise(err)
