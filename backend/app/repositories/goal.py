import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.evidence import Evidence
from app.models.gate import AUTO_VERIFY_MAP as _AUTO_VERIFY_MAP
from app.models.gate import Gate
from app.models.hypothesis import Hypothesis, HypothesisEpicLink
from app.models.member import Member
from app.models.pm import Goal, Story
from app.models.story_assignee import StoryAssignee
from app.repositories.base import BaseRepository
from app.schemas.goal import GoalProgressResponse

# risky_status 우선순위: 최위험(falsified) → 최저위험(archived). 인덱스가 곧 rank.
_RISK_ORDER: tuple[str, ...] = (
    "falsified",
    "measuring",
    "active",
    "proposed",
    "verified",
    "killed",
    "archived",
)


class GoalRepository(BaseRepository[Goal]):
    """계층 리네이밍 B1(story 1925): 구 EpicRepository — 클래스명만 rename. FK 컬럼
    (Story.epic_id·HypothesisEpicLink.epic_id)은 B4 후속 스코프라 그대로 사용."""

    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        super().__init__(Goal, session, org_id)

    async def list_paginated(
        self,
        *,
        limit: int | None = None,
        cursor: datetime | None = None,
        order_by: str = "created_at",
        **filters: Any,
    ) -> tuple[list[Goal], int]:
        """기본 페이지네이션 + 연결 가설 집계(hypothesis_count·risky_status) + 스토리 집계
        (total_stories·done_stories) 부착.

        E-GLANCE wedge #2(story 96b19bc3) §1.3: order_by="position"은 옵트인 로드맵 조타
        정렬 — (position IS NULL) ASC, position ASC, created_at DESC 복합 규칙이라 BaseRepository의
        단조-컬럼 cursor 메커니즘(datetime 비교)과 shape가 달라 별도 경로로 처리한다(cursor
        파라미터는 이 모드에서 미지원 — v1 스코프, #2056 기본 정렬 경로는 완전 무변경).
        """
        if order_by == "position":
            goals, total = await self._list_paginated_by_position(limit=limit, **filters)
        else:
            goals, total = await super().list_paginated(
                limit=limit, cursor=cursor, order_by=order_by, **filters
            )
        await self._attach_hypothesis_aggregates(goals)
        await self._attach_story_aggregates(goals)
        return goals, total

    async def _list_paginated_by_position(
        self, *, limit: int | None, **filters: Any,
    ) -> tuple[list[Goal], int]:
        conds = [self._org_filter()]
        for attr, val in filters.items():
            conds.append(getattr(Goal, attr) == val)

        count_result = await self.session.execute(
            select(func.count()).select_from(Goal).where(*conds)
        )
        total = int(count_result.scalar_one() or 0)

        q = (
            select(Goal).where(*conds)
            .order_by(Goal.position.is_(None).asc(), Goal.position.asc(), Goal.created_at.desc())
            .limit(limit if limit is not None else 1000)
        )
        result = await self.session.execute(q)
        return list(result.scalars().all()), total

    async def _attach_hypothesis_aggregates(self, goals: Sequence[Goal]) -> None:
        """페이지 전체 goal의 연결 가설 수/최위험 상태를 단일 쿼리로 집계해 부착.

        N+1 회피: epic_id IN (page) GROUP BY로 1회 집계. risky_status는 위험도
        rank의 MIN을 골라 다시 상태명으로 환원. 링크/가설이 없으면 count 0·risky
        None. 비-매핑 인스턴스 속성이라 읽기 경로에서 flush 영향 없음.
        """
        for goal in goals:
            goal.hypothesis_count = 0  # type: ignore[attr-defined]
            goal.risky_status = None  # type: ignore[attr-defined]
        if not goals:
            return

        goal_ids = [goal.id for goal in goals]
        rank_case = case(
            *[(Hypothesis.status == status, rank) for rank, status in enumerate(_RISK_ORDER)],
            else_=len(_RISK_ORDER),
        )
        result = await self.session.execute(
            select(
                HypothesisEpicLink.epic_id.label("epic_id"),
                func.count(func.distinct(HypothesisEpicLink.hypothesis_id)).label("cnt"),
                func.min(rank_case).label("risk_rank"),
            )
            .join(Hypothesis, Hypothesis.id == HypothesisEpicLink.hypothesis_id)
            .where(
                HypothesisEpicLink.epic_id.in_(goal_ids),
                Hypothesis.org_id == self.org_id,
            )
            .group_by(HypothesisEpicLink.epic_id)
        )
        by_goal = {row.epic_id: row for row in result.all()}
        for goal in goals:
            row = by_goal.get(goal.id)
            if row is None:
                continue
            goal.hypothesis_count = int(row.cnt or 0)  # type: ignore[attr-defined]
            rank = row.risk_rank
            if rank is not None and 0 <= rank < len(_RISK_ORDER):
                goal.risky_status = _RISK_ORDER[rank]  # type: ignore[attr-defined]

    async def _attach_story_aggregates(self, goals: Sequence[Goal]) -> None:
        """페이지 전체 goal의 연결 스토리 수(total/done)를 단일 쿼리로 집계해 부착.

        N+1 회피: epic_id IN (page) GROUP BY로 1회 집계(get_progress 집계 SQL 동형).
        deleted_at IS NULL·org 스코프. 스토리 없으면 0/0. 비-매핑 인스턴스 속성이라
        읽기 경로에서 flush 영향 없음. FE 목표 카드(total/done) 바인딩용 — stories
        배열은 부착 안 함(payload bloat 방지·detail은 별도 /progress 유지).
        """
        for goal in goals:
            goal.total_stories = 0  # type: ignore[attr-defined]
            goal.done_stories = 0  # type: ignore[attr-defined]
        if not goals:
            return

        goal_ids = [goal.id for goal in goals]
        result = await self.session.execute(
            select(
                Story.epic_id.label("epic_id"),
                func.count(Story.id).label("total_stories"),
                func.count(Story.id).filter(Story.status == "done").label("done_stories"),
            )
            .where(
                Story.epic_id.in_(goal_ids),
                Story.org_id == self.org_id,
                Story.deleted_at.is_(None),
            )
            .group_by(Story.epic_id)
        )
        by_goal = {row.epic_id: row for row in result.all()}
        for goal in goals:
            row = by_goal.get(goal.id)
            if row is None:
                continue
            goal.total_stories = int(row.total_stories or 0)  # type: ignore[attr-defined]
            goal.done_stories = int(row.done_stories or 0)  # type: ignore[attr-defined]

    async def attach_glance_aggregates(self, goals: Sequence[Goal]) -> None:
        """story #2298(3단 웨이터폴 근절) — `?include=glance` 옵트인 전용, `list_paginated`
        기본 경로는 이걸 안 부른다(byte-identical 보장은 라우터가 호출 여부로 가른다).

        participant_ids: 에픽별 고유 assignee_id 집합(FE `deriveCollaboration` 이관 — "참여=
        presence만"이라 집합 계산, 캡을 두면 뒤쪽 story의 assignee가 빠져 값 자체가 틀려진다
        — 그래서 캡 없음).

        focal_story: FE `pickFocalStory`(in-progress 중 gate-pending 우선, 없으면 최신
        in-progress) 이관. tiebreak는 기존 `/api/stories?epic_id=` 기본 정렬(created_at DESC,
        id DESC)과 동일하게 맞춘다 — gate 우선순위 자체는 이번에 "처음으로" 실제 재료(gate
        데이터)를 갖고 평가된다(`GlanceFocalStory` docstring 참조 — 기존엔 재료가 없어 죽어
        있던 분기). story #2303부터 `focal_story`가 `/api/glance/hero?story_id=`가 주던
        9필드(assignee_ids·proof_count·auto_verify·gate.*·trust.*)까지 싣는다 — 전부 픽된
        focal story id 집합(페이지 전체 goal 기준)으로 배치 조회, N+1 없음.

        latest_story_activity_at: story #3126 — 에픽별 non-done story updated_at 최댓값
        (없으면 None). `derive-next-maker.ts`의 기존 client-side 계산과 동일 정의를 BE로
        승격 — GROUP BY 단일 쿼리, N+1 없음."""
        for goal in goals:
            goal.participant_ids = []  # type: ignore[attr-defined]
            goal.focal_story = None  # type: ignore[attr-defined]
            goal.latest_story_activity_at = None  # type: ignore[attr-defined]
        if not goals:
            return

        goal_ids = [g.id for g in goals]

        activity_rows = await self.session.execute(
            select(Story.epic_id, func.max(Story.updated_at)).where(
                Story.epic_id.in_(goal_ids), Story.org_id == self.org_id,
                Story.deleted_at.is_(None), Story.status != "done",
            ).group_by(Story.epic_id)
        )
        activity_by_goal: dict[uuid.UUID, datetime] = dict(activity_rows.all())
        for goal in goals:
            latest = activity_by_goal.get(goal.id)
            if latest is not None:
                goal.latest_story_activity_at = latest  # type: ignore[attr-defined]

        participant_rows = await self.session.execute(
            select(Story.epic_id, Story.assignee_id).where(
                Story.epic_id.in_(goal_ids), Story.org_id == self.org_id,
                Story.deleted_at.is_(None), Story.assignee_id.isnot(None),
            )
        )
        participants_by_goal: dict[uuid.UUID, set[uuid.UUID]] = {}
        for epic_id, assignee_id in participant_rows.all():
            participants_by_goal.setdefault(epic_id, set()).add(assignee_id)
        for goal in goals:
            ids = participants_by_goal.get(goal.id)
            if ids:
                goal.participant_ids = sorted(ids, key=str)  # type: ignore[attr-defined]

        in_progress_rows = await self.session.execute(
            select(Story.id, Story.epic_id, Story.title, Story.status, Story.assignee_id)
            .where(
                Story.epic_id.in_(goal_ids), Story.org_id == self.org_id,
                Story.deleted_at.is_(None), Story.status == "in-progress",
            )
            .order_by(Story.created_at.desc(), Story.id.desc())
        )
        candidates_by_goal: dict[uuid.UUID, list] = {}
        story_ids: list[uuid.UUID] = []
        for row in in_progress_rows.all():
            candidates_by_goal.setdefault(row.epic_id, []).append(row)
            story_ids.append(row.id)

        # N+1 회피 — 배치 pending-gate 조회. Gate는 work_item_id/work_item_type 폴리모픽(FK
        # 없음, S11 workflow-line 배치 read와 동일 패턴: work_item_id.in_(ids)). gate_type·
        # requires_human까지 같이 뽑아 두면(story #2303) tie-break 판정과 최종 gate 필드를
        # «같은 쿼리»로 겸한다(따로 또 조회 안 함) — created_at DESC라 story별 첫 항목이
        # 최신 pending gate(기존 hero의 `.order_by(created_at.desc()).limit(1)`과 동형).
        pending_gate_by_story: dict[uuid.UUID, Any] = {}
        if story_ids:
            gate_rows = await self.session.execute(
                select(Gate.work_item_id, Gate.gate_type, Gate.requires_human).where(
                    Gate.work_item_id.in_(story_ids), Gate.work_item_type == "story",
                    Gate.org_id == self.org_id, Gate.status == "pending",
                ).order_by(Gate.created_at.desc())
            )
            for row in gate_rows.all():
                pending_gate_by_story.setdefault(row.work_item_id, row)
        pending_story_ids = set(pending_gate_by_story)

        picked_by_goal: dict[uuid.UUID, Any] = {}
        for goal in goals:
            candidates = candidates_by_goal.get(goal.id)
            if not candidates:
                continue
            picked_by_goal[goal.id] = next(
                (r for r in candidates if r.id in pending_story_ids), candidates[0]
            )
        if not picked_by_goal:
            return

        focal_ids = [r.id for r in picked_by_goal.values()]

        # assignee_ids — StoryAssignee join(E-BOARD S5). 배열이라 캡 없음(전부).
        assignee_rows = await self.session.execute(
            select(StoryAssignee.story_id, StoryAssignee.member_id).where(
                StoryAssignee.story_id.in_(focal_ids), StoryAssignee.org_id == self.org_id,
            )
        )
        assignee_ids_by_story: dict[uuid.UUID, list[uuid.UUID]] = {}
        for story_id, member_id in assignee_rows.all():
            assignee_ids_by_story.setdefault(story_id, []).append(member_id)

        # proof_count — evidence row 개수(hero와 동일 정의).
        proof_rows = await self.session.execute(
            select(Evidence.work_item_id, func.count(Evidence.id)).where(
                Evidence.org_id == self.org_id, Evidence.work_item_id.in_(focal_ids),
                Evidence.work_item_type == "story",
            ).group_by(Evidence.work_item_id)
        )
        proof_count_by_story: dict[uuid.UUID, int] = dict(proof_rows.all())

        # auto_verify — merge gate의 evidence_status(hero의 _AUTO_VERIFY_MAP과 동일 원자료).
        merge_rows = await self.session.execute(
            select(Gate.work_item_id, Gate.evidence_status).where(
                Gate.org_id == self.org_id, Gate.work_item_id.in_(focal_ids),
                Gate.work_item_type == "story", Gate.gate_type == "merge",
            ).order_by(Gate.created_at.desc())
        )
        merge_status_by_story: dict[uuid.UUID, str | None] = {}
        for story_id, evidence_status in merge_rows.all():
            merge_status_by_story.setdefault(story_id, evidence_status)

        # human_verified — 최신 gate_approval evidence(휴먼 서명·스푸핑불가, hero와 동일).
        hv_rows = await self.session.execute(
            select(Evidence.work_item_id, Evidence.created_by, Evidence.created_at).where(
                Evidence.org_id == self.org_id, Evidence.work_item_id.in_(focal_ids),
                Evidence.work_item_type == "story", Evidence.type == "gate_approval",
            ).order_by(Evidence.created_at.desc())
        )
        hv_by_story: dict[uuid.UUID, Any] = {}
        for row in hv_rows.all():
            hv_by_story.setdefault(row.work_item_id, row)

        hv_member_ids = {row.created_by for row in hv_by_story.values() if row.created_by}
        member_name_by_id: dict[uuid.UUID, str] = {}
        if hv_member_ids:
            member_rows = await self.session.execute(
                select(Member.id, Member.name).where(Member.id.in_(hv_member_ids))
            )
            member_name_by_id = dict(member_rows.all())

        for goal_id, picked in picked_by_goal.items():
            proof_count = proof_count_by_story.get(picked.id, 0)
            hv_row = hv_by_story.get(picked.id)
            hv_member = None
            if hv_row is not None and hv_row.created_by in member_name_by_id:
                hv_member = {"name": member_name_by_id[hv_row.created_by]}
            pending_gate = pending_gate_by_story.get(picked.id)
            merge_status = merge_status_by_story.get(picked.id)

            goal = next(g for g in goals if g.id == goal_id)
            goal.focal_story = {  # type: ignore[attr-defined]
                "id": picked.id, "title": picked.title, "status": picked.status,
                "assignee_id": picked.assignee_id,
                "assignee_ids": assignee_ids_by_story.get(picked.id, []),
                "proof_count": proof_count,
                "auto_verify": _AUTO_VERIFY_MAP.get(merge_status) if merge_status else None,
                "gate": (
                    {"gate_type": pending_gate.gate_type, "requires_human": pending_gate.requires_human}
                    if pending_gate is not None else None
                ),
                "trust": {
                    "self_reported": proof_count > 0,
                    "human_verified": hv_row is not None,
                    "human_verified_by": hv_member,
                    "human_verified_at": hv_row.created_at if hv_row is not None else None,
                },
            }

    async def get_progress(self, id: uuid.UUID) -> GoalProgressResponse:
        result = await self.session.execute(
            select(
                func.count(Story.id).label("total_stories"),
                func.sum(Story.story_points).label("total_sp"),
                func.count(Story.id).filter(Story.status == "done").label("done_stories"),
                func.sum(Story.story_points).filter(Story.status == "done").label("done_sp"),
            ).where(
                Story.epic_id == id,
                Story.deleted_at.is_(None),
            )
        )
        row = result.one()
        total_stories = row.total_stories or 0
        done_stories = row.done_stories or 0
        total_sp = int(row.total_sp or 0)
        done_sp = int(row.done_sp or 0)
        completion_pct = round((done_sp / total_sp) * 100) if total_sp > 0 else 0

        return GoalProgressResponse(
            goal_id=id,
            total_stories=total_stories,
            done_stories=done_stories,
            total_sp=total_sp,
            done_sp=done_sp,
            completion_pct=completion_pct,
        )
