import os
import uuid
from datetime import datetime

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_project_scoped_org_id, get_verified_org_id
from app.dependencies.database import get_db
from app.models.doc import DocComment, DocRevision
from app.models.team import TeamMember
from app.repositories.doc import DocRepository
from app.services.member_resolver import canonicalize_member_id
from app.schemas.doc import DocCreate, DocResponse, DocSummaryResponse, DocUpdate, ShareStatusResponse

router = APIRouter(prefix="/api/v2/docs", tags=["docs"])


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
) -> DocRepository:
    return DocRepository(session, org_id)


@router.get("", response_model=list[DocSummaryResponse])
async def list_docs(
    project_id: uuid.UUID | None = Query(default=None),
    parent_id: uuid.UUID | None = Query(default=None),
    doc_type: str | None = Query(default=None),
    tags: str | None = Query(default=None, description="comma-separated tags"),
    slug: str | None = Query(default=None),
    q: str | None = Query(default=None, description="전문 검색 — 제목 + 본문"),
    limit: int = Query(default=500, ge=1, le=1000),
    repo: DocRepository = Depends(_get_repo),
) -> list[DocSummaryResponse]:
    # AC1 + AC3: 전문 검색 — project_id 필수
    if q and project_id:
        results = await repo.search_full_text(project_id, q.strip(), limit=min(limit, 50))
        return [
            DocSummaryResponse.model_validate(doc).model_copy(update={"snippet": snippet})
            for doc, snippet in results
        ]

    if slug and project_id:
        doc = await repo.get_by_slug(project_id, slug)
        if doc is None:
            # 4dd399c6 AC3: live 미스 → alias fallback. 응답 canonical_slug≠요청 slug면 FE가 router.replace.
            doc = await repo.get_by_alias(project_id, slug)
        return [DocSummaryResponse.model_validate(doc)] if doc else []

    if tags and project_id:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        docs = await repo.search_by_tags(project_id, tag_list, limit=limit)
        return [DocSummaryResponse.model_validate(d) for d in docs]

    if project_id and parent_id is not None:
        docs = await repo.list_tree(project_id, parent_id, limit=limit)
        return [DocSummaryResponse.model_validate(d) for d in docs]

    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if doc_type:
        filters["doc_type"] = doc_type
    docs = await repo.list(limit=limit, **filters)
    return [DocSummaryResponse.model_validate(d) for d in docs]


@router.post("", response_model=DocResponse, status_code=201)
async def create_doc(
    body: DocCreate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> DocResponse:
    await enforce_body_context(
        auth_org_id=org_id,
        body_org_id=body.org_id,
        body_project_id=body.project_id,
        auth_project_id=auth.claims.get("app_metadata", {}).get("project_id"),
        db=session,
        user_id=uuid.UUID(auth.user_id),
    )
    # AC3-2d(2): created_by canonical 정규화(레거시 휴먼 tm.id→members.id). (A) write.
    created_by = (await canonicalize_member_id(body.created_by, session)) if body.created_by else None
    repo = DocRepository(session, org_id)
    doc = await repo.create(
        project_id=body.project_id,
        title=body.title,
        slug=body.slug,
        content=body.content,
        parent_id=body.parent_id,
        created_by=created_by,
        icon=body.icon,
        sort_order=body.sort_order,
        doc_type=body.doc_type,
        content_format=body.content_format,
        tags=body.tags,
    )
    return DocResponse.model_validate(doc)


# ─── Schemas ──────────────────────────────────────────────────────────────────

class DocCommentResponse(BaseModel):
    id: uuid.UUID
    doc_id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    content: str
    created_by: uuid.UUID
    created_at: datetime

    model_config = {"from_attributes": True}


class DocRevisionResponse(BaseModel):
    id: uuid.UUID
    doc_id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID
    content: str
    created_by: uuid.UUID | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DocPreviewResponse(BaseModel):
    id: uuid.UUID
    title: str
    icon: str | None = None
    slug: str
    embed_chain: list[str] = []


# ─── Preview (must be before /{id} to avoid routing conflict) ─────────────────

@router.get("/preview", response_model=DocPreviewResponse)
async def get_doc_preview(
    q: str = Query(..., description="slug or UUID"),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: DocRepository = Depends(_get_repo),
) -> DocPreviewResponse:
    from app.models.doc import Doc

    try:
        doc_uuid = uuid.UUID(q)
        stmt = select(Doc).where(Doc.id == doc_uuid, Doc.org_id == repo.org_id, Doc.deleted_at.is_(None))
    except ValueError:
        stmt = select(Doc).where(Doc.slug == q, Doc.org_id == repo.org_id, Doc.deleted_at.is_(None))

    result = await db.execute(stmt.limit(1))
    doc = result.scalar_one_or_none()

    if doc is None:
        # cross-org fallback: slug/uuid 기반 전체 org 조회 후 membership 검증
        try:
            doc_uuid2 = uuid.UUID(q)
            fallback_stmt = select(Doc).where(Doc.id == doc_uuid2, Doc.deleted_at.is_(None))
        except ValueError:
            fallback_stmt = select(Doc).where(Doc.slug == q, Doc.deleted_at.is_(None))
        fallback = await db.execute(fallback_stmt.limit(1))
        doc = fallback.scalar_one_or_none()
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")
        uid = uuid.UUID(auth.user_id)
        member = await db.execute(
            select(TeamMember.id).where(
                or_(TeamMember.user_id == uid, TeamMember.id == uid),
                TeamMember.project_id == doc.project_id,
                TeamMember.is_active.is_(True),
            ).limit(1)
        )
        if member.scalar_one_or_none() is None:
            raise HTTPException(status_code=403, detail="해당 프로젝트의 멤버가 아닌")

    return DocPreviewResponse(
        id=doc.id,
        title=doc.title,
        icon=doc.icon,
        slug=doc.slug,
        embed_chain=[],
    )


# ─── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("/{id}", response_model=DocResponse)
async def get_doc(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: DocRepository = Depends(_get_repo),
) -> DocResponse:
    doc = await repo.get(id)
    if doc is None:
        # cross-org fallback: project_id query param 없이 단일 id로 접근한 경우
        from app.models.doc import Doc
        result = await session.execute(
            select(Doc).where(Doc.id == id, Doc.deleted_at.is_(None))
        )
        doc = result.scalar_one_or_none()
        if doc is None:
            raise HTTPException(status_code=404, detail="Doc not found")
        uid = uuid.UUID(auth.user_id)
        member = await session.execute(
            select(TeamMember.id).where(
                or_(TeamMember.user_id == uid, TeamMember.id == uid),
                TeamMember.project_id == doc.project_id,
                TeamMember.is_active.is_(True),
            ).limit(1)
        )
        if member.scalar_one_or_none() is None:
            raise HTTPException(status_code=403, detail="해당 프로젝트의 멤버가 아닌")
    return DocResponse.model_validate(doc)


@router.patch("/{id}", response_model=DocResponse)
async def update_doc(
    id: uuid.UUID,
    body: DocUpdate,
    repo: DocRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> DocResponse:
    data = body.model_dump(exclude_unset=True)
    # 4dd399c6: slug/slug_locked 는 유일성·alias 처리가 필요해 일반 필드와 분리.
    slug_in = data.pop("slug", None)
    slug_locked_in = data.pop("slug_locked", None)

    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")

    # 일반 필드 적용 (slug 제외)
    for attr, val in data.items():
        setattr(doc, attr, val)

    # slug 변경 처리 (4dd399c6)
    if slug_in is not None:
        from app.services.doc_slug import resolve_unique_slug, slugify, is_slug_taken
        from app.models.doc import DocSlugAlias
        from sqlalchemy import delete as sa_delete

        explicit = slug_locked_in is True  # discriminator: 명시 편집 vs 자동파생
        new_slug = slugify(slug_in)
        if not new_slug:
            # 정규화 후 빈값: 명시 편집은 422, 자동파생은 기존 slug 유지(타이핑 보호)
            if explicit:
                raise HTTPException(status_code=422, detail={"code": "SLUG_INVALID"})
        elif new_slug != doc.slug:
            if await is_slug_taken(session, repo.org_id, doc.project_id, new_slug, exclude_doc_id=doc.id):
                if explicit:
                    suggestion = await resolve_unique_slug(
                        session, repo.org_id, doc.project_id, new_slug, exclude_doc_id=doc.id
                    )
                    raise HTTPException(
                        status_code=409,
                        detail={"error": {"code": "SLUG_TAKEN", "suggestion": suggestion}},
                    )
                # 자동파생 충돌 → 무음 -N suffix
                new_slug = await resolve_unique_slug(
                    session, repo.org_id, doc.project_id, new_slug, exclude_doc_id=doc.id
                )
            old_slug = doc.slug
            doc.slug = new_slug
            # AC3: 구 slug → alias 보존 (이미 있으면 skip). 신 slug 가 과거 alias였다면 정리(live 우선).
            await session.execute(
                sa_delete(DocSlugAlias).where(
                    DocSlugAlias.project_id == doc.project_id,
                    DocSlugAlias.old_slug == new_slug,
                )
            )
            existing_alias = (await session.execute(
                select(DocSlugAlias).where(
                    DocSlugAlias.project_id == doc.project_id,
                    DocSlugAlias.old_slug == old_slug,
                ).limit(1)
            )).scalar_one_or_none()
            if existing_alias is None:
                session.add(DocSlugAlias(
                    org_id=repo.org_id,
                    project_id=doc.project_id,
                    old_slug=old_slug,
                    doc_id=doc.id,
                ))
            else:
                existing_alias.doc_id = doc.id

    if slug_locked_in is not None:
        doc.slug_locked = slug_locked_in

    await session.flush()
    await session.refresh(doc)

    if "content" in data:
        cutoff_sq = (
            select(DocRevision.created_at)
            .where(DocRevision.doc_id == id)
            .order_by(DocRevision.created_at.desc())
            .offset(50)
            .limit(1)
            .scalar_subquery()
        )
        await session.execute(
            delete(DocRevision).where(
                DocRevision.doc_id == id,
                DocRevision.created_at <= cutoff_sq,
            )
        )

    return DocResponse.model_validate(doc)


@router.delete("/{id}", status_code=200)
async def delete_doc(
    id: uuid.UUID,
    repo: DocRepository = Depends(_get_repo),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Doc not found")
    return {"ok": True}


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _resolve_doc_member_id(auth: AuthContext, org_id: uuid.UUID, db: AsyncSession) -> uuid.UUID:
    user_id = uuid.UUID(str(auth.user_id))
    result = await db.execute(
        select(TeamMember)
        .where(
            or_(TeamMember.user_id == user_id, TeamMember.id == user_id),
            TeamMember.org_id == org_id,
            TeamMember.is_active.is_(True),
        )
        .limit(1)
    )
    member = result.scalar_one_or_none()
    if member:
        return member.id
    # 0d68ad20: grant-only/admin 휴먼(team_member 행 없음)도 org 멤버면 403 금지 — SSOT canonical
    # member id(org_member.id)로 폴백. 비-멤버는 resolve_member가 400.
    from app.services.member_resolver import resolve_member
    return (await resolve_member(auth, org_id, db)).id


# ─── Share (Part B b1574f5a) ──────────────────────────────────────────────────

def _share_resp(tok) -> ShareStatusResponse:
    if tok is None:
        return ShareStatusResponse(enabled=False)
    app_url = os.environ.get("NEXT_PUBLIC_APP_URL", "").rstrip("/")
    share_url = f"{app_url}/share/{tok.token}" if app_url else None
    return ShareStatusResponse(enabled=True, token=tok.token, share_url=share_url)


@router.get("/{id}/share", response_model=ShareStatusResponse)
async def get_doc_share(
    id: uuid.UUID,
    repo: DocRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> ShareStatusResponse:
    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    await _resolve_doc_member_id(auth, repo.org_id, db)  # 멤버십 게이트(비멤버 차단)
    from app.services import doc_share
    return _share_resp(await doc_share.get_status(db, repo.org_id, id))


@router.post("/{id}/share", response_model=ShareStatusResponse)
async def enable_doc_share(
    id: uuid.UUID,
    repo: DocRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> ShareStatusResponse:
    """opt-in 공개 활성 — active 토큰 발급(멱등)."""
    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    actor_id = await _resolve_doc_member_id(auth, repo.org_id, db)
    from app.services import doc_share
    tok = await doc_share.enable(db, repo.org_id, doc.project_id, id, actor_id)
    return _share_resp(tok)


@router.post("/{id}/share/regenerate", response_model=ShareStatusResponse)
async def regenerate_doc_share(
    id: uuid.UUID,
    repo: DocRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> ShareStatusResponse:
    """구 토큰 즉시 폐기 + 신규 발급(유출 방어)."""
    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    actor_id = await _resolve_doc_member_id(auth, repo.org_id, db)
    from app.services import doc_share
    tok = await doc_share.regenerate(db, repo.org_id, doc.project_id, id, actor_id)
    return _share_resp(tok)


@router.delete("/{id}/share", response_model=ShareStatusResponse)
async def disable_doc_share(
    id: uuid.UUID,
    repo: DocRepository = Depends(_get_repo),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> ShareStatusResponse:
    """공개 중단 — active 토큰 revoke(이후 공개 read 410)."""
    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    actor_id = await _resolve_doc_member_id(auth, repo.org_id, db)
    from app.services import doc_share
    await doc_share.revoke(db, repo.org_id, id, actor_id)
    return ShareStatusResponse(enabled=False)


# ─── Comments ─────────────────────────────────────────────────────────────────

@router.get("/{id}/comments", response_model=list[DocCommentResponse])
async def list_doc_comments(
    id: uuid.UUID,
    limit: int = Query(default=20, le=100),
    db: AsyncSession = Depends(get_db),
    _repo: DocRepository = Depends(_get_repo),
) -> list[DocCommentResponse]:
    q = select(DocComment).where(
        DocComment.doc_id == id,
    ).order_by(DocComment.created_at.asc()).limit(limit)
    result = await db.execute(q)
    return [DocCommentResponse.model_validate(r) for r in result.scalars()]


@router.post("/{id}/comments", response_model=DocCommentResponse, status_code=201)
async def add_doc_comment(
    id: uuid.UUID,
    content: str = Body(..., embed=True),
    db: AsyncSession = Depends(get_db),
    repo: DocRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> DocCommentResponse:
    from app.models.doc import Doc
    doc_result = await db.execute(select(Doc).where(Doc.id == id, Doc.org_id == repo.org_id))
    doc = doc_result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Doc not found")
    created_by = await _resolve_doc_member_id(auth, repo.org_id, db)
    created_by = await canonicalize_member_id(created_by, db)  # AC3-2d(2): canonical 정규화
    comment = DocComment(
        doc_id=id,
        org_id=repo.org_id,
        project_id=doc.project_id,
        content=content,
        created_by=created_by,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return DocCommentResponse.model_validate(comment)


# ─── Revisions ────────────────────────────────────────────────────────────────

@router.get("/{id}/revisions", response_model=list[DocRevisionResponse])
async def list_doc_revisions(
    id: uuid.UUID,
    limit: int = Query(default=50, le=100),
    db: AsyncSession = Depends(get_db),
    _repo: DocRepository = Depends(_get_repo),
) -> list[DocRevisionResponse]:
    q = select(DocRevision).where(
        DocRevision.doc_id == id,
    ).order_by(DocRevision.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return [DocRevisionResponse.model_validate(r) for r in result.scalars()]
