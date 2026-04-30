import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.notification import InboxRepository, NotificationRepository, NotificationSettingRepository
from app.schemas.notification import (
    InboxItemResponse,
    NotificationResponse,
    NotificationSettingResponse,
    ResolveInboxItem,
    UpsertNotificationSetting,
)

router = APIRouter(prefix="/api/v2", tags=["notifications"])


def _get_org_id(
    auth: AuthContext = Depends(get_current_user),
    x_org_id: str | None = Header(default=None, alias="X-Org-Id"),
) -> uuid.UUID:
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id") or x_org_id
    if not org_id_str:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id required")
    return uuid.UUID(str(org_id_str))


def _notif_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(_get_org_id),
) -> NotificationRepository:
    return NotificationRepository(session, org_id)


def _inbox_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(_get_org_id),
) -> InboxRepository:
    return InboxRepository(session, org_id)


@router.get("/notifications", response_model=list[NotificationResponse])
async def list_notifications(
    user_id: uuid.UUID = Query(...),
    is_read: bool | None = Query(default=None),
    repo: NotificationRepository = Depends(_notif_repo),
) -> list[NotificationResponse]:
    items = await repo.list(user_id=user_id, is_read=is_read)
    return [NotificationResponse.model_validate(n) for n in items]


@router.get("/notifications/count")
async def count_unread(
    user_id: uuid.UUID = Query(...),
    repo: NotificationRepository = Depends(_notif_repo),
) -> dict:
    count = await repo.count_unread(user_id=user_id)
    return {"count": count}


@router.patch("/notifications/mark-all-read", status_code=200)
async def mark_all_read(
    user_id: uuid.UUID = Query(...),
    repo: NotificationRepository = Depends(_notif_repo),
) -> dict:
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
    org_id: uuid.UUID = Depends(_get_org_id),
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
