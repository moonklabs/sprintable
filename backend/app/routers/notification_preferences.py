"""S-A3: Notification Preferences CRUD API."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.notification_preference import NotificationPreference
from app.models.team import TeamMember
from app.services.member_resolver import ResolvedMember, resolve_member

router = APIRouter(prefix="/api/v2/notification-preferences", tags=["notification-preferences"])

_VALID_CHANNELS = {"sse", "discord", "telegram", "in_app"}
_VALID_LEVELS = {"all", "mentions", "mute"}
_VALID_SCOPE_TYPES = {"global", "project", "conversation", "thread"}


# ─── Schemas ──────────────────────────────────────────────────────────────────

class PreferenceItem(BaseModel):
    scope_type: str
    scope_id: uuid.UUID | None = None
    channel: str
    level: str


class UpsertPreferencesRequest(BaseModel):
    preferences: list[PreferenceItem]


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _get_member(
    auth: AuthContext, org_id: uuid.UUID, db: AsyncSession
) -> "ResolvedMember | TeamMember":
    """현재 인증 주체의 멤버 신원.

    E-MEMBER-SSOT AC2-2: API키→team_member; JWT 휴먼→team_member 우선(기존 preference
    키 보존), 없으면 org_member(grant-only 휴먼)로 fallback (35a0691e 잔여 해소).
    """
    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    if is_api_key:
        member = (await db.execute(
            select(TeamMember).where(TeamMember.id == uuid.UUID(auth.user_id))
        )).scalars().first()
        if member is None:
            raise HTTPException(status_code=400, detail="Team member not found")
        return member

    # JWT 휴먼: team_member 우선 (기존 NotificationPreference.member_id 키 보존)
    member = (await db.execute(
        select(TeamMember).where(
            TeamMember.user_id == uuid.UUID(auth.user_id),
            TeamMember.org_id == org_id,
        )
    )).scalars().first()
    if member is not None:
        return member

    # team_member 없음(grant-only 휴먼) → org_member 신원으로 fallback
    return await resolve_member(auth, org_id, db)


def _pref_to_dict(p: NotificationPreference) -> dict:
    return {
        "id": str(p.id),
        "member_id": str(p.member_id),
        "scope_type": p.scope_type,
        "scope_id": str(p.scope_id) if p.scope_id else None,
        "channel": p.channel,
        "level": p.level,
        "updated_at": p.updated_at.isoformat(),
    }


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("")
async def get_preferences(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/notification-preferences — 현재 멤버의 전체 preference 조회."""
    member = await _get_member(auth, org_id, db)
    rows = (await db.execute(
        select(NotificationPreference).where(NotificationPreference.member_id == member.id)
    )).scalars().all()
    return {"data": [_pref_to_dict(p) for p in rows]}


@router.put("")
async def upsert_preferences(
    body: UpsertPreferencesRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """PUT /api/v2/notification-preferences — upsert (INSERT ON CONFLICT UPDATE)."""
    member = await _get_member(auth, org_id, db)

    results = []
    for item in body.preferences:
        if item.channel not in _VALID_CHANNELS:
            raise HTTPException(status_code=422, detail=f"Invalid channel '{item.channel}'. Must be one of: {sorted(_VALID_CHANNELS)}")
        if item.level not in _VALID_LEVELS:
            raise HTTPException(status_code=422, detail=f"Invalid level '{item.level}'. Must be one of: {sorted(_VALID_LEVELS)}")
        if item.scope_type not in _VALID_SCOPE_TYPES:
            raise HTTPException(status_code=422, detail=f"Invalid scope_type '{item.scope_type}'.")

        # agent는 assigned conversation/thread에 mute 설정 불가
        if member.type == "agent" and item.level == "mute" and item.scope_type in ("conversation", "thread"):
            raise HTTPException(status_code=400, detail="Agent cannot mute assigned conversation or thread")

        now = datetime.now(timezone.utc)
        stmt = (
            pg_insert(NotificationPreference)
            .values(
                id=uuid.uuid4(),
                member_id=member.id,
                scope_type=item.scope_type,
                scope_id=item.scope_id,
                channel=item.channel,
                level=item.level,
                created_at=now,
                updated_at=now,
            )
        )
        # partial unique index에 맞는 conflict target 선택
        if item.scope_id is None:
            stmt = stmt.on_conflict_do_update(
                index_elements=["member_id", "scope_type", "channel"],
                index_where=NotificationPreference.scope_id.is_(None),
                set_={"level": item.level, "updated_at": now},
            )
        else:
            stmt = stmt.on_conflict_do_update(
                index_elements=["member_id", "scope_type", "scope_id", "channel"],
                index_where=NotificationPreference.scope_id.isnot(None),
                set_={"level": item.level, "updated_at": now},
            )
        result = await db.execute(stmt.returning(NotificationPreference))
        row = result.scalar_one()
        results.append(_pref_to_dict(row))

    await db.commit()
    return {"data": results}
