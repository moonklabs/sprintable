"""story #2223 후속(오르테가군 판정, 2026-07-30) — 「방금 닫힌 것의 다음」(유나양 화면
1순위 근거) 재료를 org 전체(project 스코프)에서 한 번에 꺼내는 자리.

⛔에픽 단위 벌크(`GET /goals/{id}/reference-candidates`)는 "어느 에픽인지 이미 아는" 호출을
전제한다 — 이 기능은 정반대(「아직 안 보고 있는 걸 찾아 준다」)라 축이 다르다. 그래서 별도
엔드포인트로 분리했다(오르테가군 판정 — 기존 벌크에 파라미터를 얹거나 FE가 두 번 불러
합치는 대신). project_id를 필수로 받는다 — 이 표(reference_semantic_candidates)는 org
스코프지만, 접근권 검증은 has_project_access의 project 단위 게이트가 기존 전체 컨벤션이라
그대로 재사용한다(새 인가 경로 발명 없음).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/reference-candidates", tags=["reference-candidates", "Work"])


@router.get("/next-up")
async def get_next_up_reference_candidates(
    project_id: uuid.UUID = Query(...),
    recent_days: int = Query(default=14, ge=1, le=90),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[dict]:
    """GET .../reference-candidates/next-up?project_id=...&recent_days=14 — done 소스 →
    backlog 타깃 후보를 «전량» 반환한다(자르지 않는다, 유나양 "거르지 않고 근거를 붙여
    위로 올린다" 원칙). `recent_days` 이내에 소스가 done된 것만 `is_recent=true`로
    표시돼 정렬 앞쪽에 온다 — 필터가 아니라 정렬 가중치일 뿐이다.

    응답의 source_story_number/source_title/source_closed_at은 FE가 재조회 없이
    "#2123과 이어져 있습니다" 문구를 바로 짤 수 있도록 이미 얹은 것(계산은 BE 원칙)."""
    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

    from app.services.reference_semantic_candidates import list_next_up_candidates

    candidates = await list_next_up_candidates(
        session, org_id=org_id, project_id=project_id, recent_days=recent_days,
    )
    return [
        {
            "id": str(c.id),
            "source_id": str(c.source_id),
            "source_story_number": c.source_story_number,
            "source_title": c.source_title,
            "source_closed_at": c.source_closed_at.isoformat(),
            "target_id": str(c.target_id),
            "target_story_number": c.target_story_number,
            "target_title": c.target_title,
            "relation_kind": c.relation_kind,
            "status": c.status,
            "is_recent": c.is_recent,
        }
        for c in candidates
    ]
