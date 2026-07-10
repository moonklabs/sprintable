"""E-VERIFY V0-S1(story 5a5ba27b): Evidence CRD(D 없는 U — 자기증명은 불변) — story/task 첨부."""
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.evidence import _CLIENT_CREATABLE_TYPES, Evidence
from app.models.pm import Story, Task
from app.services.member_resolver import resolve_member
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/evidence", tags=["evidence"])

_WORK_ITEM_TYPES = frozenset({"story", "task"})


class EvidenceCreateRequest(BaseModel):
    work_item_id: uuid.UUID
    work_item_type: str
    type: str
    ref: str
    source: str | None = None
    note: str | None = None

    @field_validator("work_item_type")
    @classmethod
    def _validate_work_item_type(cls, v: str) -> str:
        if v not in _WORK_ITEM_TYPES:
            raise ValueError(f"work_item_type must be one of {sorted(_WORK_ITEM_TYPES)}")
        return v

    @field_validator("type")
    @classmethod
    def _validate_type(cls, v: str) -> str:
        # gate_approval은 시스템(V0-S2 게이트 승인 훅) 전용 — 공개 API로 직접 생성 시 "이거
        # 승인됐음" 허위 서명 스푸핑 위험이라 여기서 차단(내부 서비스 호출은 이 검증을 안 탐).
        if v not in _CLIENT_CREATABLE_TYPES:
            raise ValueError(
                f"type must be one of {sorted(_CLIENT_CREATABLE_TYPES)} "
                "(gate_approval은 게이트 승인 시 시스템이 자동 생성)"
            )
        return v


class EvidenceResponse(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    work_item_id: uuid.UUID
    work_item_type: str
    type: str
    ref: str
    source: str | None
    note: str | None
    created_by: uuid.UUID
    created_at: Any

    model_config = {"from_attributes": True}


async def _assert_work_item_access(
    session: AsyncSession, work_item_id: uuid.UUID, work_item_type: str,
    caller_id: uuid.UUID, org_id: uuid.UUID,
) -> None:
    """work_item 존재 + caller의 project 접근권 검증(mutation 대상 project-scope 강제
    — [[feedback_mutation_target_resource_project_scope]] 동형)."""
    if work_item_type == "story":
        story = (await session.execute(
            select(Story).where(Story.id == work_item_id, Story.org_id == org_id)
        )).scalar_one_or_none()
        if story is None:
            raise HTTPException(status_code=404, detail="Story not found")
        project_id = story.project_id
    else:
        task = (await session.execute(
            select(Task).where(Task.id == work_item_id, Task.org_id == org_id)
        )).scalar_one_or_none()
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        story = (await session.execute(
            select(Story).where(Story.id == task.story_id)
        )).scalar_one_or_none()
        if story is None:
            raise HTTPException(status_code=404, detail="Parent story not found")
        project_id = story.project_id

    if not await has_project_access(session, caller_id, project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")


@router.post("", response_model=EvidenceResponse, status_code=201)
async def create_evidence(
    body: EvidenceCreateRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> Evidence:
    caller = await resolve_member(auth, org_id, session)
    await _assert_work_item_access(session, body.work_item_id, body.work_item_type, caller.id, org_id)

    evidence = Evidence(
        id=uuid.uuid4(),
        org_id=org_id,
        work_item_id=body.work_item_id,
        work_item_type=body.work_item_type,
        type=body.type,
        ref=body.ref,
        source=body.source,
        note=body.note,
        created_by=caller.id,
    )
    session.add(evidence)
    await session.commit()
    await session.refresh(evidence)
    return evidence


@router.get("", response_model=list[EvidenceResponse])
async def list_evidence(
    work_item_id: uuid.UUID = Query(...),
    work_item_type: str = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[Evidence]:
    if work_item_type not in _WORK_ITEM_TYPES:
        raise HTTPException(status_code=400, detail=f"work_item_type must be one of {sorted(_WORK_ITEM_TYPES)}")

    caller = await resolve_member(auth, org_id, session)
    await _assert_work_item_access(session, work_item_id, work_item_type, caller.id, org_id)

    result = await session.execute(
        select(Evidence).where(
            Evidence.org_id == org_id,
            Evidence.work_item_id == work_item_id,
            Evidence.work_item_type == work_item_type,
        ).order_by(Evidence.created_at.asc())
    )
    return list(result.scalars().all())


@router.delete("/{id}", status_code=204)
async def delete_evidence(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> None:
    """생성자 본인만 철회 가능(타인의 서명을 지울 수 있으면 신뢰 표면이 무너짐) — org-admin도
    포함하지 않음(의도적, blueprint §0 감시-축 회피: admin이 에이전트 증거를 지울 수 있으면
    "누가 주어인가"가 다시 휴먼으로 뒤집힘)."""
    evidence = (await session.execute(
        select(Evidence).where(Evidence.id == id, Evidence.org_id == org_id)
    )).scalar_one_or_none()
    if evidence is None:
        raise HTTPException(status_code=404, detail="Evidence not found")

    caller = await resolve_member(auth, org_id, session)
    if evidence.created_by != caller.id:
        raise HTTPException(status_code=403, detail="Only the creator can retract evidence")

    await session.delete(evidence)
    await session.commit()
