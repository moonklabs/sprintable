import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Story
from app.models.standup import StandupEntry, StandupEntryProject, StandupFeedback
from app.repositories.standup import StandupEntryRepository, StandupFeedbackRepository
from app.schemas.standup import (
    FeedbackCreate,
    FeedbackResponse,
    PlanStorySummary,
    StandupEntryResponse,
    StandupSelfUpdate,
    StandupUpsert,
)
from app.services.member_resolver import canonicalize_member_id, resolve_member
from app.services.project_auth import accessible_project_ids_in_org


async def _entries_with_plan_stories(
    entries: list[StandupEntry], session: AsyncSession, org_id: uuid.UUID
) -> list[StandupEntryResponse]:
    """a9e67531: 엔트리들의 plan_story_ids 를 **org-scope batch resolve**(N+1 회피) → plan_stories 주입.

    엔트리=org-level planning artifact 라 plan_story 가 active-sprint/board 밖일 수 있어, FE 의 scoped
    stories 배열로는 미해소(미노출 버그). 여기서 org-scope 로 id+title+status(+priority/project/sprint) 해소해
    내려준다. ⭐org-scope 강제(`Story.org_id==org_id`)·삭제 제외·타org/미존재 id 는 **조용히 제외**(노출 0)·
    plan_story_ids **입력 순서 보존**. plan_story_ids 는 하위호환 유지(FE id-only fallback).
    """
    all_ids = {sid for e in entries for sid in (e.plan_story_ids or [])}
    summaries: dict[uuid.UUID, PlanStorySummary] = {}
    if all_ids:
        rows = (
            await session.execute(
                select(
                    Story.id, Story.title, Story.status, Story.priority,
                    Story.project_id, Story.sprint_id,
                ).where(
                    Story.id.in_(all_ids),
                    Story.org_id == org_id,         # ⭐org-scope(anti-IDOR·타org 해소 0).
                    Story.deleted_at.is_(None),
                )
            )
        ).all()
        for sid, title, status, priority, pid, spid in rows:
            summaries[sid] = PlanStorySummary(
                id=sid, title=title, status=status, priority=priority,
                project_id=pid, sprint_id=spid,
            )
    out: list[StandupEntryResponse] = []
    for e in entries:
        resp = StandupEntryResponse.model_validate(e)
        # 순서 보존 + 미발견(타org/삭제/미존재) 조용히 제외.
        resp.plan_stories = [summaries[sid] for sid in (e.plan_story_ids or []) if sid in summaries]
        out.append(resp)
    return out

router = APIRouter(prefix="/api/v2/standups", tags=["standups"])


async def _sync_org_level_links(
    repo: StandupEntryRepository,
    session: AsyncSession,
    entry: StandupEntry,
    project_id: uuid.UUID | None,
    user_id: str,
    org_id: uuid.UUID,
) -> None:
    """1c2be9db: org-level write(project_id 없음) → entry 링크 = author 접근 프로젝트로 full
    overwrite. canonical `accessible_project_ids_in_org`(has_project_access/정책B 동일 SSOT)
    재사용 — team_member 쿼리 자작 금지(CP2-A). legacy(project_id 명시)는 upsert 의 additive
    링크만 사용하고 여기 호출 안 함(DELETE 없음·CP2-B)."""
    if project_id is not None:
        return
    accessible = await accessible_project_ids_in_org(session, uuid.UUID(user_id), org_id)
    await repo.resync_project_links(entry.id, accessible)


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> StandupEntryRepository:
    return StandupEntryRepository(session, org_id)


@router.get("", response_model=list[StandupEntryResponse])
async def list_standups(
    project_id: uuid.UUID | None = Query(default=None),
    author_id: uuid.UUID | None = Query(default=None),
    sprint_id: uuid.UUID | None = Query(default=None),
    date_filter: date | None = Query(default=None, alias="date"),
    repo: StandupEntryRepository = Depends(_get_repo),
) -> list[StandupEntryResponse]:
    filters: dict = {}
    if project_id:
        filters["project_id"] = project_id
    if author_id:
        # AC3-3(T3, #1167 회귀 방지): 조회 필터도 canonical 정규화 — 카드가 레거시 team_member.id로
        # 조회해도 canonical 저장분과 매칭(raw 필터면 saved-but-not-displayed 재발).
        filters["author_id"] = await canonicalize_member_id(author_id, repo.session)
    if sprint_id:
        filters["sprint_id"] = sprint_id
    if date_filter:
        filters["date"] = date_filter
    entries = await repo.list(**filters)
    return await _entries_with_plan_stories(entries, repo.session, repo.org_id)


@router.post("", response_model=StandupEntryResponse, status_code=201)
async def upsert_standup(
    body: StandupUpsert,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> StandupEntryResponse:
    # AC3-3: 작성자 신원을 canonical members.id로 정규화(레거시 휴먼 team_member.id → alias 치환).
    # write↔read(카드/missing) 동일 canonical 정합 — #1167 회귀(API 200≠카드표시) 방지.
    author_id = await canonicalize_member_id(body.author_id, session)
    repo = StandupEntryRepository(session, org_id)
    entry = await repo.upsert(
        project_id=body.project_id,
        author_id=author_id,
        date=body.date,
        sprint_id=body.sprint_id,
        done=body.done,
        plan=body.plan,
        blockers=body.blockers,
        plan_story_ids=body.plan_story_ids,
    )
    # 1c2be9db: org-level write(project_id 없음) → author 접근 프로젝트로 링크 full overwrite.
    await _sync_org_level_links(repo, session, entry, body.project_id, auth.user_id, org_id)
    return (await _entries_with_plan_stories([entry], session, org_id))[0]


@router.put("", response_model=StandupEntryResponse)
async def update_standup(
    body: StandupSelfUpdate,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> StandupEntryResponse:
    """PUT /api/v2/standups — 본인 스탠드업 self-save (SID:6a1e8b1d → AC3-3 canonical 이행).

    author_id는 인증 유저(resolve_member)에서 server-side 도출 — 클라 바디 author_id를
    받지 않아 타인 스탠드업 위조를 차단(본인만 수정). project_id는 바디 수용.

    AC3-3: author_id = **canonical members.id**(휴먼=org_member.id, 에이전트=team_member.id).
    #1167은 카드(`/api/team-members`, team_member.id 매칭)와 정렬하려 team_member.id로 저장하던
    transitional 정렬이었으나, AC3-3에서 write(author/feedback)·카드 display·missing-calc를 **모두
    canonical로 함께** 옮겨 멀티프로젝트 휴먼 단일 신원(48e653e9 해소) + saved-but-not-displayed 회귀 0.
    """
    member = await resolve_member(auth, org_id, session, project_id=body.project_id)
    repo = StandupEntryRepository(session, org_id)
    entry = await repo.upsert(
        project_id=body.project_id,
        author_id=member.id,
        date=body.date,
        sprint_id=body.sprint_id,
        done=body.done,
        plan=body.plan,
        blockers=body.blockers,
        plan_story_ids=body.plan_story_ids,
    )
    # 1c2be9db: org-level self-save(project_id 없음) → author 접근 프로젝트로 링크 full overwrite.
    await _sync_org_level_links(repo, session, entry, body.project_id, auth.user_id, org_id)
    return (await _entries_with_plan_stories([entry], session, org_id))[0]


@router.get("/history", response_model=list[StandupEntryResponse])
async def list_standup_history(
    project_id: uuid.UUID = Query(...),
    limit: int = Query(default=30, ge=1, le=200),
    repo: StandupEntryRepository = Depends(_get_repo),
) -> list[StandupEntryResponse]:
    """GET /api/v2/standups/history — 최근 N개 스탠드업 히스토리 조회 (AC2 S-STANDUP-FIX)."""
    entries = await repo.list(project_id=project_id, limit=limit)
    return [StandupEntryResponse.model_validate(e) for e in entries]


@router.get("/missing", response_model=list[uuid.UUID])
async def get_missing_standups(
    project_id: uuid.UUID = Query(...),
    date_filter: date = Query(..., alias="date"),
    repo: StandupEntryRepository = Depends(_get_repo),
) -> list[uuid.UUID]:
    return await repo.get_missing(project_id, date_filter)


@router.get("/feedback", response_model=list[FeedbackResponse])
async def list_feedback(
    project_id: uuid.UUID = Query(...),
    date_filter: date = Query(..., alias="date"),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> list[FeedbackResponse]:
    q = (
        select(StandupFeedback)
        .join(StandupEntry, StandupFeedback.standup_entry_id == StandupEntry.id)
        .where(
            StandupFeedback.org_id == org_id,
            StandupEntry.date == date_filter,
            # 51447ca0: feedback projection — 피드백 단 엔트리가 해당 프로젝트에 링크됐는지로 판정
            # (org-level 엔트리 피드백도 링크된 프로젝트 뷰에 surface). legacy는 0099 백필 링크로 커버.
            exists().where(
                StandupEntryProject.entry_id == StandupEntry.id,
                StandupEntryProject.project_id == project_id,
            ),
        )
    )
    result = await db.execute(q)
    return [FeedbackResponse.model_validate(f) for f in result.scalars()]


@router.get("/{id}", response_model=StandupEntryResponse)
async def get_standup(
    id: uuid.UUID,
    repo: StandupEntryRepository = Depends(_get_repo),
) -> StandupEntryResponse:
    entry = await repo.get(id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Standup entry not found")
    return StandupEntryResponse.model_validate(entry)


@router.post("/{id}/feedback", response_model=FeedbackResponse, status_code=201)
async def add_feedback(
    id: uuid.UUID,
    body: FeedbackCreate,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> FeedbackResponse:
    from app.schemas.standup import REVIEW_TYPES
    if body.review_type not in REVIEW_TYPES:
        raise HTTPException(status_code=400, detail=f"review_type must be one of: {', '.join(REVIEW_TYPES)}")

    entry_repo = StandupEntryRepository(session, org_id)
    entry = await entry_repo.get(id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Standup entry not found")

    # AC3-3 (트랩#9 co-write): feedback 작성자도 author_id와 동일 canonical members.id로 정규화.
    feedback_by_id = await canonicalize_member_id(body.feedback_by_id, session)
    fb_repo = StandupFeedbackRepository(session, org_id)
    feedback = await fb_repo.create(
        project_id=body.project_id,
        sprint_id=body.sprint_id,
        standup_entry_id=id,
        feedback_by_id=feedback_by_id,
        review_type=body.review_type,
        feedback_text=body.feedback_text,
    )
    return FeedbackResponse.model_validate(feedback)
