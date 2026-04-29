import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.meeting import MeetingRepository
from app.schemas.meeting import MeetingCreate, MeetingResponse, MeetingUpdate

router = APIRouter(prefix="/api/v2/meetings", tags=["meetings"])


def _get_repo(
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> MeetingRepository:
    return MeetingRepository(session, project_id)


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
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> MeetingResponse:
    repo = MeetingRepository(session, project_id)
    meeting = await repo.get(id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return MeetingResponse.model_validate(meeting)


@router.patch("/{id}", response_model=MeetingResponse)
async def update_meeting(
    id: uuid.UUID,
    body: MeetingUpdate,
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> MeetingResponse:
    repo = MeetingRepository(session, project_id)
    data = body.model_dump(exclude_unset=True)
    meeting = await repo.update(id, **data)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return MeetingResponse.model_validate(meeting)


@router.delete("/{id}", status_code=200)
async def delete_meeting(
    id: uuid.UUID,
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> dict:
    repo = MeetingRepository(session, project_id)
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return {"ok": True}
