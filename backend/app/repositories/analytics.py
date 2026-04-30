from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.memo import Memo
from app.models.pm import Epic, Sprint, Story, Task
from app.models.team import TeamMember


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
            select(func.count()).select_from(Epic).where(Epic.project_id == project_id, Epic.org_id == self.org_id)
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

        memos_r = await self.session.execute(
            select(Memo.status).where(
                Memo.project_id == project_id, Memo.org_id == self.org_id, Memo.deleted_at.is_(None)
            )
        )
        memo_rows = memos_r.all()

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
            "memos": {
                "total": len(memo_rows),
                "open": sum(1 for r in memo_rows if r[0] == "open"),
            },
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

        memos_r = await self.session.execute(
            select(Memo.id, Memo.title, Memo.status, Memo.created_at)
            .where(Memo.project_id == project_id, Memo.org_id == self.org_id, Memo.deleted_at.is_(None))
            .order_by(Memo.created_at.desc())
            .limit(limit)
        )
        memo_rows = memos_r.all()

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
            "recent_memos": [
                {"id": r[0], "title": r[1], "status": r[2], "created_at": r[3]} for r in memo_rows
            ],
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

        runs_r = await self.session.execute(
            text(
                "SELECT status, input_tokens, output_tokens, cost_usd, duration_ms"
                " FROM agent_runs WHERE agent_id = :agent_id"
                " ORDER BY created_at DESC LIMIT 1000"
            ),
            {"agent_id": str(agent_id)},
        )
        rows = runs_r.all()
        completed = [r for r in rows if r[0] == "completed"]
        total_tokens = sum((r[1] or 0) + (r[2] or 0) for r in completed)
        total_cost = sum((r[3] or 0) for r in completed)
        avg_dur = round(sum((r[4] or 0) for r in completed) / len(completed)) if completed else 0
        return {
            "total_runs": len(rows),
            "completed": len(completed),
            "failed": sum(1 for r in rows if r[0] == "failed"),
            "total_tokens": total_tokens,
            "total_cost_usd": total_cost,
            "avg_duration_ms": avg_dur,
        }

    async def get_project_health(self, project_id: uuid.UUID) -> dict:
        sprint_r = await self.session.execute(
            select(Sprint.id, Sprint.title, Sprint.start_date, Sprint.end_date, Sprint.duration)
            .where(Sprint.project_id == project_id, Sprint.org_id == self.org_id, Sprint.status == "active")
            .limit(1)
        )
        sprint_row = sprint_r.first()

        open_memos_r = await self.session.execute(
            select(func.count()).select_from(Memo).where(
                Memo.project_id == project_id, Memo.org_id == self.org_id,
                Memo.status == "open", Memo.deleted_at.is_(None),
            )
        )
        open_memo_count = open_memos_r.scalar_one()

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
        sprint_r = await self.session.execute(
            select(Sprint).where(Sprint.id == sprint_id)
        )
        sprint = sprint_r.scalar_one_or_none()
        if sprint is None:
            return None

        stories_r = await self.session.execute(
            select(Story.story_points, Story.status, Story.updated_at)
            .where(Story.sprint_id == sprint_id, Story.deleted_at.is_(None))
        )
        stories = stories_r.all()

        total_pts = sum((r[0] or 0) for r in stories)
        done_pts = sum((r[0] or 0) for r in stories if r[1] == "done")
        remaining = total_pts - done_pts

        duration = sprint.duration or 14
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
                "duration": sprint.duration, "velocity": sprint.velocity,
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
        result = await self.session.execute(
            select(Sprint.velocity, Sprint.title, Sprint.status).where(Sprint.id == sprint_id)
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
        params2: dict = {"pid": str(project_id), "seconds": seconds}
        q2 = (
            "SELECT member_id, SUM(amount) AS balance FROM reward_ledger"
            " WHERE project_id = :pid AND created_at >= NOW() - (:seconds || ' seconds')::interval"
            " GROUP BY member_id ORDER BY balance DESC LIMIT :lim"
        )
        params2["lim"] = limit
        result2 = await self.session.execute(text(q2), params2)
        return [{"member_id": r[0], "balance": float(r[1])} for r in result2.all()]
