"""스토리 status_changed side-effects 공유 발화 (41a6e294).

정상 board PATCH 경로와 gate-driven done(merge approve)이 **동일 side-effects**를 내도록 단일 helper로
추출 — events(publish→eventbus 소비=L1 `activity_events` 캡처)·webhook·L2 trigger·notification·
StoryActivity. gate-driven done이 status만 직접 set해 활동그래프에 누락되던 자기모순(게이트가 만든
done이 게이트 증거에 안 잡힘)을 닫고, 정상 경로와 parity(드리프트 0)를 보장한다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def _epic_title(db: AsyncSession, epic_id: uuid.UUID | None) -> str | None:
    if not epic_id:
        return None
    from app.models.pm import Epic

    result = await db.execute(select(Epic).where(Epic.id == epic_id).limit(1))
    epic = result.scalar_one_or_none()
    return epic.title if epic else None


async def emit_story_status_changed(
    db: AsyncSession,
    org_id: uuid.UUID,
    story,
    old_status: str | None,
    *,
    actor_id: uuid.UUID | None = None,
    actor_name: str | None = None,
    actor_role: str | None = None,
    actor_type: str | None = None,
) -> None:
    """story status_changed의 side-effects 5종을 발화. old==new면 no-op.

    호출자가 story.status를 이미 새 값으로 설정한 뒤 호출한다. 각 side-effect는 best-effort(실패
    격리)로 status 전이 자체를 깨지 않는다. publish_event는 eventbus→L1 activity_events 캡처의
    진입점이므로 gate-driven done도 이걸 타야 활동그래프(=verdict 증거원)에 잡힌다.
    """
    if old_status == story.status:
        return
    # lazy import — service→router/pipeline 순환 회피.
    from app.models.pm import StoryActivity
    from app.routers.events import publish_event
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
        "status": story.status,
        "new_status": story.status,
        "old_status": old_status,
        "project_id": str(story.project_id),
        "org_id": str(org_id),
        "actor_id": str(actor_id) if actor_id else None,
        "actor_name": actor_name,
        "actor_role": actor_role,
        "source_agent_id": str(actor_id) if (actor_id and actor_type == "agent") else None,
        "assignees": [str(story.assignee_id)] if story.assignee_id else [],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    publish_event(str(org_id), "story.status_changed", event_data)
    try:
        await fire_webhooks(db, org_id, "story.status_changed", event_data)
    except Exception:
        pass
    try:
        await process_event(
            db,
            org_id,
            story.project_id,
            EventContext(
                event_type="story.status_changed",
                trigger_type_slug="status_changed",
                actor_id=str(actor_id) if actor_id else None,
                metadata=event_data,
            ),
        )
    except Exception:
        pass

    notify_ids: set[uuid.UUID] = set()
    if story.assignee_id:
        notify_ids.add(story.assignee_id)
    if actor_id and actor_id != story.assignee_id:
        notify_ids.add(actor_id)
    if notify_ids:
        # notif도 best-effort 격리 — gate 경로는 flush後 commit前 emit이라 notif 실패가 story done을
        # 롤백할 수 있다. 나머지 4 side-effect와 동일하게 isolation.
        try:
            await dispatch_notification(
                db,
                org_id=org_id,
                event_type="story_status_changed",
                target_member_ids=list(notify_ids),
                title=f"스토리 상태 변경: {story.title} → {story.status}",
                body=None,
                reference_type="story",
                reference_id=story.id,
                # S2: 멀티프로젝트 에이전트 assignee를 스토리 프로젝트로 정확 라우팅
                source_project_id=story.project_id,
            )
        except Exception:
            pass

    if actor_id:
        try:
            db.add(
                StoryActivity(
                    story_id=story.id,
                    org_id=org_id,
                    project_id=story.project_id,
                    activity_type="status_changed",
                    old_value=old_status,
                    new_value=story.status,
                    created_by=(await canonicalize_member_id(actor_id, db)),
                )
            )
            await db.flush()
        except Exception:
            pass
