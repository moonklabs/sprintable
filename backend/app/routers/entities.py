import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, func, select
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
    # ⭐story #2263(C-5) 계약③(PO 확定, 2026-07-28 유나 실측 뒤) — 「고르는 자리」는 status를
    # 쓰지 않는다(어느 것인가 문제이지 지금 상태 문제가 아니라서). 대신 실제 식별자를 담는다.
    # 종류마다 있는 재료만 채운다 — 없는 종류에 억지로 값을 만들지 않는다.
    number: int | None = None  # 사람-읽는 순번(story의 story_number, task는 소속 story 순번)
    epic_title: str | None = None  # 소속 에픽 제목(있는 종류만 — story/task/artifact)
    identifier: str | None = None  # 그 외 문자열 식별자(doc의 slug — 사람이 손으로 복사하는 실키)


class EntitySearchTypeMeta(BaseModel):
    """⭐계약② — 「보여준 건수」와 「전체 건수」. 화면이 «몇 건 더 있다»를 지어내지 않고
    이 수를 그대로 쓰게 한다."""

    shown: int
    total: int


class EntitySearchResponse(BaseModel):
    data: list[EntitySearchResult]
    types: dict[str, EntitySearchTypeMeta]


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
#
# ⭐story #2263(C-5) 계약①·② — handler가 items뿐 아니라 (items, total) 을 함께 준다. total은
# DEFAULT_LIMIT 로 안 잘린 실제 매치 건수(계약②가 요구하는 "전체 건수" 그 자체) — items는
# 지금까지처럼 최대 DEFAULT_LIMIT 개까지만 끌어온다(종류별 보장 몫이 DEFAULT_LIMIT 를 넘을 수
# 없으므로 이걸로 충분하다).
EntitySearchHandler = Callable[
    [AsyncSession, uuid.UUID, uuid.UUID, "str | None"],
    Awaitable[tuple[list[EntitySearchResult], int]],
]


async def _search_stories(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> tuple[list[EntitySearchResult], int]:
    conditions = [Story.org_id == org_id, Story.project_id == project_id, Story.deleted_at.is_(None)]
    if search:
        conditions.append(Story.title.ilike(search))
    total = (await db.execute(select(func.count()).select_from(Story).where(*conditions))).scalar_one()
    stmt = (
        select(Story.id, Story.title, Story.status, Story.created_at, Story.story_number, Goal.title)
        .outerjoin(Goal, Goal.id == Story.epic_id)
        .where(*conditions)
        .order_by(Story.created_at.desc())
        .limit(DEFAULT_LIMIT)
    )
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(
            entity_type="story", entity_id=rid, title=title, status=st, created_at=cat,
            number=num, epic_title=epic_title,
        )
        for rid, title, st, cat, num, epic_title in rows
    ], total


async def _search_docs(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> tuple[list[EntitySearchResult], int]:
    conditions = [Doc.org_id == org_id, Doc.project_id == project_id, Doc.deleted_at.is_(None)]
    if search:
        conditions.append(Doc.title.ilike(search))
    total = (await db.execute(select(func.count()).select_from(Doc).where(*conditions))).scalar_one()
    stmt = (
        select(Doc.id, Doc.title, Doc.created_at, Doc.slug)
        .where(*conditions)
        .order_by(Doc.created_at.desc())
        .limit(DEFAULT_LIMIT)
    )
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="doc", entity_id=rid, title=title, created_at=cat, identifier=slug)
        for rid, title, cat, slug in rows
    ], total


async def _search_epics(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> tuple[list[EntitySearchResult], int]:
    conditions = [Goal.org_id == org_id, Goal.project_id == project_id]
    if search:
        conditions.append(Goal.title.ilike(search))
    total = (await db.execute(select(func.count()).select_from(Goal).where(*conditions))).scalar_one()
    stmt = (
        select(Goal.id, Goal.title, Goal.status, Goal.created_at)
        .where(*conditions)
        .order_by(Goal.created_at.desc())
        .limit(DEFAULT_LIMIT)
    )
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="epic", entity_id=rid, title=title, status=st, created_at=cat)
        for rid, title, st, cat in rows
    ], total


async def _search_tasks(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> tuple[list[EntitySearchResult], int]:
    conditions = [Task.org_id == org_id, Story.project_id == project_id, Task.deleted_at.is_(None)]
    if search:
        conditions.append(Task.title.ilike(search))
    count_stmt = select(func.count()).select_from(Task).join(Story, Task.story_id == Story.id).where(*conditions)
    total = (await db.execute(count_stmt)).scalar_one()
    stmt = (
        select(Task.id, Task.title, Task.status, Task.created_at, Story.story_number, Goal.title)
        .join(Story, Task.story_id == Story.id)
        .outerjoin(Goal, Goal.id == Story.epic_id)
        .where(*conditions)
        .order_by(Task.created_at.desc())
        .limit(DEFAULT_LIMIT)
    )
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(
            entity_type="task", entity_id=rid, title=title, status=st, created_at=cat,
            number=num, epic_title=epic_title,
        )
        for rid, title, st, cat, num, epic_title in rows
    ], total


async def _search_sprints(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> tuple[list[EntitySearchResult], int]:
    conditions = [Sprint.org_id == org_id, Sprint.project_id == project_id]
    if search:
        conditions.append(Sprint.title.ilike(search))
    total = (await db.execute(select(func.count()).select_from(Sprint).where(*conditions))).scalar_one()
    stmt = (
        select(Sprint.id, Sprint.title, Sprint.status, Sprint.created_at)
        .where(*conditions)
        .order_by(Sprint.created_at.desc())
        .limit(DEFAULT_LIMIT)
    )
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="sprint", entity_id=rid, title=title, status=st, created_at=cat)
        for rid, title, st, cat in rows
    ], total


async def _search_artifacts(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> tuple[list[EntitySearchResult], int]:
    conditions = [
        VisualArtifact.org_id == org_id, VisualArtifact.project_id == project_id,
        VisualArtifact.deleted_at.is_(None),
    ]
    if search:
        conditions.append(VisualArtifact.title.ilike(search))
    total = (await db.execute(select(func.count()).select_from(VisualArtifact).where(*conditions))).scalar_one()
    stmt = (
        select(VisualArtifact.id, VisualArtifact.title, VisualArtifact.created_at, Goal.title)
        .outerjoin(Goal, Goal.id == VisualArtifact.epic_id)
        .where(*conditions)
        .order_by(VisualArtifact.created_at.desc())
        .limit(DEFAULT_LIMIT)
    )
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="artifact", entity_id=rid, title=title, created_at=cat, epic_title=epic_title)
        for rid, title, cat, epic_title in rows
    ], total


async def _search_hypotheses(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> tuple[list[EntitySearchResult], int]:
    # Hypothesis엔 title 칼럼이 없다 — §2.2.4 "유일한 수동 텍스트 입력"인 statement가 제목
    # 대응 필드(reference_registry._project_id_of_hypothesis와 별개로, 검색 표시용 텍스트
    # 선택은 이 파일의 판단 — statement 외엔 사람이 읽을 자유텍스트가 없다).
    conditions = [Hypothesis.org_id == org_id, Hypothesis.project_id == project_id]
    if search:
        conditions.append(Hypothesis.statement.ilike(search))
    total = (await db.execute(select(func.count()).select_from(Hypothesis).where(*conditions))).scalar_one()
    stmt = (
        select(Hypothesis.id, Hypothesis.statement, Hypothesis.status, Hypothesis.created_at)
        .where(*conditions)
        .order_by(Hypothesis.created_at.desc())
        .limit(DEFAULT_LIMIT)
    )
    rows = await db.execute(stmt)
    return [
        EntitySearchResult(entity_type="hypothesis", entity_id=rid, title=statement, status=st, created_at=cat)
        for rid, statement, st, cat in rows
    ], total


async def _search_evidence(
    db: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID, search: str | None,
) -> tuple[list[EntitySearchResult], int]:
    """Evidence는 project_id가 없다(work_item_id/work_item_type로 story/task를 폴리모픽
    참조 — reference_registry._project_id_of_evidence와 동일 축) — story-경유·task-경유
    둘을 각각 join해 project 스코프를 건다. title 대응 칼럼도 없어(자유텍스트가 아니라
    ref/note/source) `ref`(NOT NULL)를 표시 필드로 쓴다.

    두 경유 쿼리 모두 LIMIT 없이 전량을 끌어온 뒤 파이썬에서 합쳐 정렬·자르므로(원래부터
    그랬다) `len(combined)`가 이미 DEFAULT_LIMIT 에 안 잘린 계약②의 total 그 자체다 —
    별도 count 쿼리가 필요 없다.
    """
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
    combined = story_rows + task_rows
    total = len(combined)
    top = sorted(combined, key=lambda r: r[2], reverse=True)[:DEFAULT_LIMIT]
    return [
        EntitySearchResult(entity_type="evidence", entity_id=rid, title=ref, created_at=cat)
        for rid, ref, cat in top
    ], total


# ⛔이 dict가 "찾는 것" 축의 유일한 SSOT — registry(ENTITY_RESOLVERS, "받아들이는 것" 축)와
# 별개 dict로 둔다(reference_registry.py의 PROJECT_ID_RESOLVERS와 동일 twin-system 원칙 —
# 합치면 한쪽만 늘리고 잊는 조용한 누락이 재발한다). 키 집합 동일성은 테스트로 고정.
#
# ⭐story #2263(C-5) 계약① — 이 dict의 삽입 순서를 search_entities의 종류별 순회 순서로도
# 쓴다(고정·이름 무관). 정렬축(가나다·최신)이 그대로 "종류 편향"이 됐던 게 원래 결함이었으므로,
# 종류를 도는 순서 자체가 텍스트 정렬에서 나오면 같은 함정을 반복하는 것이다.
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


@router.get("/search", response_model=EntitySearchResponse)
async def search_entities(
    project_id: uuid.UUID = Query(...),
    q: str | None = Query(default=None),
    types: str | None = Query(default=None, description="Comma-separated entity types"),
    db: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> EntitySearchResponse:
    # ratchet round4(story 03ee87cc): project_id 쿼리파라미터(조회대상 자체)에 caller
    # 접근권 검증이 없어 same-org cross-project의 여러 종류 title(+ILIKE 검색 매칭 시 내용
    # 존재여부)까지 한 엔드포인트에서 동시 노출됐다 — resource-actual 직접검증.
    if not await has_project_access(db, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

    valid_types = _valid_types()
    requested = set(types.split(",")) if types else valid_types
    requested = requested & valid_types

    search = f"%{q}%" if q else None

    # ⭐story #2263(C-5) 계약① — 전체를 한 줄로 세워 자르지 않는다(유나 실측: 종류가 넷일 땐
    # 평균 2.5/종류인데 여덟이 되면 1.25/종류라 어떤 종류는 후보에 «아예» 안 나오고, 편향의
    # 원인도 가나다 정렬이라 사람이 짐작조차 못 한다). 각 종류가 먼저 최소 보장 몫을 받고,
    # 남는 자리만 관련도로 채운다 — 종류 수가 늘어도 "어떤 종류든 최소 하나는 자리를 얻는다"는
    # 이 성질이 유지된다.
    # ⛔_SEARCH_HANDLERS에 없는(=원래 500을 던져야 하는) 요청 타입도 순회에 남겨야
    # 아래 "handler is None" 방어가 여전히 걸린다 — _SEARCH_HANDLERS 기준으로만 돌면
    # 그 타입 자체가 순회에서 통째로 빠져 방어가 무력화된다(직접 sabotage로 잡아낸 회귀).
    ordered_types = [t for t in _SEARCH_HANDLERS if t in requested]
    ordered_types += [t for t in requested if t not in _SEARCH_HANDLERS]
    num_types = len(ordered_types)

    fetched: dict[str, list[EntitySearchResult]] = {}
    totals: dict[str, int] = {}
    for entity_type in ordered_types:
        handler = _SEARCH_HANDLERS.get(entity_type)
        if handler is None:
            # ⛔registry엔 있는데 검색 handler가 없다 — "조용히 0건"으로 다시 넘기지 않는다
            # (이번에 실제로 겪은 그 사고: 200/0건은 사용자에게 "그런 게 없다"로 읽힌다).
            raise HTTPException(
                status_code=500,
                detail=f"Entity type '{entity_type}' is registered but has no search handler",
            )
        items, total = await handler(db, org_id, project_id, search)
        fetched[entity_type] = items
        totals[entity_type] = total

    guaranteed = max(1, DEFAULT_LIMIT // num_types) if num_types else 0
    selected: dict[str, list[EntitySearchResult]] = {t: fetched[t][:guaranteed] for t in ordered_types}
    used = sum(len(v) for v in selected.values())
    remaining_budget = DEFAULT_LIMIT - used

    if remaining_budget > 0:
        # 보장 몫을 채우고 남는 자리는 관련도(현재 정렬축과 동일)로 채운다 — 이미 선택된
        # 항목을 뺀 나머지 후보 «전체»를 대상으로 하므로 특정 종류로 쏠릴 수 있으나, 이미
        # 모든 종류가 최소 하나는 확보한 뒤라 계약①이 요구하는 "아예 안 나오는 종류 0"은
        # 이 단계와 무관하게 성립한다.
        leftover: list[EntitySearchResult] = []
        for t in ordered_types:
            leftover.extend(fetched[t][guaranteed:])
        if search:
            leftover.sort(key=lambda r: r.title.lower())
        else:
            leftover.sort(key=lambda r: r.created_at, reverse=True)
        for item in leftover[:remaining_budget]:
            selected[item.entity_type].append(item)

    # ⭐계약② — 응답이 "잘렸음"을 들고 온다: 종류별 보여준 건수(shown)와 전체 건수(total)를
    # 그대로 준다. 화면이 "이 종류에서 N건 더"를 지어내지 않게 한다.
    types_meta = {t: EntitySearchTypeMeta(shown=len(selected[t]), total=totals[t]) for t in ordered_types}

    data: list[EntitySearchResult] = [item for t in ordered_types for item in selected[t]]
    if search:
        data.sort(key=lambda r: r.title.lower())
    else:
        data.sort(key=lambda r: r.created_at, reverse=True)

    return EntitySearchResponse(data=data, types=types_meta)
