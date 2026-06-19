"""E-DECISION-GATE S14: deputy / availability / SoD role resolver.

``workflow_role_assignments`` 에서 role_key → member 후보를 해소한다:
- ① active / effective-period / availability 필터.
- ② availability='ooo'(불가) & deputy_allowed → deputy 대체 + original_approver_member_id 보존.
- ③ inactive/terminated member 제외(TeamMember.is_active).
- ④ human-gate 는 prefer=human(agent approver 불허).
- ⑤ ⭐SoD: requested_by/current assignee/implementation actor 와 동일 approver 는 self-approval
  forbidden → 다음 후보로 fallback(없으면 unresolved → escalate).
- ⑥ 후보 없으면 None → 호출부가 unresolved_assignee + board badge(silent prison 아님).

OOO/inactive approver 가 pending prison 을 만들지 않게 한다.
"""
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.team import TeamMember
from app.models.workflow_line import WorkflowLineStepRun, WorkflowRoleAssignment

# availability 가 후보 불가(=deputy 필요) 인 상태.
_UNAVAILABLE = frozenset({"ooo", "unavailable"})


@dataclass
class ResolvedCandidate:
    member_id: uuid.UUID
    member_type: str
    original_approver_member_id: uuid.UUID | None  # deputy 대체 시 원 approver 보존(②)
    via_deputy: bool
    role_assignment_id: uuid.UUID


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def _member_active(session: AsyncSession, member_id: uuid.UUID) -> bool:
    """③ inactive/terminated 제외 — TeamMember.is_active."""
    m = await session.get(TeamMember, member_id)
    return m is not None and bool(m.is_active)


def _deputy_allowed(assignment: WorkflowRoleAssignment) -> bool:
    pol = assignment.delegation_policy
    return bool(pol.get("deputy_allowed")) if isinstance(pol, dict) else False


async def resolve_role_candidate(
    session: AsyncSession, org_id: uuid.UUID, role_key: str, *,
    project_id: uuid.UUID | None = None, prefer_human: bool = True,
    sod_exclude: set[uuid.UUID] | None = None, now: datetime | None = None,
) -> ResolvedCandidate | None:
    """role_key 의 유효 후보 1명을 priority 순으로 해소(없으면 None)."""
    now = now or _now()
    sod_norm = {str(x) for x in (sod_exclude or set()) if x is not None}

    rows = (await session.execute(
        select(WorkflowRoleAssignment).where(
            WorkflowRoleAssignment.org_id == org_id,
            WorkflowRoleAssignment.role_key == role_key,
            WorkflowRoleAssignment.is_active.is_(True),
        )
    )).scalars().all()

    # project 우선(요청 project 매칭 0 → org-level NULL 1 → 타 project 2=제외), 그 다음 priority.
    def _proj_rank(a: WorkflowRoleAssignment) -> int:
        if project_id is not None and a.project_id == project_id:
            return 0
        if a.project_id is None:
            return 1
        return 2

    for a in sorted(rows, key=lambda a: (_proj_rank(a), a.priority)):
        if _proj_rank(a) == 2:
            continue  # 다른 project scope → 후보 아님
        # ① effective period
        if a.effective_from is not None and now < a.effective_from:
            continue
        if a.effective_to is not None and now > a.effective_to:
            continue

        # availability + deputy 대체(②)
        eff_member, eff_type, original, via_deputy = a.member_id, a.member_type, None, False
        if a.availability_status in _UNAVAILABLE:
            if _deputy_allowed(a) and a.deputy_member_id is not None:
                eff_member = a.deputy_member_id
                eff_type = a.deputy_member_type or "human"
                original = a.member_id  # 원 approver 보존
                via_deputy = True
            else:
                continue  # OOO·deputy 불가 → 후보 아님

        # ④ human-gate prefer=human → agent approver 불허
        if prefer_human and eff_type == "agent":
            continue
        # ③ inactive/terminated 제외
        if not await _member_active(session, eff_member):
            continue
        # ⑤ SoD: self-approval forbidden → 다음 후보로 fallback
        if str(eff_member) in sod_norm:
            continue

        return ResolvedCandidate(eff_member, eff_type, original, via_deputy, a.id)

    return None  # ⑥ 후보 없음


async def resolve_or_mark_unresolved(
    session: AsyncSession, step_run: WorkflowLineStepRun, role_key: str, *,
    prefer_human: bool = True, sod_exclude: set[uuid.UUID] | None = None,
    now: datetime | None = None,
) -> ResolvedCandidate | None:
    """resolve_role_candidate + 후보 없으면 step_run 을 unresolved_assignee 로 가시화(⑥·silent prison X).

    후보 해소 시 step_run.resolved_member_id/type 세팅(deputy 면 escalated_to_member_id 에 원 approver
    보존하지 않고 resolved 에 effective member 기록). 반환: 후보 또는 None.
    """
    cand = await resolve_role_candidate(
        session, step_run.org_id, role_key, project_id=step_run.project_id,
        prefer_human=prefer_human, sod_exclude=sod_exclude, now=now,
    )
    if cand is None:
        step_run.delivery_status = "unresolved_assignee"  # board badge 소스(silent prison 아님)
        await session.flush()
        return None
    step_run.resolved_member_id = cand.member_id
    step_run.resolved_member_type = cand.member_type
    await session.flush()
    return cand
