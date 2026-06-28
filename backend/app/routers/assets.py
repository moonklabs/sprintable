"""E-STORAGE-SSOT S2: asset registry read API (AC2 queryable + S5 FE 계약).

scope-guard = HARD AC(D3): 모든 응답이 요청자 org + 접근 가능 project 로 필터(타 org/project asset
0 노출). project_id 지정 시 has_project_access 검증(IDOR 차단).

S5 FE 계약(0046c9fc): created_by enrich·source_links(title+deeplink)·server-sort(date/name/size)+
cursor pagination·folder tree endpoint. enrich 는 페이지 단위 batch(N+1 회피).
"""
from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.asset import Asset, AssetFolder, AssetLink
from app.models.conversation import Conversation, ConversationMessage
from app.models.doc import Doc
from app.models.pm import Story
from app.models.team import TeamMember
from app.services.project_auth import accessible_project_ids_in_org, has_project_access

router = APIRouter(prefix="/api/v2", tags=["assets"])

_SNIPPET = 80


class CreatedBy(BaseModel):
    id: uuid.UUID
    name: str
    avatar_url: str | None = None


class SourceLink(BaseModel):
    type: str
    id: uuid.UUID | None = None
    title: str | None = None
    deeplink: dict[str, str] | None = None


class AssetResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID | None
    folder_id: uuid.UUID | None
    container: str
    object_path: str
    name: str
    content_type: str | None
    size_bytes: int
    created_at: datetime
    updated_at: datetime
    created_by: CreatedBy | None = None
    source_links: list[SourceLink] = []


class AssetPage(BaseModel):
    items: list[AssetResponse]
    next_cursor: str | None = None


class FolderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    parent_id: uuid.UUID | None
    project_id: uuid.UUID | None


_SORT_COLS = {"date": Asset.updated_at, "name": Asset.name, "size": Asset.size_bytes}


def _encode_cursor(sort_value: Any, last_id: uuid.UUID) -> str:
    raw = {"v": sort_value.isoformat() if isinstance(sort_value, datetime) else sort_value, "id": str(last_id)}
    return base64.urlsafe_b64encode(json.dumps(raw).encode()).decode()


def _decode_cursor(cursor: str, sort: str) -> tuple[Any, uuid.UUID]:
    try:
        raw = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
        v = raw["v"]
        if sort == "date":
            v = datetime.fromisoformat(v)
        elif sort == "size":
            v = int(v)
        return v, uuid.UUID(raw["id"])
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid cursor") from exc


async def _scope_filter(db, auth, org_id, project_id):
    """org + project 접근권으로 쿼리 스코프(IDOR 차단). 반환=(WHERE clauses, accessible project set).

    accessible set 은 enrich source 스코프(타 project source 누수 차단·까심 R3)에도 재사용한다.
    """
    user_id = uuid.UUID(auth.user_id)
    clauses = [Asset.org_id == org_id, Asset.deleted_at.is_(None)]
    if project_id is not None:
        if not await has_project_access(db, user_id, project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to this project")
        clauses.append(Asset.project_id == project_id)
        accessible = {project_id}
    else:
        accessible = set(await accessible_project_ids_in_org(db, user_id, org_id))
        clauses.append(or_(Asset.project_id.is_(None), Asset.project_id.in_(accessible)))
    return clauses, accessible


@router.get("/assets", response_model=AssetPage)
async def list_assets(
    project_id: uuid.UUID | None = Query(None),
    folder_id: uuid.UUID | None = Query(None),
    mime: str | None = Query(None, description="content_type prefix (e.g. 'image/')"),
    q: str | None = Query(None, description="name 부분검색(ILIKE)"),
    sort: Literal["date", "name", "size"] = Query("date"),
    order: Literal["asc", "desc"] = Query("desc"),
    cursor: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> AssetPage:
    clauses, accessible = await _scope_filter(db, auth, org_id, project_id)
    if folder_id is not None:
        clauses.append(Asset.folder_id == folder_id)
    if mime:
        clauses.append(Asset.content_type.ilike(f"{mime}%"))
    if q:
        clauses.append(Asset.name.ilike(f"%{q}%"))

    sort_col = _SORT_COLS[sort]
    if cursor:
        cv, cid = _decode_cursor(cursor, sort)
        if order == "asc":
            clauses.append(or_(sort_col > cv, and_(sort_col == cv, Asset.id > cid)))
        else:
            clauses.append(or_(sort_col < cv, and_(sort_col == cv, Asset.id < cid)))

    direction = (lambda c: c.asc()) if order == "asc" else (lambda c: c.desc())
    stmt = (
        select(Asset)
        .where(and_(*clauses))
        .order_by(direction(sort_col), direction(Asset.id))
        .limit(limit)
    )
    assets = list((await db.execute(stmt)).scalars().all())

    enriched = await _enrich(db, org_id, accessible, assets)
    items = [enriched[a.id] for a in assets]
    next_cursor = None
    if len(assets) == limit:
        last = assets[-1]
        next_cursor = _encode_cursor(getattr(last, {"date": "updated_at", "name": "name", "size": "size_bytes"}[sort]), last.id)
    return AssetPage(items=items, next_cursor=next_cursor)


class StorageUsageResponse(BaseModel):
    org_id: uuid.UUID
    used_bytes: int
    limit_bytes: int | None = None
    percentage: float = 0.0


@router.get("/assets/storage-usage", response_model=StorageUsageResponse)
async def storage_usage(
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> StorageUsageResponse:
    """GET /api/v2/assets/storage-usage — org 의 committed(미삭제) asset bytes 합 + tier 캡 + percentage(S8).

    usage SSOT = asset registry **live SUM**(결재: committed asset bytes·org scope·drift 0). soft-delete
    (deleted_at IS NOT NULL)는 합산서 제외 = 즉시 용량 회수(복구는 7일 grace·별도). cap = **단일 BE SSOT**
    (plan_tier_limits·server 권위·FE 가 이 응답으로 캡 read → Supabase 이원화 0). limit/percentage 는
    **ee-gated**(is_ee_enabled): SaaS = org tier→plan_tier_limits 캡, OSS = null(무제한). org-wide.
    """
    used = int((await db.execute(
        select(func.coalesce(func.sum(Asset.size_bytes), 0)).where(
            Asset.org_id == org_id,
            Asset.deleted_at.is_(None),
        )
    )).scalar_one())

    limit_bytes: int | None = None
    if settings.is_ee_enabled:
        from ee.plan_limits import get_org_storage_limit_bytes  # type: ignore[import]
        limit_bytes = await get_org_storage_limit_bytes(db, org_id)

    pct = round(used / limit_bytes * 100, 1) if limit_bytes else 0.0
    return StorageUsageResponse(
        org_id=org_id, used_bytes=used, limit_bytes=limit_bytes, percentage=pct
    )


@router.get("/folders", response_model=list[FolderResponse])
async def list_folders(
    project_id: uuid.UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[FolderResponse]:
    user_id = uuid.UUID(auth.user_id)
    clauses = [AssetFolder.org_id == org_id, AssetFolder.deleted_at.is_(None)]
    if project_id is not None:
        if not await has_project_access(db, user_id, project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to this project")
        clauses.append(AssetFolder.project_id == project_id)
    else:
        accessible = await accessible_project_ids_in_org(db, user_id, org_id)
        clauses.append(or_(AssetFolder.project_id.is_(None), AssetFolder.project_id.in_(accessible)))
    rows = (await db.execute(select(AssetFolder).where(and_(*clauses)).order_by(AssetFolder.name))).scalars().all()
    return [FolderResponse.model_validate(r) for r in rows]


async def _enrich(
    db: AsyncSession,
    org_id: uuid.UUID,
    accessible: set[uuid.UUID],
    assets: list[Asset],
) -> dict[uuid.UUID, AssetResponse]:
    """페이지 단위 batch enrich(N+1 회피): created_by(name/avatar) + source_links(title/deeplink).

    ⚠️ 다형 link 는 FK 없어 오염 row 가능 → enrich 조회를 **org + accessible-project scoped**
    (타 org·접근불가 project 의 title/content/slug 누수 차단·까심 R2/R3). 스코프 lookup 서 못 찾은
    source 는 **SourceLink 자체 미생성**(title=None 노출 말고 제거). member 는 org 레벨(project 무관).
    """
    # ⚠️ created_by(ORM=UUID)를 model_validate 가 CreatedBy 로 coerce 시도→ValidationError(S2 잠복 버그·
    # created_by 세팅된 실 asset 에서 list 500). created_by/source_links 는 ORM 매핑 제외하고 아래서 enrich.
    base = {
        a.id: AssetResponse(
            id=a.id, org_id=a.org_id, project_id=a.project_id, folder_id=a.folder_id,
            container=a.container, object_path=a.object_path, name=a.name,
            content_type=a.content_type, size_bytes=a.size_bytes,
            created_at=a.created_at, updated_at=a.updated_at,
        )
        for a in assets
    }
    if not assets:
        return base

    asset_ids = [a.id for a in assets]
    links = (await db.execute(
        select(AssetLink.asset_id, AssetLink.source_type, AssetLink.source_id)
        .where(AssetLink.asset_id.in_(asset_ids), AssetLink.org_id == org_id)
    )).all()

    by_type: dict[str, set[uuid.UUID]] = {}
    for _aid, stype, sid in links:
        if sid is not None:
            by_type.setdefault(stype, set()).add(sid)

    # org + accessible-project 스코프 batch fetch. accessible 빈 set이면 in_([]) → 0건(누수 0).
    story_t = dict((await db.execute(
        select(Story.id, Story.title).where(
            Story.id.in_(by_type["story"]), Story.org_id == org_id,
            Story.project_id.in_(accessible), Story.deleted_at.is_(None),
        )
    )).all()) if by_type.get("story") and accessible else {}
    doc_rows = (await db.execute(
        select(Doc.id, Doc.title, Doc.slug).where(
            Doc.id.in_(by_type["doc"]), Doc.org_id == org_id,
            Doc.project_id.in_(accessible), Doc.deleted_at.is_(None),
        )
    )).all() if by_type.get("doc") and accessible else []
    doc_t = {r[0]: (r[1], r[2]) for r in doc_rows}
    msg_rows = (await db.execute(
        select(ConversationMessage.id, ConversationMessage.conversation_id, ConversationMessage.content)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(
            ConversationMessage.id.in_(by_type["conversation_message"]),
            Conversation.org_id == org_id, Conversation.project_id.in_(accessible),
        )
    )).all() if by_type.get("conversation_message") and accessible else []
    msg_t = {r[0]: (r[1], r[2]) for r in msg_rows}

    # created_by enrich — team_members 뷰(name NOT NULL·avatar nullable)·org-scoped(member=org 레벨).
    # 멀티프로젝트 agent=뷰 N행 → id로 dedup.
    cb_ids = {a.created_by for a in assets if a.created_by is not None}
    cb_map: dict[uuid.UUID, CreatedBy] = {}
    if cb_ids:
        for tid, name, avatar in (await db.execute(
            select(TeamMember.id, TeamMember.name, TeamMember.avatar_url)
            .where(TeamMember.id.in_(cb_ids), TeamMember.org_id == org_id)
        )).all():
            if tid not in cb_map:
                cb_map[tid] = CreatedBy(id=tid, name=name, avatar_url=avatar)

    links_by_asset: dict[uuid.UUID, list[SourceLink]] = {}
    for aid, stype, sid in links:
        sl = _build_source_link(stype, sid, base[aid].name, story_t, doc_t, msg_t)
        if sl is not None:  # 스코프 밖 source → link 미생성(누수 0)
            links_by_asset.setdefault(aid, []).append(sl)

    for a in assets:
        resp = base[a.id]
        resp.created_by = cb_map.get(a.created_by) if a.created_by else None
        resp.source_links = links_by_asset.get(a.id, [])
    return base


def _build_source_link(stype, sid, asset_name, story_t, doc_t, msg_t) -> SourceLink | None:
    """스코프된 source 맵에 없으면 None(link 미생성). manual 은 source 없이 파일명으로 항상 생성."""
    if stype == "story":
        if sid not in story_t:
            return None
        return SourceLink(type=stype, id=sid, title=story_t[sid], deeplink={"story_id": str(sid)})
    if stype == "doc":
        if sid not in doc_t:
            return None
        title, slug = doc_t[sid]
        return SourceLink(type=stype, id=sid, title=title,
                          deeplink={"doc_slug": slug} if slug else None)
    if stype == "conversation_message":
        if sid not in msg_t:
            return None
        conv_id, content = msg_t[sid]
        title = (content or "").strip()[:_SNIPPET] or "메시지"
        deeplink = {"conversation_id": str(conv_id), "message_id": str(sid)} if conv_id else None
        return SourceLink(type=stype, id=sid, title=title, deeplink=deeplink)
    # manual: 파일명 title·deeplink 없음(source 조회 불요·항상 생성)
    return SourceLink(type=stype, id=sid, title=asset_name, deeplink=None)
