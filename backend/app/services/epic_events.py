"""E-GLANCE wedge #2(story 96b19bc3) — epic.* 이벤트 발화(app/services/story_status_events.py
축소판).

Story의 5-effect(publish_event·fire_webhooks·process_event·dispatch_notification·
StoryActivity) 전부를 복제하지 않는다 — 근거(BE design doc §2.2): 이 이벤트의 1차 소비자는
오르테가(웹훅)이지 특정 assignee 알림이 아니다. v1 스코프 = 3-effect:
publish_event(항상)·fire_webhooks(오르테가 구독 채널)·dispatch_notification(assignee 있을
때만, 선택적). process_event(workflow_pipeline 에이전트 라우팅 룰 트리거)는 로드맵 이벤트가
자동으로 에이전트 워크플로 룰을 발화해야 할 근거가 아직 없어 v1 제외(§2.2)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any


def _base_event_data(
    epic_id: uuid.UUID, epic_title: str, project_id: uuid.UUID, org_id: uuid.UUID,
    actor_id: uuid.UUID | None,
) -> dict[str, Any]:
    return {
        "epic_id": str(epic_id),
        "epic_title": epic_title,
        "project_id": str(project_id),
        "org_id": str(org_id),
        "actor_id": str(actor_id) if actor_id else None,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def _emit(
    db, org_id: uuid.UUID, event_type: str, event_data: dict[str, Any],
    *, notify_member_id: uuid.UUID | None,
) -> None:
    """publish_event(항상)+fire_webhooks(assignee 있으면 관련자 게이팅, 없으면 무-게이팅=org
    전체 구독 웹훅 도달)+dispatch_notification(assignee 있을 때만). 각 effect는
    best-effort(실패 격리).

    까심 QA(#2076 REQUEST_CHANGES) 재현 fix: fire_webhooks(recipient_member_ids=)는
    **빈 집합도 "게이팅 활성"으로 취급**해 member-bound 웹훅을 전부 drop한다
    (WebhookConfig.member_id가 nullable=False라 broadcast(member_id=null) 개념 자체가
    없음 — preserve_broadcast로 구제될 여지도 없음). notify_member_id가 None(assignee
    없음 — epic.reordered/removed는 항상 이 케이스)이면 반드시 recipient_member_ids=None
    (게이팅 미적용)으로 넘겨야 오르테가 같은 org-wide 구독 웹훅이 실제로 수신한다.
    `{notify_member_id} if notify_member_id else set()`(빈 집합)이 이 버그의 근본이었다."""
    from app.routers.events import publish_event
    from app.services.notification_dispatch import dispatch_notification
    from app.services.webhook_dispatch import fire_webhooks

    notify_ids: set[uuid.UUID] | None = {notify_member_id} if notify_member_id else None

    publish_event(str(org_id), event_type, event_data)
    try:
        await fire_webhooks(db, org_id, event_type, event_data, recipient_member_ids=notify_ids)
    except Exception:
        pass

    if notify_ids:
        try:
            await dispatch_notification(
                db,
                org_id=org_id,
                event_type=event_type.replace(".", "_"),
                target_member_ids=list(notify_ids),
                title=f"에픽 {event_type.split('.')[-1]}: {event_data.get('epic_title')}",
                body=None,
                reference_type="epic",
                reference_id=uuid.UUID(event_data["epic_id"]),
                source_project_id=uuid.UUID(event_data["project_id"]),
            )
        except Exception:
            pass


async def emit_epic_created(db, org_id: uuid.UUID, epic, *, actor_id: uuid.UUID | None = None) -> None:
    event_data = _base_event_data(epic.id, epic.title, epic.project_id, org_id, actor_id)
    await _emit(db, org_id, "epic.created", event_data, notify_member_id=epic.assignee_id)


async def emit_epic_status_changed(
    db, org_id: uuid.UUID, epic, old_status: str | None, *, actor_id: uuid.UUID | None = None,
) -> None:
    """old==new면 no-op(emit_story_status_changed와 동형 규율)."""
    if old_status == epic.status:
        return
    event_data = _base_event_data(epic.id, epic.title, epic.project_id, org_id, actor_id)
    event_data["old_status"] = old_status
    event_data["status"] = epic.status
    await _emit(db, org_id, "epic.status_changed", event_data, notify_member_id=epic.assignee_id)


async def emit_epic_removed(
    db, org_id: uuid.UUID, epic_id: uuid.UUID, epic_title: str, project_id: uuid.UUID,
    *, actor_id: uuid.UUID | None = None,
) -> None:
    """호출자가 삭제 직전에 epic_title/project_id를 캡처해 넘긴다(삭제 後엔 조회 불가)."""
    event_data = _base_event_data(epic_id, epic_title, project_id, org_id, actor_id)
    await _emit(db, org_id, "epic.removed", event_data, notify_member_id=None)


async def emit_epic_reordered(
    db, org_id: uuid.UUID, items: list[dict[str, Any]], *, actor_id: uuid.UUID | None = None,
) -> None:
    """배치당 1회 발화(N개 재정렬에 N번 웹훅 방지) — payload에 items 배열 통째로.

    items: [{"id": uuid, "title": str, "project_id": uuid, "position": int,
             "old_position": int | None}, ...] — 실제 변경 적용된 epic만(호출자가 필터).
    project_id는 items의 첫 항목 기준(bulk는 단일-project 호출이 일반적이나 cross-project
    silent-skip 후 남은 items가 여러 project에 걸칠 수 있어 대표값일 뿐 — FE는 items로 소비).
    """
    if not items:
        return
    representative = items[0]
    event_data = _base_event_data(
        representative["id"], representative["title"], representative["project_id"], org_id, actor_id,
    )
    event_data["position"] = str(representative["position"])
    event_data["old_position"] = str(representative.get("old_position")) if representative.get("old_position") is not None else None
    event_data["items"] = [
        {
            "id": str(it["id"]), "title": it["title"], "project_id": str(it["project_id"]),
            "position": it["position"], "old_position": it.get("old_position"),
        }
        for it in items
    ]
    await _emit(db, org_id, "epic.reordered", event_data, notify_member_id=None)
