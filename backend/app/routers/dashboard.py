import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_read_db
from app.schemas.dashboard import DashboardResponse
from app.services.dashboard_core import MemberNotFoundError, get_my_work

router = APIRouter(prefix="/api/v2/dashboard", tags=["dashboard", "Work"])


@router.get("", response_model=DashboardResponse)
async def get_dashboard(
    member_id: uuid.UUID = Query(...),
    project_id: uuid.UUID | None = Query(default=None),
    # story #2451(§6 Phase3 A1): 대시보드 집계·create→self-read 흐름 없음 → read replica.
    session: AsyncSession = Depends(get_read_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> DashboardResponse:
    """prod 핫픽스(S20 전수스캔 MUST): cross-org 데이터 누출 차단.

    이전엔 org_id 검증 자체가 없어(get_verified_org_id 미호출) 임의 member_id로 타 org 멤버의
    대시보드(할당 스토리/태스크)를 그대로 열람할 수 있었다 — `project_id`를 명시하면 member 조회
    자체가 생략돼 더 심했다. member가 caller org 소속인지 항상 검증(project_id 명시 여부 무관).
    assignee 기준 열람 자체는 stories/tasks 목록 필터와 동일한 프로젝트 협업 시야라 자기 자신으로
    제한하지 않는다(PO 확인).

    ⛔story #2268: 쿼리 본체는 `dashboard_core.get_my_work`로 뽑았다(session_context_core.py가
    같은 함수를 재사용 — 재구현 0). 이 라우터는 그 함수를 부르고 404로 번역하는 얇은 래퍼다.
    """
    try:
        my_stories, my_tasks = await get_my_work(
            session, org_id=org_id, member_id=member_id, project_id=project_id,
        )
    except MemberNotFoundError as e:
        raise HTTPException(status_code=404, detail="Member not found or inactive") from e

    return DashboardResponse(my_stories=my_stories, my_tasks=my_tasks, open_memos=[])
