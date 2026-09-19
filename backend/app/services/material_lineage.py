"""story #4058(E-RECIPE-1 성공기준 4) — 소재·훅 단위 성과 회수 집계.

doc(entity:doc:c7991109-4349-485b-8599-d7b886c7a951) §3③ 계약대로: material_lineage를
hook_key로 매치 → 그 변주가 걸린 work_item_id 집합 → insight_snapshots(work_item_id IN
(...), status='captured') 합산. insight_snapshots.py의 NORMALIZED_KEYS(기존 7+3키) 그대로
재사용 — 새 성과 키 발명 안 함. insight_snapshots 자체엔 컬럼을 안 늘린다(스키마 변경
반경을 material_lineage 신설 1건으로 좁힌다).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.insight_snapshot import InsightSnapshot
from app.models.material_lineage import MaterialLineage
from app.services.insight_snapshots import NORMALIZED_KEYS


@dataclass(frozen=True)
class HookPerformanceSummary:
    hook_key: str
    variant_count: int
    snapshot_count: int
    # null≠0(house 관례, insight_snapshots.py NORMALIZED_KEYS와 동일 원칙) — 그 키를
    # 실제로 측정한 snapshot이 하나도 없으면 0이 아니라 None(미측정 보존).
    totals: dict[str, int | None]


async def compute_hook_performance(
    session: AsyncSession, *, org_id: uuid.UUID, hook_key: str,
) -> HookPerformanceSummary:
    """조인 축은 work_item_id가 아니라 **derived_id == insight_snapshots.publication_id**
    직접 매치다(둘 다 channel_publication.id) — 한 스토리(work_item_id)가 서로 다른 훅을 쓴
    변주 여러 개를 가질 수 있어(플랫폼별 컷), work_item_id로 묶으면 다른 훅의 성과까지
    섞여 들어오는 과다집계 결함이 된다(테스트로 실측 발견). `channel_post_draft`(발행 前
    변주)는 아직 발행 실적이 없어 이 집계 대상이 아니다 — variant_count는 전체(초안 포함)
    지만 snapshot 합산은 발행된(`channel_publication`) 변주만."""
    all_lineage_rows = (await session.execute(
        select(MaterialLineage.derived_kind, MaterialLineage.derived_id).where(
            MaterialLineage.org_id == org_id,
            MaterialLineage.hook_key == hook_key,
        )
    )).all()
    variant_count = len(all_lineage_rows)
    publication_ids = {row.derived_id for row in all_lineage_rows if row.derived_kind == "channel_publication"}
    if not publication_ids:
        return HookPerformanceSummary(
            hook_key=hook_key, variant_count=variant_count, snapshot_count=0,
            totals={key: None for key in NORMALIZED_KEYS},
        )

    snapshots = (await session.execute(
        select(InsightSnapshot).where(
            InsightSnapshot.org_id == org_id,
            InsightSnapshot.publication_id.in_(publication_ids),
            InsightSnapshot.status == "captured",
        )
    )).scalars().all()

    totals: dict[str, int | None] = {}
    for key in NORMALIZED_KEYS:
        observed = [
            snap.normalized[key]
            for snap in snapshots
            if snap.normalized is not None and snap.normalized.get(key) is not None
        ]
        totals[key] = sum(observed) if observed else None

    return HookPerformanceSummary(
        hook_key=hook_key,
        variant_count=variant_count,
        snapshot_count=len(snapshots),
        totals=totals,
    )
