"""E1-S3: /api/v2/hypotheses 라우터 (9 엔드포인트, 블루프린트 §3.2~§3.10).

계약: 성공은 raw model/list 반환, 오류는 HTTPException(dict detail {code,message}) —
main.py 핸들러가 {data:null,error:{code,message,...},meta:null}로 감싼다.

라우트 선언 순서: `/draft`를 `/{id}` 계열보다 먼저 선언한다(§3.9.7 — /bulk shadow #1386 재발 방지).

가드 위치:
- §3.7.2 cross-project 링크 금지 — service(hypothesis._assert_targets_same_project)가
  create/draft/link 공통 처리(54a8bd8a: 라우터-only 갭으로 create/draft 우회되던 것 차단).
- §3.1.7 'active' 전이는 owner 휴먼 또는 org owner/admin만 — 라우터에서 보강.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import (
    AuthContext,
    get_current_user,
    get_project_scoped_org_id,
    get_verified_org_id,
)
from app.dependencies.database import get_db, get_read_db
from app.repositories.hypothesis import HypothesisRepository
from app.schemas.hypothesis import (
    HypothesisCreate,
    HypothesisDraftRequest,
    HypothesisDraftResponse,
    HypothesisGuidedCreate,
    HypothesisLifecycleResponse,
    HypothesisLinkRequest,
    HypothesisOutcomeDraftRequest,
    HypothesisResponse,
    HypothesisTransition,
    HypothesisUnlinkRequest,
    HypothesisUpdate,
)
from app.services import hypothesis as svc
from app.services.member_resolver import ResolvedMember, resolve_member
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/hypotheses", tags=["hypotheses", "Work"])


async def _assert_hypothesis_project_access(
    session: AsyncSession, user_id: uuid.UUID, org_id: uuid.UUID, hypothesis_id: uuid.UUID
) -> None:
    """update/unlink/archive는 hyp를 id로 잡는다(service가 org-scope get만 해 project 접근권 미검증).
    resolved-resource(hyp.project_id)에 caller 접근권을 사전검증(404·존재 비노출·body-claimed 금지).
    resolve_member(project_id=)는 no-access를 403으로 내 존재를 노출하므로, 여기선 has_project_access
    직접호출로 404 통일(participation/epics 라운드 선례·존재 비노출)."""
    hyp = await HypothesisRepository(session, org_id).get(hypothesis_id)
    if hyp is None or not await has_project_access(session, user_id, hyp.project_id, org_id):
        raise HTTPException(
            status_code=404,
            detail={"code": "HYPOTHESIS_NOT_FOUND", "message": "가설을 찾을 수 없습니다."},
        )

_ADMIN_ROLES = frozenset({"owner", "admin"})

# 서비스 도메인 오류 code → HTTP status.
_ERROR_STATUS: dict[str, int] = {
    "HUMAN_OWNER_REQUIRED": 400,
    "HUMAN_CONFIRM_REQUIRED": 403,
    "HUMAN_ONLY": 403,  # story #2542 — guided 생성은 휴먼 전용.
    "INVALID_CREATE_STATUS": 422,
    "INVALID_STATUS": 422,
    "OUTCOME_RESULT_REQUIRED": 422,  # story #2038
    "INVALID_HYPOTHESIS_TRANSITION": 409,
    "NO_VALID_FIELDS": 400,
    "HYPOTHESIS_NOT_FOUND": 404,
    "CROSS_PROJECT_LINK_FORBIDDEN": 403,
}


def _raise(err: svc.HypothesisServiceError) -> None:
    raise HTTPException(
        status_code=_ERROR_STATUS.get(err.code, 400),
        detail={"code": err.code, "message": err.message},
    )


def _assert_active_authorized(caller: ResolvedMember, owner_member_id: uuid.UUID, target: str = "active") -> None:
    """§3.1.7 — 'active' 전이는 owner 휴먼 또는 org owner/admin만.

    story #2857: verified/falsified도 같은 규칙 재사용(함수명은 이력 보존을 위해 유지 —
    첫 도입 대상이 active라 붙은 이름, 내부는 target 무관 owner/admin 판정 하나뿐). 기존
    "ACTIVE_TRANSITION_FORBIDDEN" 에러 코드는 target=="active"에 한해 그대로 보존
    (test_hypotheses_router.py가 이미 이 정확한 문자열을 고정 — 무회귀)."""
    if caller.id == owner_member_id or caller.role in _ADMIN_ROLES:
        return
    code = "ACTIVE_TRANSITION_FORBIDDEN" if target == "active" else "TRANSITION_FORBIDDEN"
    raise HTTPException(
        status_code=403,
        detail={"code": code, "message": f"{target} 전이는 owner 또는 org owner/admin만 가능합니다."},
    )


# ── /draft — /{id} 계열보다 먼저 선언(§3.9.7) ────────────────────────────────────

@router.post("/draft", response_model=HypothesisDraftResponse)
async def draft(
    body: HypothesisDraftRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisDraftResponse:
    caller = await resolve_member(auth, org_id, session, project_id=body.project_id)
    try:
        return await svc.draft_hypothesis(session, org_id, caller, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


# ── list / create ──────────────────────────────────────────────────────────────

@router.get("", response_model=list[HypothesisResponse])
async def list_hypotheses(
    auth: AuthContext = Depends(get_current_user),
    project_id: uuid.UUID | None = Query(default=None),
    epic_id: uuid.UUID | None = Query(default=None),
    story_id: uuid.UUID | None = Query(default=None),
    sprint_id: uuid.UUID | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    owner_member_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=2000),
    # story #2451(§6 Phase3 A2): 목록 조회는 create→self-read 흐름이 약함(replica lag
    # 0.86s, PO 승인) — 다른 라우트(create/get/update/delete)의 get_db는 그대로 무접촉.
    session: AsyncSession = Depends(get_read_db),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
) -> list[HypothesisResponse]:
    """story fca4723d(C1): project_id 생략 시 org 전체 가설 조회 — retro list_sessions와
    동형 패턴(app/routers/retros.py). org-wide 조회는 각 항목의 실제 project 접근권으로
    후필터(비접근 project의 가설 비노출 — 존재 자체를 숨기는 404류 원칙과 정합)."""
    items = await svc.list_hypotheses(
        session, org_id, project_id,
        status=status_filter, owner_member_id=owner_member_id,
        epic_id=epic_id, story_id=story_id, sprint_id=sprint_id, limit=limit,
    )
    if project_id is None:
        user_id = uuid.UUID(auth.user_id)
        accessible = [
            item for item in items
            if await has_project_access(session, user_id, item.project_id, org_id)
        ]
        items = accessible
    # story #2233(PO 판정 ㉢, 2026-08-16): X-Total-Count가 `len(items)`(이 페이지에 온
    # 개수)를 "전체"라 거짓 주장했었다 — svc.list_hypotheses는 COUNT를 안 내고, org-wide
    # 분기는 위에서 in-memory 후필터까지 걸려 DB COUNT 하나로도 못 맞힌다. 아무도 이
    # 헤더를 안 읽는다(FE `/api/hypotheses` 프록시는 raw passthrough가 아니라 서비스
    # 재구성이라 헤더 자체가 브라우저까지 안 감, MCP는 headers 참조 0 — 그라운딩 judgment
    # efdeeb8c 실측). 실사용자가 생기면 그때 has_more/next_cursor(#2231 정본 A)를 그
    # 화면과 같이 설계 — 지금은 헤더를 그냥 뺀다(틀린 총량보다 없는 총량).
    return items


@router.post("", response_model=HypothesisResponse, status_code=201)
async def create_hypothesis(
    body: HypothesisCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    # resolve_member(project_id)가 프로젝트 접근을 검증한다(§3.1.2).
    caller = await resolve_member(auth, org_id, session, project_id=body.project_id)
    try:
        return await svc.create_hypothesis(session, org_id, caller, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


# story #2542(v4 «가설 축척» ②첫 가설, 유나 SSOT ae75a8ff): /draft와 동일 이유로 /{id}
# 계열보다 먼저 선언 — "guided"가 hypothesis_id UUID로 오파싱되는 걸 막는다.
@router.post("/guided", response_model=HypothesisResponse, status_code=201)
async def create_hypothesis_guided(
    body: HypothesisGuidedCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    """guided 3부 폼(statement·metric·target·direction) → status=measuring까지 1콜.
    응답은 표준 HypothesisResponse(FE가 읽을 필드는 다른 생성 경로와 동일 — id/statement/
    metric_definition/status/measure_after 등, status가 "measuring"으로 확定됨)."""
    caller = await resolve_member(auth, org_id, session, project_id=body.project_id)
    try:
        return await svc.create_hypothesis_guided(session, org_id, caller, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


# ── by-id ────────────────────────────────────────────────────────────────────

@router.get("/{hypothesis_id}", response_model=HypothesisResponse)
async def get_hypothesis(
    hypothesis_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    # #2237: 형제(update_hypothesis)와 동일한 project 접근권 가드 추가(기존엔 org-scope만 봤다·
    # auth 파라미터 자체가 없었다).
    await _assert_hypothesis_project_access(session, uuid.UUID(auth.user_id), org_id, hypothesis_id)
    try:
        return await svc.get_hypothesis(session, org_id, hypothesis_id)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.get("/{hypothesis_id}/lifecycle", response_model=HypothesisLifecycleResponse)
async def get_hypothesis_lifecycle(
    hypothesis_id: uuid.UUID,
    session: AsyncSession = Depends(get_read_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisLifecycleResponse:
    """story #2533(E-FLOW-V4 S3) — 5축 수직 서사 조립(N+1 회피). get_read_db: 순수 읽기
    조립이고 create→self-read 흐름이 아니다(hypothesis/story/goal 전부 이미 커밋된 것만
    본다 — Phase3 §6 read replica 기준과 정합)."""
    await _assert_hypothesis_project_access(session, uuid.UUID(auth.user_id), org_id, hypothesis_id)
    try:
        return await svc.get_hypothesis_lifecycle(session, org_id, hypothesis_id)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.patch("/{hypothesis_id}", response_model=HypothesisResponse)
async def update_hypothesis(
    hypothesis_id: uuid.UUID,
    body: HypothesisUpdate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    await _assert_hypothesis_project_access(session, uuid.UUID(auth.user_id), org_id, hypothesis_id)
    caller = await resolve_member(auth, org_id, session)
    try:
        return await svc.update_hypothesis(session, org_id, caller, hypothesis_id, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.post("/{hypothesis_id}/transition", response_model=HypothesisResponse)
async def transition_hypothesis(
    hypothesis_id: uuid.UUID,
    body: HypothesisTransition,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    # #2237: 형제(update_hypothesis/unlink/archive)와 동일한 project 접근권 가드를 status 값과
    # 무관하게 전 전이에 적용(기존엔 status=="active" 분기 안에만 있던 hyp 조회가 owner/admin
    # role 체크로만 쓰였을 뿐, project 접근권 자체는 어떤 status 로도 검증되지 않았다 — #2198과
    # 동형 「타입 분기 안에 갇힌 검사」. 同org 비-project 멤버도 kill/verify/falsify/archive 가능하던 갭).
    await _assert_hypothesis_project_access(session, uuid.UUID(auth.user_id), org_id, hypothesis_id)
    caller = await resolve_member(auth, org_id, session)
    # §3.1.7 active 전이 권한은 라우터에서 보강(owner 휴먼 또는 org admin/owner).
    # story #2857 AC(부수 발견 처방, 페드루 PO 판정 2026-08-20) — verified/falsified 직통로가
    # 지금까지 human-only 가드 없이 열려 있었다(2038 시대 「근거 강제된 누구나 종결」 의도적
    # 설계였으나, 2845-B의 «확定=휴먼» 게이트 계약과 함께 도입하지 않으면 게이트를 거치지 않고
    # 우회할 수 있었다). 게이트 신설과 이 차단을 한 PR에서 원자적으로 — 에이전트의 유일한 길은
    # 초안 게이트(hypothesis_outcome_confirm), 사람의 길은 이 직접 transition 그대로 유지.
    if body.status in ("active", "verified", "falsified"):
        repo = HypothesisRepository(session, org_id)
        hyp = await repo.get(hypothesis_id)
        if hyp is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "HYPOTHESIS_NOT_FOUND", "message": "가설을 찾을 수 없습니다."},
            )
        _assert_active_authorized(caller, hyp.owner_member_id, target=body.status)
    try:
        return await svc.transition_hypothesis(session, org_id, caller, hypothesis_id, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.post("/{hypothesis_id}/outcome-draft")
async def draft_hypothesis_outcome_endpoint(
    hypothesis_id: uuid.UUID,
    body: HypothesisOutcomeDraftRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """story #2857 — 측정 판정 초안 제출(agent/human 둘 다 호출 가능·확定은 게이트 승인만).

    새 authz 0 — 게이트가 항상 human-only pending(_ALWAYS_MANUAL_GATE_TYPES)이라 이
    엔드포인트 자체는 project 접근권만 요구한다(제출≠확定, 확定 축은 transition_gate가 막는다).
    """
    await _assert_hypothesis_project_access(session, uuid.UUID(auth.user_id), org_id, hypothesis_id)
    caller = await resolve_member(auth, org_id, session)
    from app.services.hypothesis_outcome_confirm import (
        HypothesisOutcomeConfirmError,
        draft_hypothesis_outcome,
    )

    try:
        gate = await draft_hypothesis_outcome(
            session, org_id, caller.id, hypothesis_id,
            draft_target=body.draft_target, draft_actual=body.draft_actual,
            draft_reason=body.draft_reason,
        )
        await session.commit()
    except HypothesisOutcomeConfirmError as err:
        _status = {"HYPOTHESIS_NOT_FOUND": 404}.get(err.code, 422)
        raise HTTPException(status_code=_status, detail={"code": err.code, "message": err.message})
    return {"gate_id": str(gate.id), "gate_status": gate.status}


@router.post("/{hypothesis_id}/links", response_model=HypothesisResponse)
async def link_hypothesis(
    hypothesis_id: uuid.UUID,
    body: HypothesisLinkRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    # #2237: 형제(unlink_hypothesis)와 동일하게 caller 의 hypothesis project 접근권 사전검증
    # (기존엔 service 의 _assert_targets_same_project 가 "링크 대상들이 서로 같은 project인가"만
    # 봤을 뿐 caller 접근권은 전혀 안 봤다 — 同org 비-project 멤버도 링크 주입 가능하던 갭).
    await _assert_hypothesis_project_access(session, uuid.UUID(auth.user_id), org_id, hypothesis_id)
    # §3.7.2 cross-project 링크 금지 + 존재 검증은 service(link_hypothesis)가 단일 처리.
    try:
        return await svc.link_hypothesis(session, org_id, hypothesis_id, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.delete("/{hypothesis_id}/links", response_model=HypothesisResponse)
async def unlink_hypothesis(
    hypothesis_id: uuid.UUID,
    body: HypothesisUnlinkRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> HypothesisResponse:
    await _assert_hypothesis_project_access(session, uuid.UUID(auth.user_id), org_id, hypothesis_id)
    try:
        return await svc.unlink_hypothesis(session, org_id, hypothesis_id, body)
    except svc.HypothesisServiceError as err:
        _raise(err)


@router.delete("/{hypothesis_id}", status_code=200)
async def archive_hypothesis(
    hypothesis_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    await _assert_hypothesis_project_access(session, uuid.UUID(auth.user_id), org_id, hypothesis_id)
    try:
        await svc.archive_hypothesis(session, org_id, hypothesis_id)
    except svc.HypothesisServiceError as err:
        _raise(err)
    return {"ok": True}
