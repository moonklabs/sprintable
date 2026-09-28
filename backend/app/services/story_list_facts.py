"""story #4299 ① — 목록 응답의 붙이기 칸을 **한 SQL(한 왕복)**로 읽는다.

왜: dev EXPLAIN(PO 2026-09-28) — 요청 하나의 DB 안쪽 합은 약 22ms인데 앱이 잰 요청당 SQL 합은 79ms. 남는 약 70%는 쿼리 실행이
아니라 문장마다 오가는 왕복(Cloud Run → PgBouncer VM → Cloud SQL, 문장당 약 4ms)이었다. 목록은 페이지 story id로
«한 번씩 묻는» 작은 문장을 아홉 개 냈다(assignee · 위임 에이전트 · evidence 둘 · 가설 링크 · slug · trust 넷).
scope_violation(trust 넷 중 하나)은 목록 응답에 쓰이지 않는다 — `derive_trust_stage`가 안 본다(test_4299_story_list_facts_realdb가 그 전제를 못박음) —
그래서 읽지 않는다(예전에도 읽고 버렸다).

여기서는 페이지 id(과 폴백 담당 · project id)를 `unnest`로 펼치고, 칸마다 그 행의 story id에 붙는 스칼라 서브쿼리 · EXISTS ·
LATERAL로 한 문장에 담는다. 조건은 원래 모듈의 필터 빌더를 그대로 쓴다(batch_* 함수와 같은 조건 — 두 판정이 갈리지 않게):
`evidence_service.gate_approval_filter` · `trust_pipeline.*_filter` · `unresolved_blocker_select` · `member_resolver.is_agent_member_expr`.
결과는 예전 헬퍼들이 채우던 값과 같다(바이트 동일 — test_4299_request_sql_count_realdb의 응답 대조 · story_list_facts parity 테스트).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import exists, func, select, true
from sqlalchemy.dialects.postgresql import ARRAY, UUID, aggregate_order_by
from sqlalchemy.exc import NoResultFound
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dependency import ItemDependency
from app.models.evidence import Evidence
from app.models.gate import Gate
from app.models.hypothesis import HypothesisStoryLink
from app.models.organization import Organization
from app.models.pm import Story
from app.models.project import Project
from app.models.story_assignee import StoryAssignee
from app.repositories.story_assignee import assignee_display_order
from app.services.evidence_service import gate_approval_filter
from app.services.member_resolver import is_agent_member_expr
from app.services.trust_pipeline import (
    pending_human_gate_filter,
    unresolved_blocker_select,
    verify_fail_filter,
)


@dataclass(frozen=True)
class StoryListFacts:
    assignee_ids: list[uuid.UUID]          # story_assignees(created_at 순) — 비면 호출부가 assignee_id 폴백
    assignee_agent_ids: set[uuid.UUID]     # 그중 에이전트
    fallback_is_agent: bool                # 폴백 assignee_id가 에이전트인지
    has_evidence: bool
    human_verified_by: uuid.UUID | None    # 최신 gate_approval evidence(없으면 둘 다 None)
    human_verified_at: datetime | None
    has_hypothesis_link: bool
    has_pending_human_gate: bool
    has_verify_fail: bool
    has_unresolved_blocker: bool
    project_slug: str | None


async def batch_story_list_facts(
    session: AsyncSession, org_id: uuid.UUID, stories: list[Story],
) -> tuple[str, dict[uuid.UUID, StoryListFacts]]:
    """(org slug, story id → 칸 값). stories가 비면 부르지 않는다(호출부 몫). org가 없으면 NoResultFound(예전 `scalar_one()` 규약)."""
    uuid_array = ARRAY(UUID(as_uuid=True))
    page = (
        func.unnest(
            func.cast([s.id for s in stories], uuid_array),
            func.cast([s.assignee_id for s in stories], uuid_array),
            func.cast([s.project_id for s in stories], uuid_array),
        )
        .table_valued("sid", "fallback_assignee", "pid")
        .render_derived(name="page")
    )
    sid = page.c.sid

    assignees = (
        # story #4382 — 대표 담당 맨 앞 · (created_at, member_id) — 저장소 목록 · 단건과 같은 한 규칙.
        select(func.array_agg(aggregate_order_by(StoryAssignee.member_id, *assignee_display_order(page.c.fallback_assignee))))
        .where(StoryAssignee.org_id == org_id, StoryAssignee.story_id == sid)
        .scalar_subquery()
    )
    assignee_agents = (
        select(func.array_agg(StoryAssignee.member_id))
        .where(StoryAssignee.org_id == org_id, StoryAssignee.story_id == sid, is_agent_member_expr(StoryAssignee.member_id))
        .scalar_subquery()
    )
    verified = (
        select(Evidence.created_by, Evidence.created_at)
        .where(*gate_approval_filter("story"), Evidence.work_item_id == sid)
        .order_by(Evidence.created_at.desc(), Evidence.id.desc())  # story #4382 — 동률이면 id로
        .limit(1)
        .lateral("verified")
    )
    stmt = (
        select(
            sid,
            assignees,
            assignee_agents,
            is_agent_member_expr(page.c.fallback_assignee),
            exists().where(Evidence.work_item_type == "story", Evidence.work_item_id == sid),
            verified.c.created_by,
            verified.c.created_at,
            exists().where(HypothesisStoryLink.story_id == sid),
            exists().where(*pending_human_gate_filter(org_id), Gate.work_item_id == sid),
            exists().where(*verify_fail_filter(org_id), Gate.work_item_id == sid),
            unresolved_blocker_select(org_id).where(ItemDependency.to_id == sid).exists(),
            select(Project.slug).where(Project.id == page.c.pid).scalar_subquery(),
            select(Organization.slug).where(Organization.id == org_id).scalar_subquery(),
        )
        .select_from(page)
        .outerjoin(verified, true())
    )
    rows = (await session.execute(stmt)).all()
    if not rows or rows[0][-1] is None:
        raise NoResultFound("No row was found when one was required")
    facts = {
        row[0]: StoryListFacts(
            assignee_ids=list(row[1] or []),
            assignee_agent_ids=set(row[2] or []),
            fallback_is_agent=bool(row[3]),
            has_evidence=bool(row[4]),
            human_verified_by=row[5],
            human_verified_at=row[6],
            has_hypothesis_link=bool(row[7]),
            has_pending_human_gate=bool(row[8]),
            has_verify_fail=bool(row[9]),
            has_unresolved_blocker=bool(row[10]),
            project_slug=row[11],
        )
        for row in rows
    }
    return rows[0][-1], facts
