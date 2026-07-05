import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import _is_org_admin
from app.models.team import TeamMember
from app.repositories.notification import InboxRepository, NotificationRepository, NotificationSettingRepository
from app.schemas.notification import (
    InboxItemResponse,
    NotificationResponse,
    NotificationSettingResponse,
    ResolveInboxItem,
    UpsertNotificationSetting,
)
from app.services.member_resolver import assert_caller_is_member, is_caller_member

router = APIRouter(prefix="/api/v2", tags=["notifications"])


async def _assert_self_or_org_admin(
    member_id: uuid.UUID, auth: AuthContext, session: AsyncSession, org_id: uuid.UUID,
) -> None:
    """S19(#4-#6 MUST): notifications/inbox 리소스가 caller-ownership 확인 없이 임의 member_id를
    받아들이던 갭 — self(axis-safe) 또는 org-admin만 허용한다.

    S19(발견·회귀수정): resolve_member()/.id 직접비교(및 그 대체였던 resolve_auth_member 단독
    사용)는 휴먼 JWT caller에서 축이 어긋날 수 있다 — is_caller_member(agent=id 직접비교·
    human=team_members뷰의 user_id 컬럼과 비교)로 axis-safe하게 판정한다.
    """
    if await is_caller_member(member_id, auth, session, org_id):
        return
    if await _is_org_admin(session, org_id, uuid.UUID(auth.user_id)):
        return
    raise HTTPException(status_code=403, detail="Not authorized for this member")


async def _resolve_notification_user_id(auth: AuthContext, db: AsyncSession) -> uuid.UUID:
    """auth context → Notification.user_id 파생. (fc7bce47: misleading 'supabase' 명명 정리.)

    API key 경로: auth.user_id = team_member.id → TeamMember.user_id 조회.
                  agent는 user_id=NULL → team_member.id fallback
                  (알림 dispatch 시 user_id IS NOT NULL 조건으로 agent 제외됨 → 빈 배열 200 반환)
    JWT 경로: auth.user_id = user_id → 직접 사용
    """
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        # team_members projection VIEW — multi-project member N 행. id/user_id 동형이라 .limit(1)(아무 행 OK).
        result = await db.execute(
            select(TeamMember.id, TeamMember.user_id).where(TeamMember.id == uuid.UUID(auth.user_id)).limit(1)
        )
        row = result.one_or_none()
        if row is None:
            raise HTTPException(status_code=400, detail="Team member not found")
        member_id, user_id = row
        return user_id or member_id  # agent: user_id=NULL → member.id fallback
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


@router.patch("/notifications/{id}/read", response_model=NotificationResponse, status_code=200)
async def mark_read(
    id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: NotificationRepository = Depends(_notif_repo),
) -> NotificationResponse:
    """PATCH /api/v2/notifications/{id}/read — 단일 알림 읽음 처리(본인 것만).

    48de882a: Inbox 클릭 시 FE(ApiNotificationRepository.markRead)가 이 경로를 호출하는데
    BE 에 단일 read 엔드포인트가 없어(mark-all-read 만 존재) 실패하던 것을 보강. mark-all-read
    와 동일 시스템(NotificationRepository)·user_id 소유자 스코프.
    """
    user_id = await _resolve_notification_user_id(auth, db)
    notif = await repo.mark_read(id, user_id)
    if notif is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    return NotificationResponse.model_validate(notif)


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
    auth: AuthContext = Depends(get_current_user),
) -> NotificationSettingResponse:
    """S19(#4 MUST): member_id 쿼리파람에 caller-ownership 확인이 없어 누구나 타 member의 알림
    설정을 덮어쓸 수 있었다. self-or-org-admin 게이트 추가."""
    await _assert_self_or_org_admin(member_id, auth, session, org_id)
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
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: InboxRepository = Depends(_inbox_repo),
) -> InboxItemResponse:
    """S19(#5 MUST): auth 파라미터 자체가 없어 caller가 이 inbox item의 assignee인지 확인이
    전혀 없었다 — 누구나 타 member의 inbox item을 resolve할 수 있었고, `resolved_by` 바디값을
    임의로 스푸핑할 수도 있었다. assignee==caller 강제(axis-safe) + resolved_by는 확인된
    assignee_member_id에서 서버-파생(바디값 무시 — identity는 서버가 결정, 클라이언트가
    주장하는 게 아니다). assert_caller_is_member 통과 = caller.id == assignee_member_id가
    이미 확정이므로 별도 caller 재조회 없이 그 값을 그대로 쓴다."""
    item = await repo.get(id)
    if item is None:
        raise HTTPException(status_code=404, detail="InboxItem not found")

    await assert_caller_is_member(
        item.assignee_member_id, auth, session, org_id, detail="Not the assignee of this inbox item",
    )

    resolved = await repo.resolve(
        id=id,
        resolved_by=item.assignee_member_id,
        resolved_option_id=body.resolved_option_id,
        resolved_note=body.resolved_note,
    )
    if resolved is None:
        raise HTTPException(status_code=404, detail="InboxItem not found")
    return InboxItemResponse.model_validate(resolved)


@router.post("/inbox/{id}/dismiss", response_model=InboxItemResponse)
async def dismiss_inbox_item(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    repo: InboxRepository = Depends(_inbox_repo),
) -> InboxItemResponse:
    """S19(#6 MUST): resolve와 동일 갭 — assignee==caller 강제(axis-safe)."""
    item = await repo.get(id)
    if item is None:
        raise HTTPException(status_code=404, detail="InboxItem not found")

    await assert_caller_is_member(
        item.assignee_member_id, auth, session, org_id, detail="Not the assignee of this inbox item",
    )

    dismissed = await repo.dismiss(id=id)
    if dismissed is None:
        raise HTTPException(status_code=404, detail="InboxItem not found")
    return InboxItemResponse.model_validate(dismissed)
