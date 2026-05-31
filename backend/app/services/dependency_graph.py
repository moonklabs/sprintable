"""E-BOARD-SCHEMA S2: 의존성 그래프 사이클 검출 서비스.

알고리즘: BFS로 to_id에서 도달 가능한 노드 탐색.
from_id가 그 집합에 포함되면 → A→B→…→A 사이클.
자기참조(from_id == to_id)는 사전 거부.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dependency import ItemDependency


async def would_create_cycle(
    session: AsyncSession,
    org_id: uuid.UUID,
    from_id: uuid.UUID,
    to_id: uuid.UUID,
    item_type: str,
) -> bool:
    """새 엣지 from_id→to_id 추가 시 사이클 발생 여부 검사.

    Returns:
        True  → 사이클 발생 (추가 거부해야 함)
        False → 안전
    """
    if from_id == to_id:
        return True  # 자기참조

    # BFS: to_id에서 도달 가능한 노드 집합 계산
    visited: set[uuid.UUID] = set()
    queue: list[uuid.UUID] = [to_id]

    while queue:
        current = queue.pop()
        if current in visited:
            continue
        visited.add(current)

        if current == from_id:
            return True  # from_id 도달 → 사이클

        result = await session.execute(
            select(ItemDependency.to_id).where(
                ItemDependency.org_id == org_id,
                ItemDependency.from_id == current,
                ItemDependency.item_type == item_type,
            )
        )
        for (next_id,) in result.all():
            if next_id not in visited:
                queue.append(next_id)

    return False


async def get_graph(
    session: AsyncSession,
    org_id: uuid.UUID,
    item_type: str,
    item_ids: list[uuid.UUID] | None = None,
) -> tuple[list[uuid.UUID], list[dict]]:
    """item_type 그래프 전체(또는 item_ids 서브셋)의 노드·엣지 반환.

    Returns:
        (nodes, edges) — nodes: 등장하는 모든 UUID, edges: {from_id, to_id, dep_type} dict 목록
    """
    q = select(ItemDependency).where(
        ItemDependency.org_id == org_id,
        ItemDependency.item_type == item_type,
    )
    if item_ids is not None:
        q = q.where(
            ItemDependency.from_id.in_(item_ids) | ItemDependency.to_id.in_(item_ids)
        )
    result = await session.execute(q)
    rows = result.scalars().all()

    node_set: set[uuid.UUID] = set()
    edges: list[dict] = []
    for dep in rows:
        node_set.add(dep.from_id)
        node_set.add(dep.to_id)
        edges.append({
            "id": str(dep.id),
            "from_id": str(dep.from_id),
            "to_id": str(dep.to_id),
            "dep_type": dep.dep_type,
        })

    return list(node_set), edges
