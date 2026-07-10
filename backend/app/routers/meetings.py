import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.repositories.meeting import MeetingRepository
from app.schemas.meeting import MeetingCreate, MeetingResponse, MeetingUpdate

router = APIRouter(prefix="/api/v2/meetings", tags=["meetings"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    _org_id: uuid.UUID = Depends(get_verified_org_id),
    project_id_q: uuid.UUID | None = Query(default=None, alias="project_id"),
) -> MeetingRepository:
    pid = (str(project_id_q) if project_id_q else None) or auth.claims.get("app_metadata", {}).get("project_id")
    if not pid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="project_id required (query param or JWT app_metadata)",
        )
    return MeetingRepository(session, uuid.UUID(str(pid)))


@router.get("", response_model=list[MeetingResponse])
async def list_meetings(
    meeting_type: str | None = Query(default=None),
    repo: MeetingRepository = Depends(_get_repo),
) -> list[MeetingResponse]:
    filters: dict = {}
    if meeting_type:
        filters["meeting_type"] = meeting_type
    meetings = await repo.list(**filters)
    return [MeetingResponse.model_validate(m) for m in meetings]


@router.post("", response_model=MeetingResponse, status_code=201)
async def create_meeting(
    body: MeetingCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> MeetingResponse:
    await enforce_body_context(
        auth_org_id=org_id,
        body_org_id=None,
        body_project_id=body.project_id,
        auth_project_id=auth.claims.get("app_metadata", {}).get("project_id"),
        db=session,
        user_id=uuid.UUID(auth.user_id),
    )
    repo = MeetingRepository(session, body.project_id)
    data = body.model_dump(exclude={"project_id"}, exclude_none=False)
    # AC3-2d(1b): created_by canonical 정규화(레거시 휴먼 tm.id→members.id). (A) write.
    if data.get("created_by"):
        from app.services.member_resolver import canonicalize_member_id
        data["created_by"] = await canonicalize_member_id(data["created_by"], session)
    meeting = await repo.create(**{k: v for k, v in data.items() if v is not None or k in ("participants", "decisions", "action_items")})
    return MeetingResponse.model_validate(meeting)


@router.get("/{id}", response_model=MeetingResponse)
async def get_meeting(
    id: uuid.UUID,
    repo: MeetingRepository = Depends(_get_repo),
) -> MeetingResponse:
    meeting = await repo.get(id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return MeetingResponse.model_validate(meeting)


@router.patch("/{id}", response_model=MeetingResponse)
async def update_meeting(
    id: uuid.UUID,
    body: MeetingUpdate,
    repo: MeetingRepository = Depends(_get_repo),
) -> MeetingResponse:
    data = body.model_dump(exclude_unset=True)
    meeting = await repo.update(id, **data)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return MeetingResponse.model_validate(meeting)


@router.put("/{id}", response_model=MeetingResponse)
async def put_meeting(
    id: uuid.UUID,
    body: MeetingUpdate,
    repo: MeetingRepository = Depends(_get_repo),
) -> MeetingResponse:
    data = body.model_dump(exclude_unset=True)
    meeting = await repo.update(id, **data)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return MeetingResponse.model_validate(meeting)


@router.delete("/{id}", status_code=200)
async def delete_meeting(
    id: uuid.UUID,
    repo: MeetingRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """E-SECURITY SEC-S8(story 83ea3d6a) F — 까심 전수스윕 CRITICAL: `_get_repo`가
    `get_verified_org_id`를 계산만 하고(`_org_id`, dead computation) `MeetingRepository`는
    project_id만으로 스코핑돼(org_id 개념 자체가 없는 repo) org 무관 임의 project_id를 그대로
    받아들였다 — Org B agent가 Org A meeting을 무인증 삭제(200·무감사) 가능했음. SEC-S1과
    동형으로 human-gate + 삭제 감사 추가, 그 위에 target project의 실 org를 caller org와 대조
    (SEC-S6/S7 헬퍼 재사용)."""
    from app.services.member_resolver import resolve_member
    from app.services.project_auth import assert_target_in_caller_org

    target_org_id = (await session.execute(
        text("SELECT org_id FROM projects WHERE id = :pid"), {"pid": str(repo.project_id)},
    )).scalar_one_or_none()
    assert_target_in_caller_org(org_id, target_org_id, not_found_detail="Meeting not found")

    resolved = await resolve_member(auth, org_id, session)
    if resolved.type != "human":
        raise HTTPException(status_code=403, detail="Meeting 삭제는 휴먼 멤버만 가능합니다 (에이전트 API키 차단)")

    meeting = await repo.get(id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")

    from app.models.deletion_audit import DeletionAuditLog
    session.add(DeletionAuditLog(
        id=uuid.uuid4(), org_id=org_id, actor_id=resolved.id,
        entity_type="meeting", entity_id=id, entity_title=meeting.title,
    ))

    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"ok": True}


# ─── AI / Storage 스텁 (EE 기능, 후속 에픽에서 구현) ──────────────────────────

@router.post("/{id}/recording", status_code=501)
async def upload_recording(
    id: uuid.UUID,
    _auth: AuthContext = Depends(get_current_user),
) -> dict:
    raise HTTPException(status_code=501, detail="Recording upload not yet implemented in this environment")


@router.post("/{id}/transcribe", status_code=501)
async def transcribe_meeting(
    id: uuid.UUID,
    _auth: AuthContext = Depends(get_current_user),
) -> dict:
    raise HTTPException(status_code=501, detail="Transcription not yet implemented in this environment")


@router.post("/{id}/summarize", status_code=501)
async def summarize_meeting(
    id: uuid.UUID,
    _auth: AuthContext = Depends(get_current_user),
) -> dict:
    raise HTTPException(status_code=501, detail="AI summarization not yet implemented in this environment")


@router.post("/{id}/summary", status_code=501)
async def create_summary(
    id: uuid.UUID,
    _auth: AuthContext = Depends(get_current_user),
) -> dict:
    raise HTTPException(status_code=501, detail="AI summary not yet implemented in this environment")
