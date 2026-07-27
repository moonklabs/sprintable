"""E-DECISION-GATE S12 Gap2: stuck handoff fallback human notification.

stuck(timed_out) agent handoff 을 휴먼이 개입하도록 fallback 통지한다. 기존 ``dispatch_notification``
재사용·human owner(= project active human member)에게 발송.

⭐idempotent(run당 1회): step_run 단위 advisory lock + ``fallback_notified`` step_run_event marker
로 동시/재호출 시 ``already_notified``(check-then-insert TOCTOU 회피·[[feedback_check_then_insert_toctou]]).
⭐status 안 되돌림 — step_run/story status 미변경(통지 audit marker 만).
"""
import uuid

import sqlalchemy as sa
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import OrgMember
from app.models.project_access import ProjectAccess
from app.models.team import TeamMember
from app.models.workflow_line import WorkflowLineStepRun, WorkflowLineStepRunEvent

_FALLBACK_EVENT = "fallback_notified"


async def fallback_notify(
    session: AsyncSession, org_id: uuid.UUID, story_id: uuid.UUID, step_run_id: uuid.UUID,
) -> dict:
    """stuck handoff 의 fallback human 통지(idempotent·status rollback 0). 반환 status: notified|
    already_notified|not_found."""
    sr = (await session.execute(
        select(WorkflowLineStepRun).where(
            WorkflowLineStepRun.id == step_run_id,
            WorkflowLineStepRun.org_id == org_id,
            WorkflowLineStepRun.entity_type == "story",
            WorkflowLineStepRun.entity_id == story_id,
        )
    )).scalar_one_or_none()
    if sr is None:
        return {"status": "not_found", "notified": False}

    # ⭐step_run 단위 advisory lock(tx-scoped) — 동시 호출 직렬화로 중복 통지 0(TOCTOU 회피).
    await session.execute(
        sa.text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
        {"k": f"wf_fallback_notify:{step_run_id}"},
    )
    existing = (await session.execute(
        select(WorkflowLineStepRunEvent.id).where(
            WorkflowLineStepRunEvent.step_run_id == step_run_id,
            WorkflowLineStepRunEvent.event_type == _FALLBACK_EVENT,
        ).limit(1)
    )).scalar_one_or_none()
    if existing is not None:
        return {"status": "already_notified", "notified": False}

    # human owner = project active human member(들). Story/Project 에 owner 컬럼이 없어 휴먼 멤버로 해소.
    tm_targets = (await session.execute(
        select(TeamMember.id).where(
            TeamMember.org_id == org_id,
            TeamMember.project_id == sr.project_id,
            TeamMember.type == "human",
            TeamMember.is_active.is_(True),
        )
    )).scalars().all()
    target_ids = set(tm_targets)
    # #2216(전달누락 계열): team_members뷰(members ⋈ project_access INNER JOIN) 단독으론
    # grant-only 휴먼(project_access를 org_member_id 경유로만 가진 멤버)과 owner-floor org
    # owner/admin(명시 project_access grant 없이 has_project_access의 admin_branch org-wide
    # floor로만 이 프로젝트에 접근하는 멤버)이 조용히 빠졌다 — stuck handoff가 발생해도 fallback
    # human 통지가 아예 안 갔다. has_project_access(project_auth.py)의 human_grant/org
    # owner-admin-floor 두 분기를 동일 기준으로 재현해 OrgMember.id로 보강한다 —
    # dispatch_notification은 이미 org_member.id 축 grant-only 해소를 지원한다
    # (E-MEMBER-SSOT AC2-2, notification_dispatch.py 기존 주석).
    grant_only_result = await session.execute(
        select(OrgMember.id)
        .select_from(ProjectAccess)
        .join(OrgMember, ProjectAccess.org_member_id == OrgMember.id)
        .where(
            ProjectAccess.project_id == sr.project_id,
            ProjectAccess.permission == "granted",
            OrgMember.deleted_at.is_(None),
        )
    )
    target_ids |= {row[0] for row in grant_only_result.all()}
    owner_floor_result = await session.execute(
        select(OrgMember.id).where(
            OrgMember.org_id == org_id,
            OrgMember.role.in_(["owner", "admin"]),
            OrgMember.deleted_at.is_(None),
        )
    )
    target_ids |= {row[0] for row in owner_floor_result.all()}
    targets = list(target_ids)

    if targets:
        from app.services.notification_dispatch import dispatch_notification
        await dispatch_notification(
            session, org_id=org_id, event_type="handoff_fallback",
            target_member_ids=list(targets),
            title="Stuck handoff — fallback to human",
            body=f"{sr.entity_type} {story_id} agent handoff stalled — human intervention requested",
            reference_type="story", reference_id=story_id,
            # story #1953: sr.project_id NOT NULL — 신규 조회 없이 그대로 실음.
            source_project_id=sr.project_id,
        )

    # idempotent marker(통지 0명이어도 기록 — 재통지 방지). ⭐status 변경 없음(rollback 0).
    session.add(WorkflowLineStepRunEvent(
        org_id=org_id, project_id=sr.project_id, step_run_id=step_run_id,
        event_type=_FALLBACK_EVENT, payload={"target_count": len(targets)},
        correlation_id=sr.correlation_id,
    ))
    await session.flush()
    await session.commit()
    return {"status": "notified", "notified": True, "target_count": len(targets)}
