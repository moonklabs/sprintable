import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.dependency import ITEM_TYPES
from app.models.pm import Goal, Sprint, Story
from app.repositories.dependency import DependencyRepository
from app.schemas.dependency import (
    DependencyCreate,
    DependencyGraphResponse,
    DependencyResponse,
    DependencyUpdate,
)
from app.services.dependency_graph import get_graph, would_create_cycle
from app.services.project_auth import accessible_project_ids_in_org, has_project_access

router = APIRouter(prefix="/api/v2/dependencies", tags=["dependencies", "Work"])

# item_type → project-소속 모델. epic/sprint/story 셋 다 project_id 직접 컬럼(pm.py) — polymorphic
# 간접(task→story) 없음. dependency 자체엔 project_id가 없어 아이템→project로 해소해 게이팅한다.
_ITEM_MODEL = {"epic": Goal, "sprint": Sprint, "story": Story}


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

    # P0-04(doc trust-pipeline-be-design §4 훅②): trust_stage mutation 전 스냅샷(blocked 신호는 story
    # +blocks 타입만 영향 — to_id가 막히는 쪽).
    _trust_before = None
    if body.item_type == "story" and body.dep_type == "blocks":
        from app.services.trust_pipeline import compute_trust_facts

        _trust_before = await compute_trust_facts(session, org_id, body.to_id)

    dep = await repo.create(
        from_id=body.from_id,
        to_id=body.to_id,
        dep_type=body.dep_type,
        item_type=body.item_type,
    )

    if _trust_before is not None:
        from app.services.trust_pipeline import maybe_emit_trust_stage_changed

        await maybe_emit_trust_stage_changed(
            session, org_id, body.to_id, _trust_before, actor_id=user_id
        )

    # story #3180(S3 후속) — 새 blocks 의존성 = unanswered_blocker 파생의 생성 입력(attention).
    if body.item_type == "story" and body.dep_type == "blocks":
        from app.services.attention_events import notify_attention_changed

        await notify_attention_changed(org_id)

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


@router.patch("/{id}", response_model=DependencyResponse)
async def update_dependency(
    id: uuid.UUID,
    body: DependencyUpdate,
    repo: DependencyRepository = Depends(_get_repo),
    auth: AuthContext = Depends(get_current_user),
) -> DependencyResponse:
    """story #2258 AC3: 대기 해제 조건(dep_type) «수정» — 생성+삭제로 흉내내지 않는다(같은 id·
    created_at 보존, 감사 기록이 「삭제 후 생성」이 아니라 「수정」으로 남는다). create/delete와
    동일하게 양쪽-아이템 project 접근권 게이트(반쪽 금지) + trust_pipeline 훅 유지."""
    dep = await repo.get(id)
    if dep is None:
        raise HTTPException(status_code=404, detail="의존성을 찾을 수 없음")
    user_id = uuid.UUID(auth.user_id)
    await _assert_item_project_access(repo.session, user_id, repo.org_id, dep.from_id, dep.item_type)
    await _assert_item_project_access(repo.session, user_id, repo.org_id, dep.to_id, dep.item_type)

    # P0-04: dep_type 변경으로 blocks 여부가 어느 방향으로든 뒤집힐 수 있어(depends_on→blocks도
    # blocks→depends_on도) create/delete와 달리 "old이거나 new이거나 blocks"로 넓게 게이트한다.
    _trust_before = None
    if dep.item_type == "story" and (dep.dep_type == "blocks" or body.dep_type == "blocks"):
        from app.services.trust_pipeline import compute_trust_facts

        _trust_before = await compute_trust_facts(repo.session, repo.org_id, dep.to_id)

    updated = await repo.update_dep_type(id, body.dep_type)
    if updated is None:
        raise HTTPException(status_code=404, detail="의존성을 찾을 수 없음")

    if _trust_before is not None:
        from app.services.trust_pipeline import maybe_emit_trust_stage_changed

        await maybe_emit_trust_stage_changed(
            repo.session, repo.org_id, dep.to_id, _trust_before, actor_id=user_id
        )

    # story #3180(S3 후속) — dep_type이 어느 방향으로든 blocks를 넘나들면(생성·해소 둘 다)
    # unanswered_blocker 파생의 입력이 바뀐 것 — 위 trust_before 게이팅과 동일 조건.
    if dep.item_type == "story" and (dep.dep_type == "blocks" or body.dep_type == "blocks"):
        from app.services.attention_events import notify_attention_changed

        await notify_attention_changed(repo.org_id)

    return DependencyResponse.model_validate(updated)


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

    # P0-04(doc trust-pipeline-be-design §4 훅②): trust_stage mutation 전 스냅샷.
    _trust_before = None
    if dep.item_type == "story" and dep.dep_type == "blocks":
        from app.services.trust_pipeline import compute_trust_facts

        _trust_before = await compute_trust_facts(repo.session, repo.org_id, dep.to_id)

    ok = await repo.delete(id)
    if not ok:
        raise HTTPException(status_code=404, detail="의존성을 찾을 수 없음")

    if _trust_before is not None:
        from app.services.trust_pipeline import maybe_emit_trust_stage_changed

        await maybe_emit_trust_stage_changed(
            repo.session, repo.org_id, dep.to_id, _trust_before, actor_id=user_id
        )

    # story #3180(S3 후속) — blocks 의존성 삭제 = unanswered_blocker 해소(attention 파생 입력).
    if dep.item_type == "story" and dep.dep_type == "blocks":
        from app.services.attention_events import notify_attention_changed

        await notify_attention_changed(repo.org_id)

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
