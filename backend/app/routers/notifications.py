import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.team import TeamMember
from app.repositories.notification import InboxRepository, NotificationRepository, NotificationSettingRepository
from app.schemas.notification import (
    InboxItemResponse,
    NotificationResponse,
    NotificationSettingResponse,
    ResolveInboxItem,
    UpsertNotificationSetting,
)

router = APIRouter(prefix="/api/v2", tags=["notifications"])


async def _resolve_notification_user_id(auth: AuthContext, db: AsyncSession) -> uuid.UUID:
    """auth context → Notification.user_id (supabase user_id) 파생.

    API key 경로: auth.user_id = team_member.id → TeamMember.user_id (supabase) 조회
    JWT 경로: auth.user_id = supabase user_id → 직접 사용
    """
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        result = await db.execute(
            select(TeamMember.user_id).where(TeamMember.id == uuid.UUID(auth.user_id))
        )
        supabase_user_id = result.scalar_one_or_none()
        if supabase_user_id is None:
            raise HTTPException(status_code=400, detail="Team member supabase user_id not found")
        return supabase_user_id
    return uuid.UUID(auth.user_id)


def _notif_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> NotificationRepository:
    return NotificationRepository(session, org_id)


def _inbox_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> InboxRepository:
    return InboxRepository(session, org_id)


@router.get("/notifications", response_model=list[NotificationResponse])
async def list_notifications(
    unread: bool | None = Query(default=None, description="True=읽지 않은 것만, False=읽은 것만"),
    is_read: bool | None = Query(default=None, description="직접 is_read 지정 (unread 우선)"),
    limit: int = Query(default=200, le=200),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: NotificationRepository = Depends(_notif_repo),
) -> list[NotificationResponse]:
    """GET /api/v2/notifications — auth context에서 user_id 자동 파생.

    MCP check_notifications 호환: unread=true → is_read=False 변환.
    """
    user_id = await _resolve_notification_user_id(auth, db)
    resolved_is_read = (not unread) if unread is not None else is_read
    items = await repo.list(user_id=user_id, is_read=resolved_is_read, limit=limit)
    return [NotificationResponse.model_validate(n) for n in items]


@router.get("/notifications/count")
async def count_unread(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: NotificationRepository = Depends(_notif_repo),
) -> dict:
    user_id = await _resolve_notification_user_id(auth, db)
    count = await repo.count_unread(user_id=user_id)
    return {"count": count}


@router.patch("/notifications/mark-all-read", status_code=200)
async def mark_all_read(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: NotificationRepository = Depends(_notif_repo),
) -> dict:
    user_id = await _resolve_notification_user_id(auth, db)
    await repo.mark_all_read(user_id=user_id)
    return {"ok": True}


@router.get("/notification-settings", response_model=list[NotificationSettingResponse])
async def get_notification_settings(
    member_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> list[NotificationSettingResponse]:
    repo = NotificationSettingRepository(session)
    settings = await repo.get_by_member(member_id=member_id)
    return [NotificationSettingResponse.model_validate(s) for s in settings]


@router.put("/notification-settings", response_model=NotificationSettingResponse, status_code=200)
async def upsert_notification_setting(
    member_id: uuid.UUID = Query(...),
    body: UpsertNotificationSetting = ...,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> NotificationSettingResponse:
    repo = NotificationSettingRepository(session)
    setting = await repo.upsert(
        org_id=org_id,
        member_id=member_id,
        channel=body.channel,
        event_type=body.event_type,
        enabled=body.enabled,
    )
    return NotificationSettingResponse.model_validate(setting)


@router.get("/inbox", response_model=list[InboxItemResponse])
async def list_inbox(
    assignee_member_id: uuid.UUID = Query(...),
    state: str | None = Query(default=None),
    repo: InboxRepository = Depends(_inbox_repo),
) -> list[InboxItemResponse]:
    items = await repo.list(assignee_member_id=assignee_member_id, state=state)
    return [InboxItemResponse.model_validate(i) for i in items]


@router.get("/inbox/incoming", response_model=list[InboxItemResponse])
async def list_incoming(
    assignee_member_id: uuid.UUID = Query(...),
    repo: InboxRepository = Depends(_inbox_repo),
) -> list[InboxItemResponse]:
    items = await repo.list_incoming(assignee_member_id=assignee_member_id)
    return [InboxItemResponse.model_validate(i) for i in items]


@router.post("/inbox/{id}/resolve", response_model=InboxItemResponse)
async def resolve_inbox_item(
    id: uuid.UUID,
    body: ResolveInboxItem,
    repo: InboxRepository = Depends(_inbox_repo),
) -> InboxItemResponse:
    item = await repo.resolve(
        id=id,
        resolved_by=body.resolved_by,
        resolved_option_id=body.resolved_option_id,
        resolved_note=body.resolved_note,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="InboxItem not found")
    return InboxItemResponse.model_validate(item)


@router.post("/inbox/{id}/dismiss", response_model=InboxItemResponse)
async def dismiss_inbox_item(
    id: uuid.UUID,
    repo: InboxRepository = Depends(_inbox_repo),
) -> InboxItemResponse:
    item = await repo.dismiss(id=id)
    if item is None:
        raise HTTPException(status_code=404, detail="InboxItem not found")
    return InboxItemResponse.model_validate(item)
