"""story #2845(loop-closure P2) — /api/v2/loop-measure-due 라우터.

읽기전용 큐 하나뿐(GET /queue) — claim은 신규 엔드포인트 0(§AC⑤, 페드루 PO 판정
2026-08-20): 기존 PATCH /hypotheses/{id}(owner_member_id)·PATCH /goals/{id}(assignee_id)가
이미 그 authz 하에 claim 역할을 한다. dismiss 없음(§AC④) — 큐 소거는 실 판정(가설
resolve·goal outcome)뿐, 별도 액션을 만들면 §4 반증설계가 경계한 위조 채널이 된다.

authz — story #4350(2026-09-26, 페드루 PO 재판정): `project_id` 무파라미터 기본값은 **caller가 접근 가능한 프로젝트의
항목만**(`accessible_project_ids_in_org`). 예전(2026-08-20)엔 «같은 3축이 command_center attention으로 이미 org-wide 노출»을
근거로 org-wide를 유지했으나, 선생님 SEC-S8(«org-level = 갭»)이 상위 규칙이라 그 판정을 고쳤다(화면 동작 변화 — 선생님
보고에 «SEC-S8 적용 · 뒤집을 수 있음»). 고아 발견은 접근 가능한 범위(owner/admin은 org 전체)에서 그대로. **`project_id`가 명시 제공되면**
그 필터가 project 접근권 우회로가 되지 않도록 `get_project_scoped_org_id`(has_project_access
SSOT, hypotheses.py list_hypotheses와 동형 — story #2697 패턴 재사용)로 fail-closed
검증한다.
"""
import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_project_scoped_org_id
from app.dependencies.database import get_read_db
from app.services.loop_measure_due import list_measure_due_queue

router = APIRouter(prefix="/api/v2/loop-measure-due", tags=["loop-measure-due", "Work"])


@router.get("/queue")
async def get_measure_due_queue(
    project_id: uuid.UUID | None = Query(default=None),
    unclaimed_only: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
    session: AsyncSession = Depends(get_read_db),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    from app.services.project_auth import accessible_project_ids_in_org

    project_ids = None
    if project_id is None:
        project_ids = await accessible_project_ids_in_org(session, uuid.UUID(auth.user_id), org_id)
    return await list_measure_due_queue(
        session, org_id,
        project_id=project_id, project_ids=project_ids, unclaimed_only=unclaimed_only, limit=limit, offset=offset,
    )
