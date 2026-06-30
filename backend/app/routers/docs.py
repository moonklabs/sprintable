import os
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_project_scoped_org_id, get_verified_org_id
from app.dependencies.database import get_db
from app.models.doc import DocComment, DocRevision
from app.models.member import Member
from app.models.team import TeamMember
from app.repositories.doc import DocRepository
from app.services.member_resolver import canonicalize_member_id
from app.schemas.doc import (
    DocCreate,
    DocMemberSummary,
    DocResponse,
    DocRevisionsSummary,
    DocSummaryResponse,
    DocUpdate,
    ShareStatusResponse,
)


async def _resolve_doc_extras(
    doc, session: AsyncSession
) -> tuple[DocMemberSummary | None, DocRevisionsSummary]:
    """단건 doc 의 담당자 member 요약 + 수정이력 요약 해소(FE 이중 fetch 제거 공용 코어).

    doc.org_id 스코프(anti-IDOR·caller 는 이미 doc 접근 검증)·N+1 0(member 1쿼리 + revisions agg 1쿼리)·
    assignee 없으면 member 쿼리 skip·member 미발견(타org/삭제/미존재)은 None(노출 0). detail(GET /{id})과
    slug-query 단건 경로 양쪽에서 동일 코어 사용 — FE 실 소비 경로(slug-query)도 enrich되도록."""
    assignee: DocMemberSummary | None = None
    if doc.assignee_id is not None:
        m = (
            await session.execute(
                select(Member.id, Member.name, Member.avatar_url).where(
                    Member.id == doc.assignee_id,
                    Member.org_id == doc.org_id,        # org-scope(anti-IDOR).
                    Member.deleted_at.is_(None),
                )
            )
        ).first()
        if m is not None:
            assignee = DocMemberSummary(id=m[0], name=m[1], avatar_url=m[2])
    cnt, latest = (
        await session.execute(
            select(func.count(DocRevision.id), func.max(DocRevision.created_at)).where(
                DocRevision.doc_id == doc.id,
                DocRevision.org_id == doc.org_id,        # org-scope.
            )
        )
    ).one()
    return assignee, DocRevisionsSummary(count=cnt or 0, latest_at=latest)


async def _enrich_doc_response(doc, session: AsyncSession) -> DocResponse:
    """detail(GET /{id}) 응답에 담당자/수정이력 요약 동봉. additive·기존 필드 불변."""
    resp = DocResponse.model_validate(doc)
    resp.assignee, resp.revisions = await _resolve_doc_extras(doc, session)
    return resp


async def _enrich_doc_summary(doc, session: AsyncSession) -> DocSummaryResponse:
    """slug-query 단건 경로 응답(DocSummaryResponse)에 담당자/수정이력 요약 동봉. FE 상세 fetchDoc 이
    GET /api/docs?slug= 를 쓰므로 이 경로도 enrich 해야 #1693 payload 소비가 실제로 흐른다. additive."""
    resp = DocSummaryResponse.model_validate(doc)
    resp.assignee, resp.revisions = await _resolve_doc_extras(doc, session)
    return resp

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
        # slug 단건 경로 = FE 문서 상세 fetchDoc 의 실 경로 → detail 과 동일하게 enrich(담당자/수정이력).
        # 일반 list/tree/search 분기는 enrich 안 함(다건 N+1 회피·페이로드 과확장 금지).
        return [await _enrich_doc_summary(doc, repo.session)] if doc else []

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
    background_tasks: BackgroundTasks,
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
    # ⭐RC#1(body-trust 봉인): created_by 를 **인증 caller 로 강제**(body.created_by 무시·attribution
    # 위조 차단). 다른 doc write 경로(_resolve_doc_member_id·line~501)와 대칭. AC3-2d(2) canonical 유지.
    created_by = await _resolve_doc_member_id(auth, org_id, session)
    created_by = await canonicalize_member_id(created_by, session)
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
    # 활동로그: doc 생성 이벤트 기록 (생성류 미기록 갭 — 피드 정상화)
    from app.services.activity_log import record_created_activity
    await record_created_activity(
        background_tasks, auth=auth, org_id=org_id, db=session,
        entity_type="doc", entity_id=doc.id, project_id=body.project_id,
        title=doc.title,
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
    # doc 상세(detail view)만 enrich: 담당자 member 요약 + 수정이력 요약 동봉(FE 이중 fetch 제거).
    # create/update/transition 은 write-path 라 plain(추가 쿼리 0·기존 테스트 broad-mock 무파손).
    return await _enrich_doc_response(doc, session)


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
    # 151e05f1: 동시성 제어 필드 — Doc 컬럼이 아니므로 분리(setattr 루프서 제외).
    expected_updated_at = data.pop("expected_updated_at", None)
    force_overwrite = data.pop("force_overwrite", None)

    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")

    # 151e05f1: 낙관적 동시성 — expected_updated_at 제공 & 현재 updated_at 불일치 & not force
    # → 409 DOC_CONFLICT(동시편집 clobber 방지). mutation 前 검사·미제공=무체크(하위호환).
    # detail dict → #1372 핸들러 패스스루 → FE 가 error.code/error.current_updated_at 언랩.
    # ⚠️ **ms 절삭 비교**(PO 콜): FE가 JS Date(ms 정밀도)로 round-trip하면 μs 손실 → μs-exact면
    # 매 저장 false-409(상시 차단·원본보다 악화 footgun). 양쪽 ms 절삭 후 ==로 FE 직렬화 무관 robust
    # (동시편집 <1ms 간격은 비현실이라 보호 granularity 손실 무의미·defense in depth).
    if expected_updated_at is not None and not force_overwrite and doc.updated_at is not None:
        cur_ms = doc.updated_at.replace(microsecond=(doc.updated_at.microsecond // 1000) * 1000)
        exp_ms = expected_updated_at.replace(microsecond=(expected_updated_at.microsecond // 1000) * 1000)
        if cur_ms != exp_ms:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "DOC_CONFLICT",
                    "message": "문서가 다른 곳에서 수정됨 — 최신본을 다시 불러오세요",
                    "current_updated_at": doc.updated_at.isoformat(),
                },
            )

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
                raise HTTPException(
                    status_code=422,
                    detail={"code": "SLUG_INVALID", "message": "유효하지 않은 슬러그"},
                )
        elif new_slug != doc.slug:
            if await is_slug_taken(session, repo.org_id, doc.project_id, new_slug, exclude_doc_id=doc.id):
                if explicit:
                    suggestion = await resolve_unique_slug(
                        session, repo.org_id, doc.project_id, new_slug, exclude_doc_id=doc.id
                    )
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "SLUG_TAKEN",
                            "message": "이미 사용 중인 슬러그",
                            "suggestion": suggestion,
                        },
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
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Doc not found")
    # b13352c2: doc 삭제 시 그 doc 의 pending doc_approval 게이트를 cascade void(orphan Gate inbox 항목 방지).
    # 삭제 권한자(인증 caller) 트리거 system cascade — human-gate authz 우회 정당(별도 결재 아님). void 는
    # begin_nested 격리 best-effort라 삭제 비중단. pending 아니면 no-op(멱등)·doc_approval 만 스코핑.
    from app.services.gate_service import void_pending_doc_gate
    from app.services.member_resolver import resolve_member
    deleter = await resolve_member(auth, repo.org_id, repo.session)
    await void_pending_doc_gate(repo.session, repo.org_id, id, deleter.id)
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
    repo: DocRepository = Depends(_get_repo),
) -> list[DocCommentResponse]:
    # ⚠️S28 보안(까심 RC twin·revisions 동형 IDOR): doc 이 caller org 소속인지 org-scoped repo 로 검증.
    # ⭐comments 는 revisions(S28 전 잠복)와 달리 이미 populated 라 active cross-org 노출이었다(pre-
    # existing·revisions 고치며 surface sweep 서 적출·같이 봉인). org_id 가드(방어 심층).
    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    q = select(DocComment).where(
        DocComment.doc_id == id,
        DocComment.org_id == repo.org_id,
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
    repo: DocRepository = Depends(_get_repo),
) -> list[DocRevisionResponse]:
    # ⚠️S28 보안(까심 RC·cross-org IDOR): doc 이 caller org 소속인지 org-scoped repo 로 먼저 검증.
    # 안 하면 다른 org 가 doc UUID 추측만으로 revision content 를 읽는다(S28 전엔 revision 미배선이라
    # 빈 응답 잠복·재상신 스냅샷 배선으로 활성화). revision 쿼리에도 org_id 가드(방어 심층).
    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    q = select(DocRevision).where(
        DocRevision.doc_id == id,
        DocRevision.org_id == repo.org_id,
    ).order_by(DocRevision.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return [DocRevisionResponse.model_validate(r) for r in result.scalars()]


class DocTransitionRequest(BaseModel):
    status: str


@router.post("/{id}/transition", response_model=DocResponse)
async def transition_doc_endpoint(
    id: uuid.UUID,
    body: DocTransitionRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> DocResponse:
    """E-DG S22: doc decision lifecycle 전이(create/update 와 분리). draft→confirmed 는 human-only
    (+enforcing 시 line human-gate overlay). caller 는 인증 컨텍스트에서 도출(RC① 패턴·body 신뢰 X)."""
    from app.services.doc import DocTransitionError, transition_doc
    from app.services.member_resolver import resolve_member

    caller = await resolve_member(auth, org_id, session)
    try:
        doc = await transition_doc(session, org_id, caller, id, body.status)
        await session.commit()
        # 48f064e5 fix: UPDATE 후 commit 으로 server-onupdate 컬럼(updated_at)이 expired → model_validate
        # 의 동기 컨텍스트서 lazy-load 시 MissingGreenlet(async IO) → 500. refresh 로 async 컨텍스트서
        # eager 재로드(create_doc=INSERT라 무영향이었음). [[base_repository_refresh]] 패턴.
        await session.refresh(doc)
        return DocResponse.model_validate(doc)
    except DocTransitionError as e:
        _codes = {
            "DOC_NOT_FOUND": 404, "HUMAN_CONFIRM_REQUIRED": 403,
            "INVALID_STATUS": 422, "INVALID_DOC_TRANSITION": 422,
        }
        raise HTTPException(
            status_code=_codes.get(e.code, 400), detail={"code": e.code, "message": e.message}
        )


class DocAssetRegisterRequest(BaseModel):
    url: str           # FE putObject 반환(GCS url 또는 canonical bare path)
    filename: str
    size: int
    mime: str | None = None


class DocAssetRegisterResponse(BaseModel):
    asset_id: uuid.UUID
    filename: str
    size: int
    mime: str | None = None


@router.post("/{doc_id}/assets", response_model=DocAssetRegisterResponse, status_code=201)
async def register_doc_asset(
    doc_id: uuid.UUID,
    body: DocAssetRegisterRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> DocAssetRegisterResponse:
    """POST /api/v2/docs/{doc_id}/assets — S4: FE-putObject 後 doc asset register(optimistic).

    FE 가 압축→putObject(`org/{org}/project/{proj}/doc/{doc_id}/...`) 後 이 endpoint 로 register.
    ⚠️ object_path 를 path_in_source_scope(doc 분기)로 검증 = **IDOR 핵심**(FE 가 임의/타org/타doc path
    register 못 함). capacity 게이트①(ee seam·OSS no-op·doc 우회 구멍 차단)·asset + asset_link
    (source_type=doc·source_id=doc_id) 생성. signed read 는 S3 authorize asset_id 분기 재사용(신규 0).
    """
    from app.core.config import settings
    from app.models.doc import Doc
    from app.services.asset_registry import sync_attachment_assets
    from app.services.member_resolver import resolve_member
    from app.services.project_auth import has_project_access

    doc = (await session.execute(
        select(Doc).where(Doc.id == doc_id, Doc.org_id == org_id, Doc.deleted_at.is_(None))
    )).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    if not await has_project_access(session, uuid.UUID(auth.user_id), doc.project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")

    att = {"url": body.url, "name": body.filename, "content_type": body.mime, "size": body.size}
    # capacity 게이트①(서버사이드·ee seam·OSS no-op) — doc 업로드도 commit 前 enforce(우회 구멍 차단·까심①).
    if settings.is_ee_enabled:
        from ee.plan_limits import check_storage_capacity  # type: ignore[import]
        await check_storage_capacity(session, org_id, [att])

    created_by: uuid.UUID | None = None
    try:
        created_by = (await resolve_member(auth, org_id, session)).id
    except Exception:  # noqa: BLE001 — created_by 는 비필수(asset.created_by nullable).
        created_by = None

    url_map = await sync_attachment_assets(
        session, org_id=org_id, project_id=doc.project_id, source_type="doc",
        source_id=doc_id, attachments=[att], created_by=created_by,
    )
    asset_id = url_map.get(body.url)
    if asset_id is None:
        # 미등록 사유: ① path_in_source_scope(doc) 거부=이 doc namespace 밖 path(IDOR)/외부URL,
        # ② head_object None=GCS에 객체 부재(FE putObject 미완·optimistic FE는 error state 처리).
        raise HTTPException(
            status_code=400, detail="object not registered: out-of-scope path or not uploaded"
        )
    # size 는 authoritative(sync 가 head_object 로 저장한 실값·client size 무시·까심①).
    from app.models.asset import Asset
    real_size = int((await session.execute(
        select(Asset.size_bytes).where(Asset.id == asset_id)
    )).scalar_one())
    await session.commit()
    return DocAssetRegisterResponse(
        asset_id=asset_id, filename=body.filename, size=real_size, mime=body.mime
    )
