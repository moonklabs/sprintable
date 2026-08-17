"""스토리 assignee_changed side-effects 공유 발화 (story #2172, 2026-07-24).

근본(AC1): 이 side-effects는 원래 PATCH /{id}(update_story) 안에만 인라인으로 있었다 — bulk가
assignee_id를 실제로 바꿔도 이 발화 자체가 호출되지 않아 단건/bulk이 서로 다른 계약을 갖고
있었다(#2131이 status_changed에서 고친 것과 동일 근본). story_status_events.py의
emit_story_status_changed와 동형으로 단일 helper로 추출해, PATCH /{id}와 PATCH /bulk이 **같은
발행 지점**을 공유한다 — 두 벌로 갈라놓지 않는다.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.pm import StoryActivity
from app.models.team import TeamMember

logger = logging.getLogger(__name__)


async def _epic_title(db: AsyncSession, epic_id: uuid.UUID | None) -> str | None:
    if not epic_id:
        return None
    from app.models.pm import Goal

    result = await db.execute(select(Goal).where(Goal.id == epic_id).limit(1))
    epic = result.scalar_one_or_none()
    return epic.title if epic else None


async def emit_story_assignee_changed(
    db: AsyncSession,
    org_id: uuid.UUID,
    story,
    old_assignee_id: uuid.UUID | None,
    *,
    background_tasks: BackgroundTasks,
    actor_id: uuid.UUID | None = None,
    actor_name: str | None = None,
    actor_role: str | None = None,
    actor_type: str | None = None,
) -> None:
    """story assignee_changed의 side-effects를 발화. old==new면 no-op.

    호출자가 story.assignee_id를 이미 새 값으로 설정한 뒤 호출한다. 각 side-effect는
    best-effort(실패 격리)로 assignee 전이 자체를 깨지 않는다. `background_tasks`는 필수 —
    agent 배정 시 CC 릴레이(`deliver_injected_event_webhook`)를 fire-and-forget으로 큐잉하는 데
    쓰인다(PATCH /{id}는 라우트 의존성으로, PATCH /bulk는 이 story #2172에서 새로 받는다).
    """
    if old_assignee_id == story.assignee_id:
        return
    # lazy import — service→router/pipeline 순환 회피(story_status_events.py와 동형).
    from app.services.activity_stream import extract_activities_best_effort
    from app.services.conversation_webhook import deliver_injected_event_webhook
    from app.services.event_seq import assign_recipient_seq
    from app.services.member_resolver import canonicalize_member_id
    from app.services.notification_dispatch import dispatch_notification
    from app.services.rule_evaluator import EventContext
    from app.services.webhook_dispatch import fire_webhooks
    from app.services.workflow_pipeline import process_event

    epic_title: str | None = None
    try:
        epic_title = await _epic_title(db, story.epic_id)
    except Exception:
        pass

    event_data = {
        "story_id": str(story.id),
        "story_title": story.title,
        "story_priority": story.priority,
        "epic_id": str(story.epic_id) if story.epic_id else None,
        "epic_title": epic_title,
        "assignee_id": str(story.assignee_id) if story.assignee_id else None,
        "old_assignee_id": str(old_assignee_id) if old_assignee_id else None,
        "project_id": str(story.project_id),
        "org_id": str(org_id),
        "actor_id": str(actor_id) if actor_id else None,
        "actor_name": actor_name,
        "actor_role": actor_role,
        "source_agent_id": str(actor_id) if (actor_id and actor_type == "agent") else None,
        "assignees": [str(story.assignee_id)] if story.assignee_id else [],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    # AC1(c60dd33c 미러): assignee_changed webhook은 관련자만 — 담당자(신/구)+행위자. member-bound
    # webhook이 무관 에이전트에 fan-out되던 갭 차단. member_id=null 브로드캐스트는 보존(preserve_broadcast).
    notify_ids = {m for m in (story.assignee_id, old_assignee_id, actor_id) if m is not None}

    # story #2086(2026-07-21, 까심군 라이브 실측 확定) + #2132(2026-07-23 근본수정): 구
    # publish_event()의 org _subscribers fanout은 영구 죽은 레지스트리였다(이제 삭제됨) —
    # project 인가 필터를 낀 _push_to_agent 개별 push만이 실제로 SSE 큐에 들어가는 유일 경로.
    #
    # story #2106(2026-07-22, 까심군 #2101 QA 후속): 이 push는 의도적으로 Event row를 안
    # 만드는 순수 transient SSE(#2101의 last_event_id 백필 대상이 아님) — assignee_changed는
    # "지금 담당자가 누구인지" 실시간 동기화 신호일 뿐이고 값 자체는 항상 story.assignee_id가
    # SSOT라 재조회하면 복원된다. "너에게 배정됐다"는 실제 알림 책임은 아래 story_assigned
    # Event(agent)/dispatch_notification(human)이 별도로 진다(상태축과 알림축 분리).
    try:
        from app.routers.events import _push_to_agent
        from app.services.project_auth import project_accessible_member_ids

        member_ids = await project_accessible_member_ids(db, org_id, story.project_id)
        sse_payload = {"event_type": "story.assignee_changed", **event_data}
        for member_id in member_ids:
            _push_to_agent(str(member_id), dict(sse_payload))
    except Exception:
        logger.warning(
            "assignee_changed SSE 포워딩 실패(story=%s project=%s)",
            story.id, story.project_id, exc_info=True,
        )
    try:
        await fire_webhooks(
            db, org_id, "story.assignee_changed", event_data,
            recipient_member_ids=notify_ids,
        )
    except Exception:
        pass
    try:
        await process_event(db, org_id, story.project_id, EventContext(
            event_type="story.assignee_changed",
            trigger_type_slug="assignee_changed",
            actor_id=str(actor_id) if actor_id else None,
            metadata=event_data,
        ))
    except Exception:
        pass

    # E-EVENTBUS P3 S9 / E-EVENT-INJECT S3: story_assigned 알림 + agent assignment-wake
    if story.assignee_id and story.assignee_id != old_assignee_id:
        assignee_type = (await db.execute(
            select(TeamMember.type).where(TeamMember.id == story.assignee_id).limit(1)
        )).scalar_one_or_none()

        if assignee_type == "agent":
            # E-EVENT-INJECT S3: agent에 배정만 해도 work-turn 시작.
            # dispatch.py 미러 — content 실린 story_assigned Event + seq + commit BEFORE wake.
            _detail = (story.description or "").strip()
            _content = f"[story] {story.title}" + (f" — {_detail[:200]}" if _detail else "")
            sa_event = Event(
                project_id=story.project_id,
                org_id=org_id,
                event_type="story_assigned",  # EventType enum 미존재 → literal (connector allow-list 포함)
                source_entity_type="story",
                source_entity_id=story.id,
                sender_id=actor_id,
                recipient_id=story.assignee_id,
                recipient_type="agent",
                payload={
                    "story_id": str(story.id),
                    "story_title": story.title,
                    "content": _content,
                    "event_type": "story_assigned",
                },
                status="pending",
            )
            db.add(sa_event)
            await db.flush()
            await assign_recipient_seq(db, sa_event)  # per-recipient dense seq
            # L1 BE-3: story assignment → activity_events 1행(best-effort·commit 前·순서 불변).
            await extract_activities_best_effort(db, [sa_event.id])
            await db.commit()  # commit BEFORE wake — seq 확정, 이중전달 방지
            if sa_event.recipient_seq is not None:
                from app.routers.agent_gateway import wake_agent
                wake_agent(str(story.assignee_id), sa_event.recipient_seq)
            # 1f01c1ad: wake_agent(SSE)는 CC 세션 미도달 → member webhook(CC 릴레이)으로도 주입.
            background_tasks.add_task(
                deliver_injected_event_webhook,
                org_id=org_id,
                recipient_id=story.assignee_id,
                content=_content,
                event_type="story_assigned",
                source_entity_type="story",
                source_entity_id=story.id,
            )
        else:
            # human: 기존 dispatch_notification 유지
            await dispatch_notification(
                db,
                org_id=org_id,
                event_type="story_assigned",
                target_member_ids=[story.assignee_id],
                title=f"스토리 담당자로 지정됨: {story.title}",
                body=None,
                reference_type="story",
                reference_id=story.id,
                source_project_id=story.project_id,
                # story #2696: outbox 이관(동일 결함 클래스 예방).
                via_outbox=True,
            )
    if actor_id:
        try:
            db.add(StoryActivity(
                story_id=story.id,
                org_id=org_id,
                project_id=story.project_id,
                activity_type="assignee_changed",
                old_value=str(old_assignee_id) if old_assignee_id else None,
                new_value=str(story.assignee_id) if story.assignee_id else None,
                created_by=(await canonicalize_member_id(actor_id, db)),  # AC3-2d(1b) canonical
            ))
            await db.flush()
        except Exception:
            pass
