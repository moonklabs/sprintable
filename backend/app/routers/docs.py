import os
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, enforce_body_context, get_current_user, get_project_scoped_org_id, get_verified_org_id
from app.dependencies.database import get_db, get_read_db
from app.models.doc import Doc, DocComment, DocRevision
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

router = APIRouter(prefix="/api/v2/docs", tags=["docs", "Knowledge"])

# story #2346 AC7 — stories.py의 두 임계값을 그대로 재사용(2026-08-02 PO 지시로 doc content
# 실측 후 재확認: 50%만 쓰면 짧은 필드가 걸리고 절대량만 쓰면 긴 필드가 새는 동일 문제).
_SHRINK_BLOCK_THRESHOLD = 0.5
_SHRINK_BLOCK_MIN_LOST_CHARS = 100


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
) -> DocRepository:
    return DocRepository(session, org_id)


# story #2451(§6 Phase3 A2): list_docs 전용 — 목록 조회는 create→self-read 흐름이 약함
# (replica lag 0.86s, PO 승인). 다른 라우트가 공유하는 위 _get_repo(get_db)는 그대로.
def _get_repo_read(
    session: AsyncSession = Depends(get_read_db),
    org_id: uuid.UUID = Depends(get_project_scoped_org_id),
) -> DocRepository:
    return DocRepository(session, org_id)


def _doc_page_envelope(docs: list, limit: int) -> dict:
    """story #2191: #2231 정본 규약 A(limit+1 오버페치 + has_more/next_cursor body meta).
    docs 는 이미 limit+1 개까지 조회된 상태로 들어온다(호출부에서 overfetch)."""
    from app.repositories.doc import encode_doc_cursor

    has_more = len(docs) > limit
    page = docs[:limit]
    next_cursor = encode_doc_cursor(page[-1]) if has_more and page else None
    return {
        "data": [DocSummaryResponse.model_validate(d) for d in page],
        "meta": {"has_more": has_more, "next_cursor": next_cursor},
    }


@router.get("")
async def list_docs(
    project_id: uuid.UUID | None = Query(default=None),
    parent_id: uuid.UUID | None = Query(default=None),
    doc_type: str | None = Query(default=None),
    tags: str | None = Query(default=None, description="comma-separated tags"),
    slug: str | None = Query(default=None),
    q: str | None = Query(default=None, description="전문 검색 — 제목 + 본문"),
    ids: str | None = Query(default=None, description="comma-separated doc ids — 배치 앵커 조회(정확한 집합, ORDER BY/limit 무관, story #2262 PR② 칩 상태 배치조회)"),
    limit: int = Query(default=500, ge=1, le=1000),
    cursor: str | None = Query(default=None, description="(sort_order,id) 복합 커서 — 이전 페이지 meta.next_cursor 값 그대로"),
    repo: DocRepository = Depends(_get_repo_read),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    # story #2262 PR②(칩 상태 배치조회) — stories.py list_stories의 ids= 패턴 미러링(검색/slug/
    # tags/tree 분기보다 먼저 — 정확한 집합 요청이라 다른 필터와 무관하게 우선).
    # ⭐카디르 QA(PR#2905, 2026-08-07) — Query(default=None, ...) 기본값은 「값」이 아니라
    # 「센티널 객체」다. FastAPI 경유 없이 이 함수를 직접 호출하는 기존 테스트(test_2191·
    # test_2193 — cursor에 대해 이미 같은 경고 주석이 있던 그 자리)가 ids를 명시로 안 넘기면
    # 그 센티널 그대로를 받는다 — `is not None`은 센티널도 통과시켜 `.split`이 터졌다(CI red
    # 실크래시). isinstance로 실제 str만 통과시킨다(stories.py list_stories의 동형 함정과
    # 같은 처방 — boost_candidates_from 주석 참조).
    if isinstance(ids, str):
        try:
            doc_ids = [uuid.UUID(x) for x in ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid doc id in ids")
        if not doc_ids:
            return {"data": [], "meta": {"has_more": False, "next_cursor": None}}
        if len(doc_ids) > 200:
            raise HTTPException(status_code=422, detail="too many ids (max 200)")
        docs = await repo.list_by_ids(doc_ids)
        # 인가 스코프: org 소속이어도 caller가 접근 못 하는 project의 doc은 조용히 필터링
        # (stories.py list_stories와 동일 SSOT).
        from app.services.project_auth import accessible_project_ids_in_org
        accessible = await accessible_project_ids_in_org(repo.session, uuid.UUID(auth.user_id), repo.org_id)
        docs = [d for d in docs if d.project_id in accessible]
        return {
            "data": [DocSummaryResponse.model_validate(d) for d in docs],
            "meta": {"has_more": False, "next_cursor": None},
        }

    # AC1 + AC3: 전문 검색 — project_id 필수
    # story #2191: 의도적으로 커서 미지원(관련도순 + 위치커서 조합이 결과를 뒤섞음, repo단
    # search_full_text 주석 참조) — has_more/next_cursor는 항상 False/None으로 봉투만 맞춘다.
    if q and project_id:
        results = await repo.search_full_text(project_id, q.strip(), limit=min(limit, 50))
        data = [
            DocSummaryResponse.model_validate(doc).model_copy(update={"snippet": snippet})
            for doc, snippet in results
        ]
        return {"data": data, "meta": {"has_more": False, "next_cursor": None}}

    if slug and project_id:
        doc = await repo.get_by_slug(project_id, slug)
        if doc is None:
            # 4dd399c6 AC3: live 미스 → alias fallback. 응답 canonical_slug≠요청 slug면 FE가 router.replace.
            doc = await repo.get_by_alias(project_id, slug)
        # slug 단건 경로 = FE 문서 상세 fetchDoc 의 실 경로 → detail 과 동일하게 enrich(담당자/수정이력).
        # 일반 list/tree/search 분기는 enrich 안 함(다건 N+1 회피·페이로드 과확장 금지).
        # story #2191: 단건 lookup이라 페이지네이션 대상이 아님 — has_more는 구조적으로 항상 False.
        data = [await _enrich_doc_summary(doc, repo.session)] if doc else []
        return {"data": data, "meta": {"has_more": False, "next_cursor": None}}

    if tags and project_id:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        docs = await repo.search_by_tags(project_id, tag_list, limit=limit + 1, cursor=cursor)
        return _doc_page_envelope(docs, limit)

    if project_id and parent_id is not None:
        docs = await repo.list_tree(project_id, parent_id, limit=limit + 1, cursor=cursor)
        return _doc_page_envelope(docs, limit)

    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if doc_type:
        filters["doc_type"] = doc_type
    docs = await repo.list(limit=limit + 1, cursor=cursor, **filters)
    return _doc_page_envelope(docs, limit)


async def _assert_doc_parent_in_project(
    session: AsyncSession, project_id: uuid.UUID, parent_id: uuid.UUID | None,
) -> None:
    """E-SECURITY SEC-S8(story 83ea3d6a) Y(까심 전수스윕): parent_id가 project_id 소속인지
    검증 없이 그대로 repo.create/setattr에 적용됐다(DocRepository.create는 BaseRepository
    상속이라 소유권 검증 0) — 같은 org 다른 project의 doc을 parent로 지정해 doc 트리를
    오염시킬 수 있었다(T/G와 동형 project-scope 부재). create/update 양쪽 재사용."""
    if parent_id is None:
        return
    parent_project_id = (await session.execute(
        select(Doc.project_id).where(Doc.id == parent_id, Doc.deleted_at.is_(None))
    )).scalar_one_or_none()
    if parent_project_id != project_id:
        raise HTTPException(status_code=404, detail="Parent doc not found")


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
    await _assert_doc_parent_in_project(session, body.project_id, body.parent_id)
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
        # story #2974 — is_folder는 doc_type=="folder"의 shorthand(Doc.is_folder derived
        # property와 대칭). True면 doc_type을 강제 — explicit body.doc_type과 충돌해도
        # is_folder가 우선(둘 다 명시된 경우는 없고, is_folder는 신설 편의 필드).
        doc_type="folder" if body.is_folder else body.doc_type,
        content_format=body.content_format,
        tags=body.tags,
    )
    # story #1993(E-KNOWLEDGE-LINK S1): mentions write-path — 신규 doc 이라 existing=∅(순수 insert
    # 로 귀결하는 reconcile 재사용). **같은 트랜잭션**(try/except 로 삼키지 않음) — 실패 시 예외
    # propagate 로 doc 생성 전체가 롤백된다(AC4 원자성). created_by 는 위에서 이미 canonicalize
    # 됐지만 reconcile_doc_mentions 는 raw id 를 받아 자체적으로 재정규화(idempotent·재사용 함수
    # 계약 단순화 — create/update 양쪽에서 canonical 여부와 무관하게 동일하게 호출 가능).
    from app.services.mention_parser import reconcile_doc_mentions
    await reconcile_doc_mentions(
        session, org_id=org_id, doc_id=doc.id, html_content=doc.content, created_by=created_by,
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
    # #2168 PR-①: 크로스프로젝트 doc 링크가 "링크 자신이 속한 project 를 실어 나르는" 처방이라
    # 받는 쪽(FE embed-card)이 "현재 프로젝트"를 추측하지 않고 이 doc 의 실제 project 로 직행할
    # 수 있어야 한다 — project_id(2차 조회 스코프용) + org_slug/project_slug(경로 세그먼트,
    # `/{ws}/{proj}/docs/{slug}/view` 조립용). additive·project_slug 는 nullable(Project.slug
    # 가 nullable — 옛 미백필 프로젝트는 None, FE 가 bare 링크로 우아하게 폴백).
    project_id: uuid.UUID
    org_slug: str
    project_slug: str | None = None


# ─── Preview (must be before /{id} to avoid routing conflict) ─────────────────

@router.get("/preview", response_model=DocPreviewResponse)
async def get_doc_preview(
    q: str = Query(..., description="slug or UUID"),
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: DocRepository = Depends(_get_repo),
) -> DocPreviewResponse:
    from app.models.doc import Doc
    from app.models.organization import Organization
    from app.models.project import Project

    try:
        doc_uuid = uuid.UUID(q)
        stmt = select(Doc).where(Doc.id == doc_uuid, Doc.org_id == repo.org_id, Doc.deleted_at.is_(None))
    except ValueError:
        stmt = select(Doc).where(Doc.slug == q, Doc.org_id == repo.org_id, Doc.deleted_at.is_(None))

    result = await db.execute(stmt.limit(1))
    doc = result.scalar_one_or_none()

    if doc is not None:
        # #2168 PR-①: get_doc 과 동형 갭 — org-scope happy path 가 project 인가 없이 즉시
        # 반환하던 것을 canonical 가드로 통일(같은 이유: 링크가 project 를 실어 나르기 시작하며
        # 이 경로의 실사용 빈도가 올라간다).
        # ⛔story #2342(2026-07-30, PR#2624 「미완의 롤아웃」 후속): 무권한을 403이 아닌
        # 404로 낸다 — stories.py._assert_story_project_access와 같은 자로 통일(존재
        # 비노출 규율, story #2322).
        from app.services.project_auth import has_project_access
        if not await has_project_access(db, uuid.UUID(auth.user_id), doc.project_id, repo.org_id):
            raise HTTPException(status_code=404, detail="Document not found")

    if doc is None:
        # cross-org fallback: slug/uuid 기반 전체 org 조회 후 membership 검증 (기존, 무변경)
        try:
            doc_uuid2 = uuid.UUID(q)
            fallback_stmt = select(Doc).where(Doc.id == doc_uuid2, Doc.deleted_at.is_(None))
        except ValueError:
            fallback_stmt = select(Doc).where(Doc.slug == q, Doc.deleted_at.is_(None))
        fallback = await db.execute(fallback_stmt.limit(1))
        doc = fallback.scalar_one_or_none()
        if doc is None:
            raise HTTPException(status_code=404, detail="Document not found")
        # #2216: TeamMember(=team_members뷰, members ⋈ project_access INNER JOIN) 단독
        # 조회는 owner-floor 휴먼(명시 grant 없이 has_project_access의 admin_branch로만
        # 접근하는 org owner/admin)을 이 뷰에 행이 없다는 이유로 "멤버 아님"으로 오판한다
        # — #2168 PR-①에서 primary path(위 has_project_access 호출)와 통일했던 그 canonical
        # 가드를 이 fallback 경로에도 동일 적용(#2215 계열, 새 규칙 발명 0).
        # ⚠️org_id=doc.org_id(repo.org_id 아님, None도 아님) — 이 분기는 애초에 repo.get(id)가
        # None(=doc이 repo.org_id 소속이 아님)일 때만 도달하므로, 그 시점의 doc은 구조적으로
        # repo.org_id와 다른 org에 속한다. repo.org_id로 스코프하면 org_scope_project 필터가
        # 항상 거짓이 돼 owner-floor뿐 아니라 정상 team_member까지 전원 403(실측 발견).
        # ⛔org_id=None(org 필터 완전 해제)도 안 쓴다 — human_grant_branch/admin_branch가
        # org_scope 없이 project_access/OrgMember 존재만으로 통과시키면, "project_access
        # 행은 남았지만 그 org 멤버는 아닌" 상태가 이론상 있을 때 탈퇴자에게 문을 열 수
        # 있다(오르테가군 지적, 2026-07-27 — #2206과 동형 클래스 우려). 실측(org_members.py
        # delete_org_member, S-MBR-10 AC5)으로 그 상태가 현재 코드베이스에선 안 만들어짐을
        # 확認했지만(멤버 제거 시 project_access를 명시 DELETE), 그 불변식에 기대지 않는
        # 좁은 형태가 더 안전 — doc.org_id를 쓰면 human_grant_branch/admin_branch가 "그
        # doc의 org에 caller가 실제로 소속돼 있는가"까지 강제해 원래 fallback의 의미
        # (caller의 주 org와 달라도 실 멤버십이면 통과)를 org 필터 없이 손댈 필요 없이 보존한다.
        # ⛔story #2342(2026-07-30): 무권한을 403이 아닌 404로 — 위 primary path와 통일.
        from app.services.project_auth import has_project_access
        if not await has_project_access(db, uuid.UUID(auth.user_id), doc.project_id, doc.org_id):
            raise HTTPException(status_code=404, detail="Document not found")

    org_slug = (await db.execute(
        select(Organization.slug).where(Organization.id == doc.org_id)
    )).scalar_one()
    project_slug = (await db.execute(
        select(Project.slug).where(Project.id == doc.project_id)
    )).scalar_one_or_none()

    return DocPreviewResponse(
        id=doc.id,
        title=doc.title,
        icon=doc.icon,
        slug=doc.slug,
        embed_chain=[],
        project_id=doc.project_id,
        org_slug=org_slug,
        project_slug=project_slug,
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
    if doc is not None:
        # #2168 PR-①: 크로스프로젝트 doc 링크가 정상 동선이 되며 이 org-scope happy path의
        # project 인가 누락(patch/delete 는 f69fcd91 로 이미 고쳐졌으나 GET 은 방치돼 있었음 —
        # 同org 비-project caller 가 id만 알면 무제한 열람 가능하던 갭)이 실사용 IDOR 표면으로
        # 커진다. canonical 가드(has_project_access)로 patch/delete 와 통일.
        # ⛔story #2342(2026-07-30): 무권한을 403이 아닌 404로 — 존재 비노출 규율 통일.
        from app.services.project_auth import has_project_access
        if not await has_project_access(session, uuid.UUID(auth.user_id), doc.project_id, repo.org_id):
            raise HTTPException(status_code=404, detail="Doc not found")
    if doc is None:
        # cross-org fallback: project_id query param 없이 단일 id로 접근한 경우 (기존, 무변경)
        from app.models.doc import Doc
        result = await session.execute(
            select(Doc).where(Doc.id == id, Doc.deleted_at.is_(None))
        )
        doc = result.scalar_one_or_none()
        if doc is None:
            raise HTTPException(status_code=404, detail="Doc not found")
        # #2216: 위 primary path(line 327)와 동일 이유 — TeamMember 단독 조회는 owner-floor
        # 휴먼(명시 grant 없이 admin_branch로만 접근하는 org owner/admin)을 이 뷰에 행이
        # 없다는 이유로 "멤버 아님"으로 오판한다. 이 fallback도 canonical 가드로 통일.
        # ⚠️org_id=doc.org_id(repo.org_id·None 둘 다 아님) — repo.org_id는 이 분기가 구조적으로
        # cross-org라 항상 거짓이 되고(실측 발견), org_id=None(필터 완전 해제)은 human_grant_
        # branch/admin_branch가 org 소속 확認 없이 project_access/OrgMember 존재만으로
        # 통과시켜 "탈퇴자에게 문을 여는" 이론적 폭을 만든다(오르테가군 지적 — #2206과 동형
        # 우려). doc.org_id를 쓰면 "그 doc의 org에 caller가 실제로 소속돼 있는가"까지
        # 강제하면서 원래 fallback 의미(caller 주 org와 달라도 실 멤버십이면 통과)도 보존.
        # ⛔story #2342(2026-07-30): 무권한을 403이 아닌 404로 — 위 primary path와 통일.
        from app.services.project_auth import has_project_access
        if not await has_project_access(session, uuid.UUID(auth.user_id), doc.project_id, doc.org_id):
            raise HTTPException(status_code=404, detail="Doc not found")
    # doc 상세(detail view)만 enrich: 담당자 member 요약 + 수정이력 요약 동봉(FE 이중 fetch 제거).
    # create/update/transition 은 write-path 라 plain(추가 쿼리 0·기존 테스트 broad-mock 무파손).
    return await _enrich_doc_response(doc, session)


@router.patch("/{id}", response_model=DocResponse)
async def update_doc(
    id: uuid.UUID,
    body: DocUpdate,
    background_tasks: BackgroundTasks,
    repo: DocRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> DocResponse:
    # f69fcd91: 대상 doc 의 project 접근 강제(cross-project IDOR — patch 도 id+org 로만 잡아 mutate 하던 갭).
    await _require_doc_project_access(session, id, uuid.UUID(auth.user_id), repo.org_id)
    data = body.model_dump(exclude_unset=True)
    # 4dd399c6: slug/slug_locked 는 유일성·alias 처리가 필요해 일반 필드와 분리.
    slug_in = data.pop("slug", None)
    slug_locked_in = data.pop("slug_locked", None)
    # 151e05f1: 동시성 제어 필드 — Doc 컬럼이 아니므로 분리(setattr 루프서 제외).
    expected_updated_at = data.pop("expected_updated_at", None)
    force_overwrite = data.pop("force_overwrite", None)
    # story #2346 AC7: allow_shrink는 Doc 컬럼이 아니므로 repo mutate 前 분리(stories.py와 동형).
    allow_shrink = data.pop("allow_shrink", False)

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

    # ⛔story #2346 AC3/AC7(stories.py와 동형 — 이 라우터는 activity 로깅 자체가 없어 신규 배선):
    # doc.content는 이미 위에서 조회돼 있어(항상 조회, stories.py처럼 조건부 필요 없음) old 길이를
    # 지금 스칼라로 떠 둔다. 임계값(50%·절대손실 100자)은 stories.py 그대로 재사용 — doc content가
    # story description보다 훨씬 길지만(실측 3000~4500자대 표본), 그 스케일에서는 퍼센트 임계가
    # 실질적으로 작동하고(50% 손실이면 자연히 절대량도 100자를 훌쩍 넘음) 절대 floor는 짧은
    # 문서에서만 의미가 있어 그대로 전이해도 무리가 없다(PO 지시 2026-08-02 — 재보고 정한 것).
    old_content_length: int | None = len(doc.content or "") if "content" in data else None
    if old_content_length is not None and old_content_length > 0 and not allow_shrink:
        _after_len = len(data.get("content") or "")
        _lost_chars = old_content_length - _after_len
        _is_relative_shrink = _after_len < old_content_length * (1 - _SHRINK_BLOCK_THRESHOLD)
        if _is_relative_shrink and _lost_chars >= _SHRINK_BLOCK_MIN_LOST_CHARS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"doc '{doc.title}' content shrank {old_content_length}→{_after_len} chars "
                    f"({round((1 - _after_len / old_content_length) * 100)}% smaller) — "
                    "if intentional, resend with allow_shrink=true"
                ),
            )

    if "parent_id" in data:
        await _assert_doc_parent_in_project(session, doc.project_id, data["parent_id"])

    # story #2874(하드닝): slug/slug_locked도 아래서 setattr 직접 대신 data에 모아 뒀다가
    # update_with_cas() 한 SQL 문으로 함께 반영한다 — 필드 적용을 두 단계(setattr 여기 +
    # slug setattr 저기)로 나누면 그 사이에도 TOCTOU 창이 생겨 원자성이 반쪽이 된다.

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
            data["slug"] = new_slug
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
        data["slug_locked"] = slug_locked_in

    # story #2874: check-then-write(위 expected_updated_at 사전 체크, side-effect 前 빠른
    # 실패용)는 non-atomic이라 진짜 동시 PATCH TOCTOU 창이 남는다 — 실제 write는 여기
    # update_with_cas()의 원자 SQL(UPDATE...WHERE updated_at=)로 다시 한번 강제한다
    # (force_overwrite면 CAS 생략). stories.py::update_story와 동일 공용 판정 함수(중복 구현 0).
    from app.repositories.base import CasConflict
    try:
        doc = await repo.update_with_cas(
            id, expected_updated_at=None if force_overwrite else expected_updated_at, **data
        )
    except CasConflict as e:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "DOC_CONFLICT",
                "message": "문서가 다른 곳에서 수정됨 — 최신본을 다시 불러오세요",
                "current_updated_at": e.current.updated_at.isoformat(),
            },
        )
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")

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

        # story #1993(E-KNOWLEDGE-LINK S1): mentions write-path — content 가 실제로 바뀐 patch 에서만
        # diff reconcile(변경 없는 필드만 patch 하는 호출에서 불필요한 재파싱 skip). **같은 트랜잭션**
        # (try/except 로 삼키지 않음) — 실패 시 예외 propagate 로 doc 수정 전체가 롤백된다(AC4 원자성).
        from app.services.mention_parser import reconcile_doc_mentions
        actor_id = await _resolve_doc_member_id(auth, repo.org_id, session)
        await reconcile_doc_mentions(
            session, org_id=repo.org_id, doc_id=doc.id, html_content=doc.content, created_by=actor_id,
        )

        # story #2346 AC3 — content 길이가 실제로 바뀌면 doc_updated activity에 「이전 길이→이후
        # 길이」를 얹는다(신규 장치 0, 전문 스냅샷 아님). 안 바뀌면 안 남긴다(양성 대조 — stories.py와
        # 동형, 매번 남으면 잡음). old_content_length는 위에서 setattr 前에 이미 스칼라로 떠 뒀다.
        if old_content_length is not None:
            _after_content_len = len(doc.content or "")
            if _after_content_len != old_content_length:
                from app.services.activity_log import record_activity_bg
                background_tasks.add_task(
                    record_activity_bg,
                    org_id=repo.org_id,
                    action="doc_updated",
                    actor_id=actor_id,
                    project_id=doc.project_id,
                    entity_type="doc",
                    entity_id=id,
                    context={
                        "doc_title": doc.title,
                        "length_changes": {
                            "content": {"before": old_content_length, "after": _after_content_len},
                        },
                    },
                )

    return DocResponse.model_validate(doc)


@router.delete("/{id}", status_code=200)
async def delete_doc(
    id: uuid.UUID,
    repo: DocRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    # f69fcd91: 대상 doc 의 project 접근 강제(cross-project IDOR 차단·get_project_scoped_org_id 의 org-only
    # fallback 으로 同org 비-project caller 가 타 project doc 삭제 가능하던 갭). 없으면 404·무권한 403.
    await _require_doc_project_access(repo.session, id, uuid.UUID(auth.user_id), repo.org_id)
    # E-SECURITY SEC-S1 확장(까심 적대적 QA 발견 갭): delete_story와 동형으로 휴먼 전용화 + 삭제 감사.
    from app.services.member_resolver import resolve_member
    deleter = await resolve_member(auth, repo.org_id, repo.session)
    if deleter.type != "human":
        raise HTTPException(status_code=403, detail="Doc 삭제는 휴먼 멤버만 가능합니다 (에이전트 API키 차단)")
    doc = await repo.get(id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    from app.models.deletion_audit import DeletionAuditLog
    repo.session.add(DeletionAuditLog(
        id=uuid.uuid4(), org_id=repo.org_id, actor_id=deleter.id,
        entity_type="doc", entity_id=id, entity_title=doc.title,
    ))
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="Doc not found")
    # b13352c2: doc 삭제 시 그 doc 의 pending doc_approval 게이트를 cascade void(orphan Gate inbox 항목 방지).
    # 삭제 권한자(인증 caller) 트리거 system cascade — human-gate authz 우회 정당(별도 결재 아님). void 는
    # begin_nested 격리 best-effort라 삭제 비중단. pending 아니면 no-op(멱등)·doc_approval 만 스코핑.
    from app.services.gate_service import void_pending_doc_gate
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


async def _require_doc_project_access(
    session: AsyncSession, doc_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID
) -> Doc:
    """f69fcd91: doc mutation 의 canonical project-scope authz. 대상 doc 을 org-scope 로 로드하고 caller 의
    그 doc project 접근(has_project_access SSOT=team_member∪grant∪owner/admin)을 강제 — doc 없으면 404·
    무권한 403. delete/cancel/update 가 **id+org 로만** doc 잡아 mutate 하던 cross-project IDOR(同org
    비-project caller 가 타 project doc 삭제/취소/수정) 차단. register_doc_asset 의 project 가드와 동일 SSOT.
    반환=로드된 doc(caller 재사용 가능)."""
    from app.services.project_auth import has_project_access
    doc = (await session.execute(
        select(Doc).where(Doc.id == doc_id, Doc.org_id == org_id, Doc.deleted_at.is_(None))
    )).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    if not await has_project_access(session, user_id, doc.project_id, org_id):
        raise HTTPException(status_code=403, detail="해당 문서의 프로젝트 접근 권한이 없습니다")
    return doc


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
    # #2237: 형제(enable/regenerate/disable_doc_share)와 동일한 project 접근권 가드로 통일 —
    # 기존엔 org 멤버십(_resolve_doc_member_id)만 확認하고 project 접근권은 안 봤다.
    # _require_doc_project_access가 org-scope 존재검증(404)+project 접근권(403)을 함께 처리한다.
    await _require_doc_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
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
    # f69fcd91: 대상 doc project access 강제(cross-project IDOR — share enable/rotate/revoke 도 id+org
    # 로만 doc 잡던 갭). 없으면 404·무권한 403. agent 도 has_project_access agent 분기로 차단.
    doc = await _require_doc_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
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
    # f69fcd91: 대상 doc project access 강제(cross-project IDOR — share enable/rotate/revoke 도 id+org
    # 로만 doc 잡던 갭). 없으면 404·무권한 403. agent 도 has_project_access agent 분기로 차단.
    doc = await _require_doc_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
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
    # f69fcd91: 대상 doc project access 강제(cross-project IDOR — share enable/rotate/revoke 도 id+org
    # 로만 doc 잡던 갭). 없으면 404·무권한 403. agent 도 has_project_access agent 분기로 차단.
    await _require_doc_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
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
    auth: AuthContext = Depends(get_current_user),
) -> list[DocCommentResponse]:
    # ⚠️S28 보안(까심 RC twin·revisions 동형 IDOR): doc 이 caller org 소속인지 org-scoped repo 로 검증.
    # ⭐comments 는 revisions(S28 전 잠복)와 달리 이미 populated 라 active cross-org 노출이었다(pre-
    # existing·revisions 고치며 surface sweep 서 적출·같이 봉인). org_id 가드(방어 심층).
    # #2237: 형제(add_doc_comment)와 동일한 project 접근권 가드 추가(기존엔 org-scope만 봤다).
    doc = await _require_doc_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
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
    # f69fcd91: 대상 doc project access 강제(cross-project IDOR — 코멘트 주입도 id+org 로만 잡던 갭).
    doc = await _require_doc_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
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
    auth: AuthContext = Depends(get_current_user),
) -> list[DocRevisionResponse]:
    # ⚠️S28 보안(까심 RC·cross-org IDOR): doc 이 caller org 소속인지 org-scoped repo 로 먼저 검증.
    # 안 하면 다른 org 가 doc UUID 추측만으로 revision content 를 읽는다(S28 전엔 revision 미배선이라
    # 빈 응답 잠복·재상신 스냅샷 배선으로 활성화). revision 쿼리에도 org_id 가드(방어 심층).
    # #2237: 형제(PATCH/DELETE /{id})와 동일한 project 접근권 가드 추가(기존엔 org-scope만 봤다).
    doc = await _require_doc_project_access(db, id, uuid.UUID(auth.user_id), repo.org_id)
    q = select(DocRevision).where(
        DocRevision.doc_id == id,
        DocRevision.org_id == repo.org_id,
    ).order_by(DocRevision.created_at.desc()).limit(limit)
    result = await db.execute(q)
    return [DocRevisionResponse.model_validate(r) for r in result.scalars()]


# ─── Backlinks (story #1994·E-KNOWLEDGE-LINK S2) ───────────────────────────────

@router.get("/{id}/backlinks")
async def get_doc_backlinks(
    id: uuid.UUID,
    limit: int = Query(default=30, ge=1, le=200),
    before: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    repo: DocRepository = Depends(_get_repo),
) -> dict:
    """GET /api/v2/docs/{id}/backlinks — 이 doc을 멘션한 chat_message/doc 목록(cursor 페이지네이션,
    `list_messages`(conversations.py)와 동일 convention: `?limit=&before=`, 응답
    `{"data": [...], "meta": {"next_cursor", "has_more"}}`).

    근본 설계 doc design-org-knowledge-mentions-backlinks §8① 불변식: backlink 공개 =
    can_read(target_doc) AND can_read(source_resource). target 접근은 여기서
    `_require_doc_project_access`(docs.py의 기존 canonical 인가 — 무권한/미존재 모두 404,
    existence 오라클 없음)로 검증한다. **source**(멘션을 발신한 chat_message/doc) 접근은
    산티아고 4회차 pass 이후 **단일** SQL statement에 authz predicate를 correlate하는 방식으로
    판정한다(app.services.backlinks §8②·doc은 `accessible_project_ids_in_org`, chat_message는
    `app.services.conversation_auth.conversation_readable_predicate` — `_can_read_conversation`
    (conversations.py)이 단건 호출부에 쓰는 것과 **같은 SSOT 함수**를 메인 쿼리의 WHERE절에
    직접 correlate해 쓴다. 2-phase로 "readable id 집합"을 먼저 SELECT해 Python에 들고 있다가
    다음 쿼리에 넣는 구조가 아니므로 TOCTOU 윈도우가 구조적으로 없다) — target doc의 project
    접근을 source에 상속하지 않는다(멀티프로젝트 org에서 target/source project가 다를 수
    있다는 게 산티아고 리뷰가 잡은 이전 draft의 버그이자 이 story의 근본 이유). count/has_more는
    authz-embedded 단일 쿼리 결과에서만 계산된다(no pagination oracle) — 미인가 source가 있어도
    그 존재는 어디에도 드러나지 않는다.

    `before`: story #1994 B3 — opaque composite cursor(base64, `(created_at, id)` 인코드).
    클라이언트는 이전 응답의 `meta.next_cursor` 값을 그대로 되돌려주기만 하면 된다(파싱 금지 —
    불투명 토큰). 디코드/검증은 `app.services.backlinks.decode_cursor`가 담당(손상 시 400).
    """
    await _require_doc_project_access(session, id, uuid.UUID(auth.user_id), repo.org_id)

    from app.services.backlinks import list_doc_backlinks
    return await list_doc_backlinks(
        session, org_id=repo.org_id, doc_id=id, auth=auth, limit=limit, cursor=before,
    )


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
    # f69fcd91: 대상 doc 의 project 접근 강제(cross-project IDOR — cancel/transition 도 id+org 로만 doc
    # 잡던 갭). via_gate 시스템 경로(gate 해소)는 transition_doc 직호출이라 무영향(이 엔드포인트만 user authz).
    await _require_doc_project_access(session, id, uuid.UUID(auth.user_id), org_id)
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


class UploadDocAttachmentRequest(BaseModel):
    """E-MCP-OPT S6: MCP(비-브라우저)용 JSON/base64 첨부 업로드 요청(chat/story와 동형)."""

    content_base64: str
    name: str
    content_type: str

    @field_validator("content_base64", "name", "content_type")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v

    @field_validator("content_type")
    @classmethod
    def _content_type_sane(cls, v: str) -> str:
        from app.services import mcp_attachment_upload
        if len(v) > mcp_attachment_upload.MAX_ATTACHMENT_NAME_LEN or any(ord(ch) < 32 for ch in v):
            raise ValueError("invalid content_type")
        return v


class UploadDocAttachmentResponse(BaseModel):
    asset_id: uuid.UUID
    filename: str
    size: int
    mime: str | None = None
    # E-MCP-OPT S6: 에이전트가 doc 임베드 마크업(TipTap file-node/image-node 계약)을 몰라도 되게
    # MCP 패키지가 그대로 content 에 붙일 수 있는 완성 HTML 스니펫. doc-content-renderer.tsx/
    # file-node.tsx/image-node.tsx 의 실 렌더 계약과 정확히 일치(uploader 무관 렌더 — FE 변경 0).
    embed_snippet: str


def _build_doc_attachment_embed_snippet(
    *, asset_id: uuid.UUID, name: str, content_type: str, size: int,
) -> str:
    """FE `file-node.tsx`/`image-node.tsx` renderHTML 계약과 정확히 일치하는 마크업 조립.

    이미지(mime image/*) → `<img data-asset-id data-filename data-size data-mime-type alt>`.
    그 외 → `<div data-type="fileAttachment" data-filename data-size data-mime-type data-asset-id>`.
    파일명은 doc content(HTML)에 그대로 꽂히므로 attribute-context escape 필수(주입 방지).
    """
    import html as _html

    safe_name = _html.escape(name, quote=True)
    safe_mime = _html.escape(content_type or "application/octet-stream", quote=True)
    if (content_type or "").lower().startswith("image/"):
        return (
            f'<img data-asset-id="{asset_id}" data-filename="{safe_name}" '
            f'data-size="{size}" data-mime-type="{safe_mime}" alt="{safe_name}">'
        )
    return (
        f'<div data-type="fileAttachment" data-filename="{safe_name}" data-size="{size}" '
        f'data-mime-type="{safe_mime}" data-asset-id="{asset_id}"></div>'
    )


@router.post(
    "/{doc_id}/attachments", response_model=UploadDocAttachmentResponse, status_code=201,
)
async def upload_doc_attachment(
    doc_id: uuid.UUID,
    body: UploadDocAttachmentRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> UploadDocAttachmentResponse:
    """E-MCP-OPT S6: 비-브라우저 클라이언트(MCP)용 JSON/base64 doc 첨부 업로드 + 즉시 등록.

    `register_doc_asset`(FE 2단계: FE putObject → 이 register)와 달리 MCP 는 base64 업로드+등록을
    한 호출로 합친다(FE 세션 없이 base64 만으로 완결). 인가/등록 로직은 `register_doc_asset`과 동일
    (has_project_access·sync_attachment_assets) — doc 은 업로드=등록이 곧 종결 액션이라(story/chat과
    달리 별도 "메시지 생성" 시점이 없음) S5식 집계 재검증이 불필요하다(이 한 호출 자체가 그 지점).
    """
    from app.models.doc import Doc
    from app.services import mcp_attachment_upload
    from app.services.asset_registry import DEFAULT_CONTAINER, sync_attachment_assets
    from app.services.member_resolver import resolve_member
    from app.services.project_auth import has_project_access
    from app.services.storage import get_storage_provider

    doc = (await session.execute(
        select(Doc).where(Doc.id == doc_id, Doc.org_id == org_id, Doc.deleted_at.is_(None))
    )).scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Doc not found")
    if not await has_project_access(session, uuid.UUID(auth.user_id), doc.project_id, org_id):
        raise HTTPException(status_code=403, detail="No access to this project")

    data = mcp_attachment_upload.decode_json_attachment(body.content_base64)
    safe_name = mcp_attachment_upload.safe_attachment_filename(body.name)
    object_path = mcp_attachment_upload.build_mcp_object_path(
        org_id=org_id, project_id=doc.project_id, kind="doc", resource_id=doc_id, safe_name=safe_name,
    )

    uploaded = await get_storage_provider().put_object(
        DEFAULT_CONTAINER, object_path, data, content_type=body.content_type,
    )
    if not uploaded:
        raise HTTPException(status_code=502, detail="upload failed")

    created_by: uuid.UUID | None = None
    try:
        created_by = (await resolve_member(auth, org_id, session)).id
    except Exception:  # noqa: BLE001 — created_by 는 비필수(asset.created_by nullable).
        created_by = None

    att = {"url": object_path, "name": body.name, "content_type": body.content_type, "size": len(data)}
    url_map = await sync_attachment_assets(
        session, org_id=org_id, project_id=doc.project_id, source_type="doc",
        source_id=doc_id, attachments=[att], created_by=created_by,
    )
    asset_id = url_map.get(object_path)
    if asset_id is None:
        # 우리가 방금 쓴 path 가 우리가 만든 접두를 못 지나면 path_in_source_scope 버그(방어적 500) —
        # register_doc_asset 의 400(client 경로 스푸핑)과 원인이 다르므로 구분한다.
        raise HTTPException(status_code=500, detail="asset registration failed for uploaded object")
    await session.commit()

    return UploadDocAttachmentResponse(
        asset_id=asset_id, filename=body.name, size=len(data), mime=body.content_type,
        embed_snippet=_build_doc_attachment_embed_snippet(
            asset_id=asset_id, name=body.name, content_type=body.content_type, size=len(data),
        ),
    )
