"""story #2536(E-FLOW-V4 S4): 프로젝트별 unattached_count 일별 스냅샷 계산+기록.

`_unattached_clause()`(app/repositories/story.py, story #2532)를 그대로 재사용 —
"미매달림"의 정의를 두 곳에서 따로 유지하지 않는다(정의가 갈라지면 스파크라인이
실제 필터 결과와 다른 숫자를 그리게 된다)."""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Story
from app.models.project import Project
from app.models.unattached_snapshot import UnattachedStorySnapshot
from app.repositories.story import _unattached_clause


async def compute_and_record_unattached_snapshots(
    session: AsyncSession,
) -> list[dict[str, str | int]]:
    """soft-delete 안 된 전 프로젝트를 순회해 프로젝트별 unattached_count를 계산하고
    append-only로 한 행씩 남긴다. 결과 없는 프로젝트(스토리 0건 등)도 count=0으로 기록
    ("아직 미매달림 없음"과 "측정 안 됨"을 구분하려면 0도 명시적으로 남아야 한다).

    반환값의 id들은 str — JSONResponse가 uuid.UUID를 직접 직렬화 못 하는 문제를
    cron.py의 기존 관례(workflow_grandfather_backfill의 `str(oid)`)와 동형으로 방지."""
    project_rows = (
        await session.execute(
            select(Project.id, Project.org_id).where(Project.deleted_at.is_(None))
        )
    ).all()

    results: list[dict[str, str | int]] = []
    for project_id, org_id in project_rows:
        count = (
            await session.execute(
                select(func.count())
                .select_from(Story)
                .where(
                    Story.org_id == org_id,
                    Story.project_id == project_id,
                    Story.deleted_at.is_(None),
                    _unattached_clause(),
                )
            )
        ).scalar_one()
        snapshot = UnattachedStorySnapshot(
            org_id=org_id, project_id=project_id, unattached_count=count,
        )
        session.add(snapshot)
        results.append(
            {"project_id": str(project_id), "org_id": str(org_id), "unattached_count": count}
        )
    await session.flush()
    return results
