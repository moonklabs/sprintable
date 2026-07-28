import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.doc import Doc
from app.models.evidence import Evidence
from app.models.hypothesis import Hypothesis
from app.models.pm import Goal, Sprint, Story, Task
from app.models.visual_artifact import VisualArtifact
from app.services.project_auth import has_project_access
from app.services.reference_registry import ENTITY_RESOLVERS

router = APIRouter(prefix="/api/v2/entities", tags=["entities", "Work"])

DEFAULT_LIMIT = 10


def _valid_types() -> set[str]:
    """story #2294 AC1: 검색 허용목록을 `reference_registry.ENTITY_RESOLVERS`에서 «파생」한다 —
    여기 종류를 다시 나열하지 않는다(맞춘 목록은 다시 갈린다는 것을 오늘 `task`가 실측으로
    보였다: 이 파일이 예전엔 `{"story","doc","epic","task"}`를 손으로 들고 있었는데
    registry엔 `task`가 없어 검색은 되지만 저장은 안 되는 결함이 났다). 매 호출마다 registry를
    다시 읽는다(모듈 로드 시점 스냅샷 금지) — registry가 늘거나 줄면 이 함수도 즉시 같이
    바뀌어야 "둘이 갈릴 수 없다"는 AC1의 요구가 실제로 성립한다."""
    return set(ENTITY_RESOLVERS)


class EntitySearchResult(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    title: str
    status: str | None = None
    created_at: datetime


# ⛔story #2294 B단계 후속(오르테가 라이브 실측, 2026-07-29): "받아들이는 것"(_valid_types,
# registry에서 파생)과 "찾는 것"(아래 _SEARCH_HANDLERS)이 따로 놀 수 있다는 것이 실제로
# 드러났다 — B단계가 registry에 4종(sprint·artifact·hypothesis·evidence)을 열자 `types=`가
# 그 값들을 200/0건으로 «받아들이기»는 했지만, 실제 SELECT 분기가 없어 데이터가 있어도
# 조용히 0건을 냈다("스프린트 16개 실재하는데 검색은 0건" — 양성대조로 실증). 400도 아니고
# 에러도 아닌 "조용히 0건"은 사용자에게 "그런 게 없다"로 읽힌다 — 있는데.
#
# 처방: entity_type(str) → 검색 handler 의 SSOT dict(reference_registry.py의 ENTITY_RESOLVERS/
# PROJECT_ID_RESOLVERS와 동형 원칙). registry에 있는데 이 dict에 없으면(가능성 자체를 0으로
# 만드는 게 아니라 재발했을 때를 대비한 방어) search_entities가 조용히 넘기지 않고 500을
# 던진다 — "받는데 못 찾는" 상태를 다시는 침묵시키지 않는다. 키 집합 동일성은
# test_2294_entities_search_open_4_types_realdb.py가 twin-key 테스트로 고정한다(#2283이
# 세운 그 자와 동형 — 한쪽만 열리면 RED).
EntitySearchHandler = Callable[
    [AsyncSession, uuid.UUID, uuid.UUID, "str | None"], Awaitable[list[EntitySearchResult]]
]


async def _search_stories(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> list[EntitySearchResult]:
    stmt = select(Story.id, Story.title, Story.status, Story.created_at).where(
        Story.org_id == org_id, Story.project_id == project_id, Story.deleted_at.is_(None),
    )
    if search:
        stmt = stmt.where(Story.title.ilike(search))
    stmt = stmt.order_by(Story.created_at.desc()).limit(DEFAULT_LIMIT)
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="story", entity_id=rid, title=title, status=st, created_at=cat)
        for rid, title, st, cat in rows
    ]


async def _search_docs(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> list[EntitySearchResult]:
    stmt = select(Doc.id, Doc.title, Doc.created_at).where(
        Doc.org_id == org_id, Doc.project_id == project_id, Doc.deleted_at.is_(None),
    )
    if search:
        stmt = stmt.where(Doc.title.ilike(search))
    stmt = stmt.order_by(Doc.created_at.desc()).limit(DEFAULT_LIMIT)
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="doc", entity_id=rid, title=title, created_at=cat)
        for rid, title, cat in rows
    ]


async def _search_epics(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> list[EntitySearchResult]:
    stmt = select(Goal.id, Goal.title, Goal.status, Goal.created_at).where(
        Goal.org_id == org_id, Goal.project_id == project_id,
    )
    if search:
        stmt = stmt.where(Goal.title.ilike(search))
    stmt = stmt.order_by(Goal.created_at.desc()).limit(DEFAULT_LIMIT)
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="epic", entity_id=rid, title=title, status=st, created_at=cat)
        for rid, title, st, cat in rows
    ]


async def _search_tasks(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> list[EntitySearchResult]:
    stmt = (
        select(Task.id, Task.title, Task.status, Task.created_at)
        .join(Story, Task.story_id == Story.id)
        .where(Task.org_id == org_id, Story.project_id == project_id, Task.deleted_at.is_(None))
    )
    if search:
        stmt = stmt.where(Task.title.ilike(search))
    stmt = stmt.order_by(Task.created_at.desc()).limit(DEFAULT_LIMIT)
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="task", entity_id=rid, title=title, status=st, created_at=cat)
        for rid, title, st, cat in rows
    ]


async def _search_sprints(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> list[EntitySearchResult]:
    stmt = select(Sprint.id, Sprint.title, Sprint.status, Sprint.created_at).where(
        Sprint.org_id == org_id, Sprint.project_id == project_id,
    )
    if search:
        stmt = stmt.where(Sprint.title.ilike(search))
    stmt = stmt.order_by(Sprint.created_at.desc()).limit(DEFAULT_LIMIT)
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="sprint", entity_id=rid, title=title, status=st, created_at=cat)
        for rid, title, st, cat in rows
    ]


async def _search_artifacts(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> list[EntitySearchResult]:
    stmt = select(VisualArtifact.id, VisualArtifact.title, VisualArtifact.created_at).where(
        VisualArtifact.org_id == org_id, VisualArtifact.project_id == project_id,
        VisualArtifact.deleted_at.is_(None),
    )
    if search:
        stmt = stmt.where(VisualArtifact.title.ilike(search))
    stmt = stmt.order_by(VisualArtifact.created_at.desc()).limit(DEFAULT_LIMIT)
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="artifact", entity_id=rid, title=title, created_at=cat)
        for rid, title, cat in rows
    ]


async def _search_hypotheses(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> list[EntitySearchResult]:
    # Hypothesis엔 title 칼럼이 없다 — §2.2.4 "유일한 수동 텍스트 입력"인 statement가 제목
    # 대응 필드(reference_registry._project_id_of_hypothesis와 별개로, 검색 표시용 텍스트
    # 선택은 이 파일의 판단 — statement 외엔 사람이 읽을 자유텍스트가 없다).
    stmt = select(Hypothesis.id, Hypothesis.statement, Hypothesis.status, Hypothesis.created_at).where(
        Hypothesis.org_id == org_id, Hypothesis.project_id == project_id,
    )
    if search:
        stmt = stmt.where(Hypothesis.statement.ilike(search))
    stmt = stmt.order_by(Hypothesis.created_at.desc()).limit(DEFAULT_LIMIT)
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="hypothesis", entity_id=rid, title=statement, status=st, created_at=cat)
        for rid, statement, st, cat in rows
    ]


async def _search_evidence(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> list[EntitySearchResult]:
    """Evidence는 project_id가 없다(work_item_id/work_item_type로 story/task를 폴리모픽
    참조 — reference_registry._project_id_of_evidence와 동일 축) — story-경유·task-경유
    둘을 각각 join해 project 스코프를 건다. title 대응 칼럼도 없어(자유텍스트가 아니라
    ref/note/source) `ref`(NOT NULL)를 표시 필드로 쓴다."""
    via_story = (
        select(Evidence.id, Evidence.ref, Evidence.created_at)
        .join(Story, and_(Story.id == Evidence.work_item_id, Evidence.work_item_type == "story"))
        .where(
            Evidence.org_id == org_id, Story.project_id == project_id, Story.deleted_at.is_(None),
        )
    )
    via_task = (
        select(Evidence.id, Evidence.ref, Evidence.created_at)
        .join(Task, and_(Task.id == Evidence.work_item_id, Evidence.work_item_type == "task"))
        .join(Story, Story.id == Task.story_id)
        .where(
            Evidence.org_id == org_id, Story.project_id == project_id,
            Task.deleted_at.is_(None), Story.deleted_at.is_(None),
        )
    )
    if search:
        via_story = via_story.where(Evidence.ref.ilike(search))
        via_task = via_task.where(Evidence.ref.ilike(search))
    story_rows = (await db.execute(via_story)).all()
    task_rows = (await db.execute(via_task)).all()
    combined = sorted(story_rows + task_rows, key=lambda r: r[2], reverse=True)[:DEFAULT_LIMIT]
    return [
        EntitySearchResult(entity_type="evidence", entity_id=rid, title=ref, created_at=cat)
        for rid, ref, cat in combined
    ]


# ⛔이 dict가 "찾는 것" 축의 유일한 SSOT — registry(ENTITY_RESOLVERS, "받아들이는 것" 축)와
# 별개 dict로 둔다(reference_registry.py의 PROJECT_ID_RESOLVERS와 동일 twin-system 원칙 —
# 합치면 한쪽만 늘리고 잊는 조용한 누락이 재발한다). 키 집합 동일성은 테스트로 고정.
_SEARCH_HANDLERS: dict[str, "EntitySearchHandler"] = {
    "story": _search_stories,
    "doc": _search_docs,
    "epic": _search_epics,
    "task": _search_tasks,
    "sprint": _search_sprints,
    "artifact": _search_artifacts,
    "hypothesis": _search_hypotheses,
    "evidence": _search_evidence,
}


@router.get("/search", response_model=list[EntitySearchResult])
async def search_entities(
    project_id: uuid.UUID = Query(...),
    q: str | None = Query(default=None),
    types: str | None = Query(default=None, description="Comma-separated entity types"),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[EntitySearchResult]:
    # ratchet round4(story 03ee87cc): project_id 쿼리파라미터(조회대상 자체)에 caller
    # 접근권 검증이 없어 same-org cross-project의 여러 종류 title(+ILIKE 검색 매칭 시 내용
    # 존재여부)까지 한 엔드포인트에서 동시 노출됐다 — resource-actual 직접검증.
    if not await has_project_access(db, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

    valid_types = _valid_types()
    requested = set(types.split(",")) if types else valid_types
    requested = requested & valid_types

    search = f"%{q}%" if q else None
    results: list[EntitySearchResult] = []

    for entity_type in requested:
        handler = _SEARCH_HANDLERS.get(entity_type)
        if handler is None:
            # ⛔registry엔 있는데 검색 handler가 없다 — "조용히 0건"으로 다시 넘기지 않는다
            # (이번에 실제로 겪은 그 사고: 200/0건은 사용자에게 "그런 게 없다"로 읽힌다).
            raise HTTPException(
                status_code=500,
                detail=f"Entity type '{entity_type}' is registered but has no search handler",
            )
        results.extend(await handler(db, org_id, project_id, search))

    if search:
        results.sort(key=lambda r: r.title.lower())
    else:
        results.sort(key=lambda r: r.created_at, reverse=True)

    return results[:DEFAULT_LIMIT]
