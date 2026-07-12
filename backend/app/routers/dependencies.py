import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.dependency import ITEM_TYPES
from app.models.pm import Epic, Sprint, Story
from app.repositories.dependency import DependencyRepository
from app.schemas.dependency import DependencyCreate, DependencyGraphResponse, DependencyResponse
from app.services.dependency_graph import get_graph, would_create_cycle
from app.services.project_auth import accessible_project_ids_in_org, has_project_access

router = APIRouter(prefix="/api/v2/dependencies", tags=["dependencies"])

# item_type → project-소속 모델. epic/sprint/story 셋 다 project_id 직접 컬럼(pm.py) — polymorphic
# 간접(task→story) 없음. dependency 자체엔 project_id가 없어 아이템→project로 해소해 게이팅한다.
_ITEM_MODEL = {"epic": Epic, "sprint": Sprint, "story": Story}


def _get_repo(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> DependencyRepository:
    return DependencyRepository(session, org_id)


async def _item_project_id(
    session: AsyncSession, org_id: uuid.UUID, item_id: uuid.UUID, item_type: str
) -> uuid.UUID | None:
    model = _ITEM_MODEL[item_type]
    return (
        await session.execute(
            select(model.project_id).where(model.id == item_id, model.org_id == org_id)
        )
    ).scalar_one_or_none()


async def _assert_item_project_access(
    session: AsyncSession, user_id: uuid.UUID, org_id: uuid.UUID, item_id: uuid.UUID, item_type: str
) -> None:
    """dependency 대상 아이템(epic/sprint/story)의 실 project 접근권을 resource-actual 검증(404·존재
    비노출). dependency는 project_id 컬럼이 없어 아이템→project로 해소한다. 서브시스템 전체(create/
    delete/list/graph) 공통 게이트 — 반쪽 전환 금지(story aa365768·스캐너 #6)."""
    project_id = await _item_project_id(session, org_id, item_id, item_type)
    if project_id is None or not await has_project_access(session, user_id, project_id, org_id):
        raise HTTPException(status_code=404, detail="의존성 대상 아이템을 찾을 수 없음")


async def _items_project_map(
    session: AsyncSession, org_id: uuid.UUID, item_type: str, ids: list[uuid.UUID]
) -> dict[uuid.UUID, uuid.UUID]:
    """아이템 id 집합 → project_id 맵(graph 응답 필터용·배치 조회)."""
    if not ids:
        return {}
    model = _ITEM_MODEL[item_type]
    rows = (
        await session.execute(
            select(model.id, model.project_id).where(model.id.in_(ids), model.org_id == org_id)
        )
    ).all()
    return {row[0]: row[1] for row in rows}


@router.post("", response_model=DependencyResponse, status_code=201)
async def create_dependency(
    body: DependencyCreate,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> DependencyResponse:
    if body.item_type not in ITEM_TYPES:
        raise HTTPException(status_code=422, detail=f"item_type must be one of {sorted(ITEM_TYPES)}")
    if body.from_id == body.to_id:
        raise HTTPException(status_code=422, detail="자기참조 의존성은 허용되지 않음")

    # 양쪽-아이템 게이트(AC1): from·to 둘 다 caller 접근권 있는 project의 아이템이어야 한다. 접근권
    # 없는 project의 아이템을 링크에 끼워 그 project 상태를 조작하는 것을 차단(cross-project 자체는
    # (a)설계상 허용이나 양쪽 모두 접근권 요구·반쪽 금지).
    user_id = uuid.UUID(auth.user_id)
    await _assert_item_project_access(session, user_id, org_id, body.from_id, body.item_type)
    await _assert_item_project_access(session, user_id, org_id, body.to_id, body.item_type)

    repo = DependencyRepository(session, org_id)

    if await repo.exists(body.from_id, body.to_id, body.item_type):
        raise HTTPException(status_code=409, detail="이미 존재하는 의존성")

    # 사이클 탐지는 org-wide 유지(AC3 — cross-project 사이클도 잡아야 하므로 project-partition 금지).
    if await would_create_cycle(session, org_id, body.from_id, body.to_id, body.item_type):
        raise HTTPException(status_code=422, detail="사이클이 발생하는 의존성은 허용되지 않음")

    dep = await repo.create(
        from_id=body.from_id,
        to_id=body.to_id,
        dep_type=body.dep_type,
        item_type=body.item_type,
    )
    return DependencyResponse.model_validate(dep)


@router.get("", response_model=list[DependencyResponse])
async def list_dependencies(
    item_type: str = Query(...),
    item_id: uuid.UUID = Query(...),
    repo: DependencyRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> list[DependencyResponse]:
    if item_type not in ITEM_TYPES:
        raise HTTPException(status_code=422, detail=f"item_type must be one of {sorted(ITEM_TYPES)}")
    # 조회 아이템의 project 접근권(AC2·read exposure 봉인) — 접근권 없는 아이템의 의존성 로스터 차단.
    await _assert_item_project_access(repo.session, uuid.UUID(auth.user_id), repo.org_id, item_id, item_type)
    deps = await repo.list_by_item(item_id, item_type)
    return [DependencyResponse.model_validate(d) for d in deps]


@router.delete("/{id}", status_code=200)
async def delete_dependency(
    id: uuid.UUID,
    repo: DependencyRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    # 대상 dependency를 선조회해 from·to 양쪽 아이템 project 접근권을 사전검증(AC1). id+org로만 잡던
    # 것을 양쪽-아이템 게이트로(반쪽 금지). dep 미존재 시 404.
    dep = await repo.get(id)
    if dep is None:
        raise HTTPException(status_code=404, detail="의존성을 찾을 수 없음")
    user_id = uuid.UUID(auth.user_id)
    await _assert_item_project_access(repo.session, user_id, repo.org_id, dep.from_id, dep.item_type)
    await _assert_item_project_access(repo.session, user_id, repo.org_id, dep.to_id, dep.item_type)
    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="의존성을 찾을 수 없음")
    return {"ok": True}


@router.get("/graph", response_model=DependencyGraphResponse)
async def dependency_graph(
    item_type: str = Query(...),
    item_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> DependencyGraphResponse:
    if item_type not in ITEM_TYPES:
        raise HTTPException(status_code=422, detail=f"item_type must be one of {sorted(ITEM_TYPES)}")
    user_id = uuid.UUID(auth.user_id)
    if item_id is not None:
        await _assert_item_project_access(session, user_id, org_id, item_id, item_type)

    item_ids = [item_id] if item_id else None
    # 그래프/사이클 계산은 org-wide 유지(AC3) — 응답만 caller-accessible project로 필터해 접근권 없는
    # project의 노드·엣지를 노출하지 않는다(graph read-exposure 봉인).
    nodes, edges = await get_graph(session, org_id, item_type, item_ids)
    accessible = set(await accessible_project_ids_in_org(session, user_id, org_id))
    node_project = await _items_project_map(session, org_id, item_type, nodes)
    visible = {n for n in nodes if node_project.get(n) in accessible}
    visible_nodes = [n for n in nodes if n in visible]
    visible_edges = [
        e for e in edges
        if uuid.UUID(e["from_id"]) in visible and uuid.UUID(e["to_id"]) in visible
    ]
    return DependencyGraphResponse(item_type=item_type, nodes=visible_nodes, edges=visible_edges)
