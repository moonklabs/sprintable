"""S-A3: Notification Preferences CRUD API."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.notification_preference import NotificationPreference
from app.models.team import TeamMember
from app.services.member_resolver import ResolvedMember, resolve_member

router = APIRouter(prefix="/api/v2/notification-preferences", tags=["notification-preferences", "Organization"])

_VALID_CHANNELS = {"sse", "discord", "telegram", "in_app"}
_VALID_LEVELS = {"all", "mentions", "mute"}
# story #2637 §0-c: "event_key" 신설 — 대화-구조 축(project/conversation/thread)과 다른
# 별개 차원(이벤트 타입 축). scope_id는 안 쓰고 event_key 컬럼을 쓴다(migration 0250).
_VALID_SCOPE_TYPES = {"global", "project", "conversation", "thread", "event_key"}


# ─── Schemas ──────────────────────────────────────────────────────────────────

class PreferenceItem(BaseModel):
    scope_type: str
    scope_id: uuid.UUID | None = None
    # story #2637 §0-c: scope_type="event_key"일 때만 사용(그 외엔 반드시 None).
    event_key: str | None = None
    channel: str
    level: str


class UpsertPreferencesRequest(BaseModel):
    # story #2623(2026-08-14) — admin override 대상(None=self, 기존 동작 그대로 무회귀).
    # 지정 시 caller org 스코프로 서버측 재해소(_resolve_target_member_id, webhooks.py
    # story 933248fa 그대로 재사용 — body-claimed org 불신, SEC 규율①과 동형).
    member_id: uuid.UUID | None = None
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

    # AC3-2d(2): JWT 휴먼 → canonical members.id(=org_member.id). 0086이 notification_preferences.member_id를
    # canonical로 정규화하므로 read/write도 canonical이어야 split-brain(기존 휴먼 prefs 유실) 0.
    # (이전엔 team_member 우선=tm.id 반환이었으나 (A) 통일로 canonical 단일화 — grant-only도 동일 경로.)
    return await resolve_member(auth, org_id, db)


def _pref_to_dict(p: NotificationPreference) -> dict:
    return {
        "id": str(p.id),
        "member_id": str(p.member_id),
        "scope_type": p.scope_type,
        "scope_id": str(p.scope_id) if p.scope_id else None,
        "event_key": p.event_key,
        "channel": p.channel,
        "level": p.level,
        "updated_at": p.updated_at.isoformat(),
    }


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("")
async def get_preferences(
    # story #2623: Query(default=None) 대신 평범한 None 기본값 — HTTP 서빙 동작은 동일(GET의
    # 단순 타입 파라미터는 FastAPI가 자동으로 query param 취급)하지만, 이 코드베이스의 지배적
    # 테스트 관례(라우터 함수를 FastAPI 디스패치 없이 직접 호출)에서 member_id를 생략하면
    # Query(default=None) 센티널 객체 자체가 그대로 새어들어와 "member_id is not None"이 참이
    # 되는 회귀를 낳는다(test_2637_notification_preference_router_event_key.py 실측 발견).
    member_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """GET /api/v2/notification-preferences — 현재 멤버(또는 admin override 대상)의 전체
    preference 조회.

    story #2623(2026-08-14) — webhooks.py story 933248fa의 「제1 경고」 그대로 준수: PUT만
    admin override를 넣고 GET을 빠뜨리면 「저장은 되는데 목록에 안 보임」으로 재오픈된다 —
    GET/PUT 둘 다 동시에 연다. `?member_id=` 미지정 시 caller-scope(기존 동작 무회귀).
    지정 시 caller org 스코프로 서버측 재해소 후, 그 결과가 caller 자신이 아니면 admin/owner
    role 필수(무권한 403 명시 — 침묵 caller-scope 강제 금지)."""
    member = await _get_member(auth, org_id, db)
    scope_member_id = member.id
    if member_id is not None:
        from app.routers.webhooks import _resolve_target_member_id

        target_member_id = await _resolve_target_member_id(member_id, org_id, db)
        if target_member_id != member.id:
            role = auth.claims.get("app_metadata", {}).get("role", "member")
            if role not in ("admin", "owner"):
                raise HTTPException(
                    status_code=403,
                    detail="Admin role required to view another member's notification preferences",
                )
        scope_member_id = target_member_id
    rows = (await db.execute(
        select(NotificationPreference).where(NotificationPreference.member_id == scope_member_id)
    )).scalars().all()
    return {"data": [_pref_to_dict(p) for p in rows]}


@router.put("")
async def upsert_preferences(
    body: UpsertPreferencesRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    """PUT /api/v2/notification-preferences — upsert (INSERT ON CONFLICT UPDATE).

    story #2623(2026-08-14) — webhooks.py story 933248fa와 동형 admin override: 산티아고의
    원 IDOR 방어(caller-only)는 `body.member_id` 미지정 경로에 바이트 단위로 그대로 유지된다
    (기존 self-service 무회귀). `body.member_id` 지정 시 caller org 스코프로 서버측 재해소
    (`_resolve_target_member_id` 재사용 — body-claimed org 신뢰 금지) 후, 해소된 target이
    caller 자신과 다르면 admin/owner role 필수(JWT app_metadata.role, 서버 검증된 클레임) —
    아니면 명시 403(침묵 caller-scope 강제 저장 금지)."""
    member = await _get_member(auth, org_id, db)

    target_member_id = member.id
    target_is_agent = member.type == "agent"
    if body.member_id is not None:
        from app.routers.webhooks import _resolve_target_member_id

        target_member_id = await _resolve_target_member_id(body.member_id, org_id, db)
        if target_member_id != member.id:
            role = auth.claims.get("app_metadata", {}).get("role", "member")
            if role not in ("admin", "owner"):
                raise HTTPException(
                    status_code=403,
                    detail="Admin role required to configure another member's notification preferences",
                )
            # story #2623 조건④: agent mute 금지 룰은 «대상»(target) 기준 — caller(admin,
            # 보통 휴먼)의 type이 아니라 override된 target이 실제 agent인지로 판정해야 한다.
            # _resolve_target_member_id는 agent면 TeamMember.id를 그대로 돌려주므로(캐너 축
            # 그대로) 그 id로 TeamMember를 다시 조회해 agent 여부만 확인(재구현 아님 — 존재
            # 확인 1쿼리).
            target_is_agent = (await db.execute(
                select(TeamMember.id).where(
                    TeamMember.id == target_member_id, TeamMember.org_id == org_id,
                    TeamMember.type == "agent",
                )
            )).scalar_one_or_none() is not None

    results = []
    for item in body.preferences:
        if item.channel not in _VALID_CHANNELS:
            raise HTTPException(status_code=422, detail=f"Invalid channel '{item.channel}'. Must be one of: {sorted(_VALID_CHANNELS)}")
        if item.level not in _VALID_LEVELS:
            raise HTTPException(status_code=422, detail=f"Invalid level '{item.level}'. Must be one of: {sorted(_VALID_LEVELS)}")
        if item.scope_type not in _VALID_SCOPE_TYPES:
            raise HTTPException(status_code=422, detail=f"Invalid scope_type '{item.scope_type}'.")

        # story #2637 §0-c: event_key 축은 scope_id가 아니라 event_key 컬럼을 쓴다 — 둘의
        # 상호배타를 여기서 강제(모호한 이중 스코프 조합을 저장하지 않는다).
        if item.scope_type == "event_key":
            if not item.event_key:
                raise HTTPException(status_code=422, detail="scope_type='event_key'는 event_key가 필수입니다.")
            if item.scope_id is not None:
                raise HTTPException(status_code=422, detail="scope_type='event_key'는 scope_id를 가질 수 없습니다.")
        elif item.event_key is not None:
            raise HTTPException(
                status_code=422, detail=f"scope_type='{item.scope_type}'는 event_key를 가질 수 없습니다.",
            )

        # agent는 assigned conversation/thread에 mute 설정 불가 — 대상(target) 기준(#2623 조건④).
        if target_is_agent and item.level == "mute" and item.scope_type in ("conversation", "thread"):
            raise HTTPException(status_code=400, detail="Agent cannot mute assigned conversation or thread")

        now = datetime.now(timezone.utc)
        stmt = (
            pg_insert(NotificationPreference)
            .values(
                id=uuid.uuid4(),
                member_id=target_member_id,
                scope_type=item.scope_type,
                scope_id=item.scope_id,
                event_key=item.event_key,
                channel=item.channel,
                level=item.level,
                created_at=now,
                updated_at=now,
            )
        )
        # partial unique index에 맞는 conflict target 선택
        if item.scope_type == "event_key":
            stmt = stmt.on_conflict_do_update(
                index_elements=["member_id", "event_key", "channel"],
                index_where=NotificationPreference.event_key.isnot(None),
                set_={"level": item.level, "updated_at": now},
            )
        elif item.scope_id is None:
            stmt = stmt.on_conflict_do_update(
                index_elements=["member_id", "scope_type", "channel"],
                index_where=and_(
                    NotificationPreference.scope_id.is_(None), NotificationPreference.event_key.is_(None),
                ),
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
