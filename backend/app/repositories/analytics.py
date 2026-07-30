from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.pm import Goal, Sprint, Story, Task
from app.models.team import TeamMember

logger = logging.getLogger(__name__)


class AnalyticsRepository:
    def __init__(self, session: AsyncSession, org_id: uuid.UUID) -> None:
        self.session = session
        self.org_id = org_id

    async def get_overview(self, project_id: uuid.UUID) -> dict:
        sprints_r = await self.session.execute(
            select(Sprint.status).where(Sprint.project_id == project_id, Sprint.org_id == self.org_id)
        )
        sprint_rows = sprints_r.all()

        epics_r = await self.session.execute(
            select(func.count()).select_from(Goal).where(Goal.project_id == project_id, Goal.org_id == self.org_id)
        )
        epic_count = epics_r.scalar_one()

        stories_r = await self.session.execute(
            select(Story.status, Story.story_points).where(
                Story.project_id == project_id, Story.org_id == self.org_id, Story.deleted_at.is_(None)
            )
        )
        story_rows = stories_r.all()

        tasks_r = await self.session.execute(
            select(func.count()).select_from(Task).join(Story, Task.story_id == Story.id).where(
                Story.project_id == project_id, Task.org_id == self.org_id, Task.deleted_at.is_(None)
            )
        )
        task_count = tasks_r.scalar_one()

        members_r = await self.session.execute(
            select(TeamMember.type).where(
                TeamMember.project_id == project_id, TeamMember.org_id == self.org_id, TeamMember.is_active.is_(True)
            )
        )
        member_rows = members_r.all()

        return {
            "sprints": {
                "total": len(sprint_rows),
                "active": sum(1 for r in sprint_rows if r[0] == "active"),
            },
            "epics": epic_count,
            "stories": {
                "total": len(story_rows),
                "done": sum(1 for r in story_rows if r[0] == "done"),
                "total_points": sum((r[1] or 0) for r in story_rows),
            },
            "tasks": task_count,
            "memos": {"total": 0, "open": 0},
            "members": {
                "total": len(member_rows),
                "humans": sum(1 for r in member_rows if r[0] == "human"),
                "agents": sum(1 for r in member_rows if r[0] == "agent"),
            },
        }

    async def get_member_workload(self, project_id: uuid.UUID, member_id: uuid.UUID) -> dict:
        stories_r = await self.session.execute(
            select(Story.status, Story.story_points).where(
                Story.project_id == project_id,
                Story.org_id == self.org_id,
                Story.assignee_id == member_id,
                Story.deleted_at.is_(None),
            )
        )
        story_rows = stories_r.all()

        tasks_r = await self.session.execute(
            select(Task.status).join(Story, Task.story_id == Story.id).where(
                Story.project_id == project_id,
                Task.org_id == self.org_id,
                Task.assignee_id == member_id,
                Task.deleted_at.is_(None),
            )
        )
        task_rows = tasks_r.all()

        return {
            "stories": {
                "total": len(story_rows),
                "in_progress": sum(1 for r in story_rows if r[0] == "in-progress"),
                "points": sum((r[1] or 0) for r in story_rows),
            },
            "tasks": {
                "total": len(task_rows),
                "in_progress": sum(1 for r in task_rows if r[0] == "in-progress"),
            },
        }

    async def get_velocity_history(self, project_id: uuid.UUID) -> list[dict]:
        result = await self.session.execute(
            select(Sprint.id, Sprint.title, Sprint.velocity, Sprint.status, Sprint.start_date, Sprint.end_date)
            .where(Sprint.project_id == project_id, Sprint.org_id == self.org_id, Sprint.status == "closed")
            .order_by(Sprint.end_date)
        )
        return [
            {"id": r[0], "title": r[1], "velocity": r[2], "status": r[3], "start_date": r[4], "end_date": r[5]}
            for r in result.all()
        ]

    async def get_recent_activity(self, project_id: uuid.UUID, limit: int = 10) -> dict:
        stories_r = await self.session.execute(
            select(Story.id, Story.title, Story.status, Story.updated_at)
            .where(Story.project_id == project_id, Story.org_id == self.org_id, Story.deleted_at.is_(None))
            .order_by(Story.updated_at.desc())
            .limit(limit)
        )
        story_rows = stories_r.all()

        agents_r = await self.session.execute(
            select(TeamMember.id).where(
                TeamMember.project_id == project_id, TeamMember.org_id == self.org_id,
                TeamMember.type == "agent", TeamMember.is_active.is_(True),
            )
        )
        agent_ids = [r[0] for r in agents_r.all()]

        agent_runs: list[dict] = []
        if agent_ids:
            runs_r = await self.session.execute(
                text(
                    "SELECT id, agent_id, trigger, status, created_at FROM agent_runs"
                    " WHERE agent_id = ANY(:ids)"
                    " ORDER BY created_at DESC LIMIT :lim"
                ),
                {"ids": agent_ids, "lim": limit},
            )
            agent_runs = [
                {"id": r[0], "agent_id": r[1], "trigger": r[2], "status": r[3], "created_at": r[4]}
                for r in runs_r.all()
            ]

        return {
            "recent_stories": [
                {"id": r[0], "title": r[1], "status": r[2], "updated_at": r[3]} for r in story_rows
            ],
            "recent_memos": [],
            "recent_agent_runs": agent_runs,
        }

    async def get_epic_progress(self, project_id: uuid.UUID, epic_id: uuid.UUID) -> dict:
        result = await self.session.execute(
            select(Story.status, Story.story_points).where(
                Story.project_id == project_id,
                Story.org_id == self.org_id,
                Story.epic_id == epic_id,
                Story.deleted_at.is_(None),
            )
        )
        rows = result.all()
        total = len(rows)
        done = sum(1 for r in rows if r[0] == "done")
        total_pts = sum((r[1] or 0) for r in rows)
        done_pts = sum((r[1] or 0) for r in rows if r[0] == "done")
        return {
            "total_stories": total,
            "done_stories": done,
            "total_points": total_pts,
            "done_points": done_pts,
            "completion_pct": round((done / total) * 100) if total > 0 else 0,
        }

    async def get_epics_progress_lane(self, project_id: uuid.UUID) -> dict[str, dict]:
        """story #2224(S2-1, 갈래 화면) 좌측 레인 — 미르코 실측: `EpicProgress`에 진행/대기/
        막힘/멈춤 네 칸이 없어 레인이 반만 선다. 에픽마다 따로 부르면 N+1이라 «한 번의 호출»로
        project 전체 에픽의 네 칸을 낸다.

        분류 우선순위(겹치는 신호를 하나로 정리하는 순서 — 다른 순서를 쓰면 답이 달라진다):
          ①막힘(blocked)   = 그 story에 매인 pending Gate가 있고 requires_human=true·
                              evidence_status='insufficient'다(§4-5 "문" · 민 실측 32건과
                              같은 자로 맞춤 — PO 확認 요청에 따라 필터를 일치시켰다. 그냥
                              "pending Gate 매임"만 쓰면 민 수와 다른 정의가 같은 화면에
                              두 벌 서는 것이었다).
          ②대기(waiting)   = ①이 아니고 next_action_category=='waiting'(#2262 SSOT 재사용 —
                              verification_pending: self_reported=True·아직 human_verified 안 됨)
          ③진행(in_progress) = ①②가 아니고 status=='in-progress'
          ④멈춤(stalled)   = ①②③이 아니고 status!='done'이고 168시간(민 실측 — §7-③의 "48h"는
                              07-23 시안 값·미재측정, 문서로 남은 값은 168h) 넘게 updated_at 불변
          ⑤그 외(other)    = ①~④ 어디에도 안 잡힘 — ⛔PO 지적(2026-07-30): "합계≠total_stories는
                              의도했어도 화면에서는 거짓말이 된다" — 그래서 이 칸도 명시로 낸다.
                              in_progress+waiting+blocked+stalled+other == total_stories 항상 성립.

        ⛔`other`에 실제로 드는 것 둘(성질이 다름, PO 지적 2026-07-30 — dev 실측 2026-07-30):
          ㉠정상적으로 네 칸 밖(최근 168h 이내 변경된 backlog/ready-for-dev/in-review · done)
            — dev 실측 약 2050/2079건, 압도 다수.
          ㉡pending Gate가 매여 있는데 requires_human=false 또는 evidence_status가
            'insufficient'가 아니라 ①막힘에서 빠진 것 — dev 실측 **1건**
            (requires_human=False·evidence_status=None). 「승인도 자동 통과도 안 되는 결재」
            류와 같은 냄새(#2261 계열)나 n=1이라 이 함수에서 별도 칸을 새로 만들지 않는다
            — 필요해지면(건수가 늘면) 그때 쪼갠다. 지금은 ㉠과 ㉡을 `other` 하나로 합친 채
            이 사실만 기록해 둔다(다음 사람이 "other=잡동사니"로 오인하지 않게).
          참고: ①막힘(narrow) dev 실측 28건 — 민 실측 32건과 4건 차이는 **확認됨**: 이
          함수는 epic_id가 있는 story만 레인에 담는데(에픽 좌측 레인이 목적이므로), 막힌
          32건 중 4건이 epic_id가 없다(dev 실측). 버그 아님 — 이 엔드포인트의 스코프
          자체가 "에픽에 속한 것"이라 그 4건은 애초에 이 화면의 대상이 아니다.

        ⛔이 우선순위·168h 임계 둘 다 «잠정»이다 — #2218(S0-1)이 임계를 실측(8~12건 나오는
        값)해 재확定하기 전까지 쓰는 값. 화면에 "이 수는 잠정"이라는 신호를 실어야 한다면
        이 함수가 아니라 호출부(FE 계약)의 몫이다."""
        stories_r = await self.session.execute(
            select(Story.id, Story.epic_id, Story.status, Story.updated_at).where(
                Story.project_id == project_id,
                Story.org_id == self.org_id,
                Story.deleted_at.is_(None),
                Story.epic_id.is_not(None),
            )
        )
        stories = stories_r.all()
        story_ids = [s.id for s in stories]

        # ⭐PO 판정(2026-07-30, 에픽 없는 막힘 4건 건): "미배정" 레인은 안 만든다(만들면 에픽
        # 안 다는 것이 "괜찮은 일"이 되어 그 줄이 계속 자란다) — 대신 «에픽 없는 story 전량»을
        # 셀 수 있게 로그로 남긴다(㉡류와 같은 방식 — 칸은 안 만들되 0이 아니면 누군가 안다).
        no_epic_count_r = await self.session.execute(
            select(func.count(Story.id)).where(
                Story.project_id == project_id,
                Story.org_id == self.org_id,
                Story.deleted_at.is_(None),
                Story.epic_id.is_(None),
            )
        )
        no_epic_count = no_epic_count_r.scalar_one()
        if no_epic_count:
            logger.info(
                "get_epics_progress_lane: epic 없는 story count=%d project_id=%s "
                "(이 레인 자체에서 영영 안 보임 — story #2224 PO 판정: 미배정 레인을 만들지 "
                "않고 PO가 직접 에픽에 붙인다, 이 로그는 재발 감지용)",
                no_epic_count, project_id,
            )

        from app.services.evidence_service import batch_has_evidence, batch_human_verified

        evidence_ids = await batch_has_evidence(self.session, story_ids, "story")
        verified_map = await batch_human_verified(self.session, story_ids, "story")

        blocked_r = await self.session.execute(
            select(Gate.work_item_id.distinct()).where(
                Gate.org_id == self.org_id,
                Gate.work_item_type == "story",
                Gate.work_item_id.in_(story_ids),
                Gate.status == "pending",
                Gate.requires_human.is_(True),
                Gate.evidence_status == "insufficient",
            )
        )
        blocked_ids = set(blocked_r.scalars().all())

        # ⭐PO 지적(2026-07-30): ㉡류(pending Gate가 매였는데 위 좁힌 조건을 못 채워 blocked
        # 밖으로 빠진 것)가 늘어나는 것을 "누가 아는가"가 남는다 — 칸(응답 필드)을 새로
        # 만들지 않아도 «셀 수는» 있게, 매 호출마다 로그로 남긴다(dev 실측 2026-07-30: 1건).
        gated_not_blocked_r = await self.session.execute(
            select(func.count(Gate.work_item_id.distinct())).where(
                Gate.org_id == self.org_id,
                Gate.work_item_type == "story",
                Gate.work_item_id.in_(story_ids),
                Gate.status == "pending",
                ~((Gate.requires_human.is_(True)) & (Gate.evidence_status == "insufficient")),
            )
        )
        gated_not_blocked_count = gated_not_blocked_r.scalar_one()
        if gated_not_blocked_count:
            logger.info(
                "get_epics_progress_lane: gated-but-not-blocked(㉡) count=%d project_id=%s "
                "(pending Gate 있으나 requires_human/evidence_status 조건 미충족 — other에 섞임, "
                "story #2224 PO 지적 — 늘면 별도 칸 분리 검토)",
                gated_not_blocked_count, project_id,
            )

        from app.services.next_action import next_action_category, verification_next_action

        now = datetime.now(timezone.utc)
        stall_threshold_hours = 168  # 민 실측(문서 기록값) — 48h는 07-23 시안의 미재측정 값

        lanes: dict[str, dict] = {}
        for s in stories:
            epic_key = str(s.epic_id)
            lane = lanes.setdefault(
                epic_key,
                {"in_progress": 0, "waiting": 0, "blocked": 0, "stalled": 0, "other": 0},
            )
            if s.id in blocked_ids:
                lane["blocked"] += 1
                continue
            self_reported = s.id in evidence_ids
            human_verified = True if s.id in verified_map else None
            code = verification_next_action(self_reported=self_reported, human_verified=human_verified)
            if next_action_category(code) == "waiting":
                lane["waiting"] += 1
                continue
            if s.status == "in-progress":
                lane["in_progress"] += 1
                continue
            if s.status != "done":
                age_hours = (now - s.updated_at).total_seconds() / 3600
                if age_hours > stall_threshold_hours:
                    lane["stalled"] += 1
                    continue
            lane["other"] += 1  # done, 또는 backlog/ready-for-dev/in-review 중 최근 변경된 것
        return lanes

    async def get_agent_stats(self, project_id: uuid.UUID, agent_id: uuid.UUID) -> dict:
        member_r = await self.session.execute(
            select(TeamMember.id).where(
                TeamMember.id == agent_id,
                TeamMember.project_id == project_id,
                TeamMember.org_id == self.org_id,
                TeamMember.type == "agent",
            )
        )
        if member_r.scalar_one_or_none() is None:
            return None  # type: ignore[return-value]

        # stories 기반 실제 기여 지표 (is_excluded=true 오염 데이터 제외)
        stories_r = await self.session.execute(
            select(Story.status, Story.story_points, Story.created_at, Story.updated_at)
            .where(
                Story.assignee_id == agent_id,
                Story.org_id == self.org_id,
                Story.deleted_at.is_(None),
                Story.is_excluded.is_(False),
            )
        )
        all_stories = stories_r.all()
        done_stories = [s for s in all_stories if s[0] == "done"]

        done_sp = sum((s[1] or 0) for s in done_stories)

        lead_times_ms: list[int] = []
        for s in done_stories:
            created, updated = s[2], s[3]
            if created and updated:
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                if updated.tzinfo is None:
                    updated = updated.replace(tzinfo=timezone.utc)
                delta_ms = int((updated - created).total_seconds() * 1000)
                if delta_ms > 0:
                    lead_times_ms.append(delta_ms)
        avg_lead_time_ms = round(sum(lead_times_ms) / len(lead_times_ms)) if lead_times_ms else 0

        return {
            "completed": len(done_stories),
            "total_stories": len(all_stories),
            "done_story_points": done_sp,
            "avg_lead_time_ms": avg_lead_time_ms,
            # 스키마 하위 호환 필드
            "total_runs": len(all_stories),
            "failed": 0,
            "total_tokens": 0,
            "total_cost_usd": 0.0,
            "avg_duration_ms": 0,
        }

    async def get_project_health(self, project_id: uuid.UUID) -> dict:
        sprint_r = await self.session.execute(
            select(Sprint.id, Sprint.title, Sprint.start_date, Sprint.end_date, Sprint.duration)
            .where(Sprint.project_id == project_id, Sprint.org_id == self.org_id, Sprint.status == "active")
            .limit(1)
        )
        sprint_row = sprint_r.first()

        open_memo_count = 0

        unassigned_r = await self.session.execute(
            select(func.count()).select_from(Story).where(
                Story.project_id == project_id, Story.org_id == self.org_id,
                Story.assignee_id.is_(None), Story.status != "done", Story.deleted_at.is_(None),
            )
        )
        unassigned_count = unassigned_r.scalar_one()

        sprint_progress = 0
        if sprint_row:
            stories_r = await self.session.execute(
                select(Story.status).where(Story.sprint_id == sprint_row[0], Story.deleted_at.is_(None))
            )
            story_statuses = [r[0] for r in stories_r.all()]
            total = len(story_statuses)
            done = sum(1 for s in story_statuses if s == "done")
            sprint_progress = round((done / total) * 100) if total > 0 else 0

        return {
            "active_sprint": {
                "id": sprint_row[0], "title": sprint_row[1],
                "start_date": sprint_row[2], "end_date": sprint_row[3],
            } if sprint_row else None,
            "sprint_progress": sprint_progress,
            "open_memos": open_memo_count,
            "unassigned_stories": unassigned_count,
            "health": "warning" if open_memo_count > 10 or unassigned_count > 5 else "good",
        }

    async def get_burndown(self, sprint_id: uuid.UUID) -> dict | None:
        # E-SECURITY SEC-S8(story 83ea3d6a) DD(까심 라이브확定, CRITICAL·cross-org): 이 파일의
        # 다른 메소드는 전부 org_id를 필터에 넣는데(예: get_overview) 이 둘만 org_id 필터가
        # 없어 완전 무관 org가 sprint UUID만 알면 velocity/status를 그대로 열람할 수 있었다.
        sprint_r = await self.session.execute(
            select(Sprint).where(Sprint.id == sprint_id, Sprint.org_id == self.org_id)
        )
        sprint = sprint_r.scalar_one_or_none()
        if sprint is None:
            return None

        stories_r = await self.session.execute(
            select(Story.story_points, Story.status, Story.updated_at)
            .where(Story.sprint_id == sprint_id, Story.org_id == self.org_id, Story.deleted_at.is_(None))
        )
        stories = stories_r.all()

        total_pts = sum((r[0] or 0) for r in stories)
        done_pts = sum((r[0] or 0) for r in stories if r[1] == "done")
        remaining = total_pts - done_pts

        # 8a2bbda2: stored duration(default 14·날짜 무관) 대신 날짜에서 산출(dates 단일진실)
        from app.schemas.sprint import compute_sprint_duration
        duration = compute_sprint_duration(sprint.start_date, sprint.end_date, sprint.duration) or 14
        start_date = sprint.start_date

        ideal_line = []
        for day in range(duration + 1):
            if start_date:
                from datetime import timedelta
                day_date = (datetime.combine(start_date, datetime.min.time()) + timedelta(days=day)).strftime("%Y-%m-%d")
            else:
                day_date = str(day)
            ideal_line.append({"date": day_date, "points": round(total_pts * (1 - day / duration)) if duration else 0})

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        start_str = start_date.isoformat() if start_date else today
        actual_line = [
            {"date": start_str, "points": total_pts},
            {"date": today, "points": remaining},
        ]

        return {
            "sprint": {
                "id": sprint.id, "title": sprint.title, "status": sprint.status,
                "start_date": sprint.start_date, "end_date": sprint.end_date,
                "duration": compute_sprint_duration(sprint.start_date, sprint.end_date, sprint.duration),
                "velocity": sprint.velocity,
            },
            "total_points": total_pts,
            "done_points": done_pts,
            "remaining_points": remaining,
            "completion_pct": round((done_pts / total_pts) * 100) if total_pts > 0 else 0,
            "stories_count": len(stories),
            "done_count": sum(1 for r in stories if r[1] == "done"),
            "ideal_line": ideal_line,
            "actual_line": actual_line,
        }

    async def get_sprint_velocity(self, sprint_id: uuid.UUID) -> dict | None:
        # E-SECURITY SEC-S8(story 83ea3d6a) DD: get_burndown과 동형 cross-org 갭.
        result = await self.session.execute(
            select(Sprint.velocity, Sprint.title, Sprint.status).where(
                Sprint.id == sprint_id, Sprint.org_id == self.org_id
            )
        )
        row = result.first()
        if row is None:
            return None
        return {"velocity": row[0], "title": row[1], "status": row[2]}

    async def get_leaderboard(
        self,
        project_id: uuid.UUID,
        period: str = "all",
        limit: int = 50,
        cursor: str | None = None,
    ) -> list[dict]:
        limit = min(limit, 100)

        # S20 전수스캔(산티아고 SME fast-follow, sibling — reward.py:leaderboard와 동형):
        # reward_balances 뷰는 org_id 컬럼이 없어 SQL 필터 불가·caller가 project_id를 caller
        # org 소속인지 사전 검증해야 한다(현재 미라우팅 dead code지만 향후 재배선 landmine 방지).
        if period == "all":
            q = "SELECT member_id, balance FROM reward_balances WHERE project_id = :pid ORDER BY balance DESC"
            params: dict = {"pid": str(project_id), "lim": limit}
            if cursor:
                q += " AND balance < :cursor"
                params["cursor"] = float(cursor)
            q += " LIMIT :lim"
            result = await self.session.execute(text(q), params)
            return [{"member_id": r[0], "balance": float(r[1])} for r in result.all()]

        period_ms = {"daily": 86400, "weekly": 7 * 86400, "monthly": 30 * 86400}
        seconds = period_ms.get(period, 86400)
        params2: dict = {"pid": str(project_id), "org_id": str(self.org_id), "seconds": seconds}
        q2 = (
            "SELECT member_id, SUM(amount) AS balance FROM reward_ledger"
            " WHERE project_id = :pid AND org_id = :org_id"
            " AND created_at >= NOW() - (:seconds || ' seconds')::interval"
            " GROUP BY member_id ORDER BY balance DESC LIMIT :lim"
        )
        params2["lim"] = limit
        result2 = await self.session.execute(text(q2), params2)
        return [{"member_id": r[0], "balance": float(r[1])} for r in result2.all()]
