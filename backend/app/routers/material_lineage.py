"""story #4058(E-RECIPE-1 성공기준 4) — material_lineage 조회 API. write 엔드포인트는
이 카드 범위 밖(lineage row insert는 apply-time 후속 스토리 몫, doc c7991109 §3④) — 이
파일은 디디 #4061 web 데이터층(use-material-lineage 훅)이 소비할 GET 3종을 연다.
evidence.py::list_evidence와 동형 권한 축(org 멤버 누구나 GET, write 없음)."""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.channel_post_draft import ChannelPostDraft
from app.models.channel_publication import ChannelPublication
from app.models.material_lineage import MaterialLineage
from app.routers.gates import _resolve_work_item_summary
from app.routers.insight_snapshots import InsightSnapshotView
from app.services.insight_snapshots import (
    list_insight_snapshots_for_publication,
    resolve_head_publication_id,
)
from app.services.material_lineage import HookPerformanceSummary, compute_hook_performance

router = APIRouter(prefix="/api/v2/material-lineage", tags=["material-lineage"])


class MaterialLineageEdgeView(BaseModel):
    id: uuid.UUID
    source_evidence_id: uuid.UUID
    derived_kind: str
    derived_id: uuid.UUID
    relation_kind: str
    variant_axis: str | None
    hook_key: str | None
    work_item_id: uuid.UUID
    # story #4058(디디 갭2, 페드루 PO 経由 2026-09-19) — uuid 표시("storyboard #a3f2")
    # 대신 사람이 읽는 표시명. 새 join/테이블 0 — 둘 다 기존 값 재사용. 목록 안 모든
    # edge가 같은 work_item_id(쿼리 파라미터)를 공유하므로 master_title은 매 edge에
    # 같은 값이 중복 실린다(트리 렌더가 edge 단위로 독립 렌더할 때 교차조회 없이 쓰게).
    master_title: str | None = None
    channel: str | None = None


class HookPerformanceView(BaseModel):
    # story #4351 PR B — 합산 범위(접근이 제한된 caller = "accessible_projects" · owner/admin = "org").
    scope: Literal["org", "accessible_projects"] = "org"
    hook_key: str
    variant_count: int
    snapshot_count: int
    totals: dict[str, int | None]

    @classmethod
    def from_summary(cls, summary: HookPerformanceSummary) -> "HookPerformanceView":
        return cls(
            hook_key=summary.hook_key, variant_count=summary.variant_count,
            snapshot_count=summary.snapshot_count, totals=summary.totals,
        )


async def _caller_can_access_story_project(session: AsyncSession, org_id: uuid.UUID, story_id: uuid.UUID, auth) -> bool:
    """story #4351 PR B — 계보의 마스터(항상 story)가 caller가 접근 못 하는 프로젝트면 False. 스토리가 없으면(지워짐)도 False(fail-closed ·
    까디르 P2): 계보 행은 스토리 FK · 정리가 없어 지운 스토리의 고아 행이 남는데, 가릴 프로젝트를 모른다고 누구에게나 보이면 안 된다."""
    from app.models.pm import Story
    from app.services.project_auth import has_project_access

    story_project_id = (await session.execute(
        select(Story.project_id).where(Story.id == story_id, Story.org_id == org_id)
    )).scalar_one_or_none()
    if story_project_id is None:
        return False
    return await has_project_access(session, uuid.UUID(str(auth.user_id)), story_project_id, org_id)


@router.get("", response_model=list[MaterialLineageEdgeView])
async def list_material_lineage(
    work_item_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[MaterialLineageEdgeView]:
    """디디 #4061 buildLineageTree(edges)가 소비할 원자료 — 마스터(work_item_id)당
    계보 edge 전부(변주 여러 개 가능). org access 검증은 work_item 소유 확認 없이
    org_id 스코프만 건다(evidence.py의 project-단위 has_project_access와 달리, 이
    edge 자체는 project 소속 콘텐츠가 아니라 org 내부 계보 그래프라 org 스코프면
    충분 — 노출 위험 낮음, read-only)."""
    # story #4351 PR B(⑧ · SEC-S8) — 위 «org 스코프면 충분»은 계보 edge만 볼 때 얘기다: 응답이 마스터 스토리 제목(master_title)을
    # 싣는다 → work_item_id만 알면 접근 권한 없는 프로젝트의 스토리 제목이 보였다. 그 스토리 프로젝트에 접근 못 하면 없는 id와 같은 `[]`.
    if not await _caller_can_access_story_project(session, org_id, work_item_id, _auth):
        return []

    rows = (await session.execute(
        select(MaterialLineage).where(
            MaterialLineage.org_id == org_id,
            MaterialLineage.work_item_id == work_item_id,
        ).order_by(MaterialLineage.created_at.asc())
    )).scalars().all()
    if not rows:
        return []

    # ① master_title — gates.py::_resolve_work_item_summary 그대로 재사용(fail-soft,
    # story 4058 doc이 확定한 material_lineage.work_item_id는 항상 story). 목록 전체가
    # 같은 work_item_id를 공유하므로 1회만 조회.
    summary = await _resolve_work_item_summary(session, org_id, "story", work_item_id)
    master_title = summary.title if summary is not None else None

    # ② channel — derived_kind별로 batch IN 조회(N+1 회피). channel_post_draft/
    # channel_publication 둘 다 이미 갖고 있는 denorm 컬럼을 그대로 반사할 뿐, 새 join
    # 대상 테이블·새 컬럼 0.
    draft_ids = [r.derived_id for r in rows if r.derived_kind == "channel_post_draft"]
    publication_ids = [r.derived_id for r in rows if r.derived_kind == "channel_publication"]
    channel_by_derived_id: dict[uuid.UUID, str] = {}
    if draft_ids:
        for did, ch in (await session.execute(
            select(ChannelPostDraft.id, ChannelPostDraft.channel).where(
                ChannelPostDraft.org_id == org_id, ChannelPostDraft.id.in_(draft_ids),
            )
        )).all():
            channel_by_derived_id[did] = ch
    if publication_ids:
        for pid, ch in (await session.execute(
            select(ChannelPublication.id, ChannelPublication.channel).where(
                ChannelPublication.org_id == org_id, ChannelPublication.id.in_(publication_ids),
            )
        )).all():
            channel_by_derived_id[pid] = ch

    return [
        MaterialLineageEdgeView(
            id=r.id, source_evidence_id=r.source_evidence_id, derived_kind=r.derived_kind,
            derived_id=r.derived_id, relation_kind=r.relation_kind, variant_axis=r.variant_axis,
            hook_key=r.hook_key, work_item_id=r.work_item_id, master_title=master_title,
            channel=channel_by_derived_id.get(r.derived_id),
        )
        for r in rows
    ]


@router.get("/hook-performance", response_model=HookPerformanceView)
async def get_hook_performance(
    hook_key: str = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> HookPerformanceView:
    """유나 성과 화면이 소비할 축 — doc c7991109 §3③. 미등록 hook_key도 에러 없이
    빈 요약(전부 None/0)을 낸다(compute_hook_performance 자체 계약, 지어내지 않는다)."""
    from app.services.project_auth import restricted_accessible_project_ids

    # story #4351 PR B — 접근이 제한된 caller는 접근 가능 프로젝트 변주만 합산(owner/admin = None = 옛 동작).
    restricted = await restricted_accessible_project_ids(session, uuid.UUID(str(_auth.user_id)), org_id)
    summary = await compute_hook_performance(session, org_id=org_id, hook_key=hook_key, project_ids=restricted)
    view = HookPerformanceView.from_summary(summary)
    view.scope = "org" if restricted is None else "accessible_projects"
    return view


@router.get("/material-performance", response_model=list[InsightSnapshotView])
async def get_material_performance(
    derived_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> list[InsightSnapshotView]:
    """PO 지적(2026-09-19) — #4058 계약은 "소재·**훅**"인데 hook-performance만 노출하고
    소재(변주) 단위 성과가 없어 디디 트리 노드별 성과 막대를 못 그렸다. 새 집계 기전을
    발명하지 않는다 — `derived_id`(channel_publication.id)로 기존 insight_snapshots.py
    조회 축(`list_insight_snapshots_for_publication`·`resolve_head_publication_id`,
    story #3497/#3829, organic-only 필터·재발행 헤드 해석 이미 내장)을 그대로 재사용한다.

    `channel_post_draft`(발행 前) 변주나, 이 org 소속이 아닌 derived_id는 **빈 목록**으로
    답한다(에러 아님·존재 비노출 — insight_snapshots.py::_list_publication_insights_
    endpoint의 "소유 아니면 404"와 같은 정신을 GET-목록 축에 맞게 적용한 것: 여긴 단건
    404가 아니라 목록이라 "그 소재는 아직 성과가 없다"와 "org 밖 id"를 굳이 안 갈라도
    지어내는 값이 없다 — 둘 다 정직하게 빈 배열)."""
    owns = (await session.execute(
        select(MaterialLineage.work_item_id).where(
            MaterialLineage.org_id == org_id,
            MaterialLineage.derived_id == derived_id,
            MaterialLineage.derived_kind == "channel_publication",
        ).limit(1)
    )).scalar_one_or_none()
    if owns is None:
        return []
    # story #4351 PR B(⑧ 형제 · 가드 첫 스캔이 잡음) — 발행물 성과도 마스터 스토리 프로젝트 소속이다. 접근 못 하면 org 밖 id와 같은 `[]`.
    if not await _caller_can_access_story_project(session, org_id, owns, _auth):
        return []

    publication_id = await resolve_head_publication_id(session, publication_id=derived_id)
    rows = await list_insight_snapshots_for_publication(session, org_id=org_id, publication_id=publication_id)
    return [
        InsightSnapshotView(
            id=r.id, channel=r.channel, due_at=r.due_at, captured_at=r.captured_at,
            status=r.status, normalized=r.normalized, source=r.source, error_code=r.error_code,
        )
        for r in rows
    ]
