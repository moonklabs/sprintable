import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.meeting import MeetingRepository
from app.schemas.meeting import MeetingCreate, MeetingResponse, MeetingUpdate

router = APIRouter(prefix="/api/v2/meetings", tags=["meetings"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
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
    _auth: AuthContext = Depends(get_current_user),
) -> MeetingResponse:
    repo = MeetingRepository(session, body.project_id)
    data = body.model_dump(exclude={"project_id"}, exclude_none=False)
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
) -> dict:
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
